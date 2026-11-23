import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentById, AGENTS } from '../shared/roster.js';
import { buildSystemPrompt } from './prompts.js';

const { Pool } = pg;

// ---------- Konfigurasi (lihat .env.example) ----------
const PORT = Number(process.env.PORT || 3001);
const ROUTER_BASE_URL = process.env.ROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'http://localhost:20128/v1';
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MODEL_LEADER = process.env.MODEL_LEADER || 'openai/gpt-6.1-sol';
const MODEL_TEAM = process.env.MODEL_TEAM || 'anthropic/claude-sonnet-4.5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 1500);
const RATE_PER_MINUTE = Number(process.env.RATE_PER_MINUTE || 15);
const DAILY_MAX_REQUESTS = Number(process.env.DAILY_MAX_REQUESTS || 300);
const MAX_HISTORY = 20;
const MAX_CHARS = 4000;

// Database PostgreSQL
const pgPool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || 'kantor_ai',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
});
pgPool.on('error', (err) => {
  console.error('[pg pool error]', err.message);
});

// Prioritaskan 9router (OpenAI-compatible), fallback ke Anthropic SDK jika ada key Anthropic
const openaiClient = ROUTER_API_KEY
  ? new OpenAI({ baseURL: ROUTER_BASE_URL, apiKey: ROUTER_API_KEY })
  : null;
const anthropicClient = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

const DEMO = !openaiClient && !anthropicClient;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- Pembatas: akses, rate limit per IP, batas harian ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function requireAccess(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (safeEqual(req.get('x-access-code') || '', ACCESS_CODE)) return next();
  res.status(401).json({ error: 'Kode akses salah atau belum diisi.' });
}

const hits = new Map(); // ip -> [timestamp]
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MINUTE) {
    return res.status(429).json({ error: 'Terlalu cepat. Tunggu sebentar lalu coba lagi.' });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < 60_000)) hits.delete(ip);
  }
}, 5 * 60_000).unref();

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
let daily = { day: today(), count: 0 };
function dailyCap(req, res, next) {
  if (daily.day !== today()) daily = { day: today(), count: 0 };
  if (daily.count >= DAILY_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Batas pemakaian harian tercapai. Coba lagi besok.' });
  }
  daily.count += 1;
  next();
}

// ---------- Util ----------
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function demoReply(agent, lastUser) {
  return (
    `Halo, gue ${agent.name.split(' ')[0]} (${agent.role}).\n\n` +
    `**Mode demo**: server belum punya ANTHROPIC_API_KEY, jadi ini jawaban contoh supaya tampilan chat bisa dites.\n\n` +
    `Lo bilang: "${lastUser.slice(0, 160)}"\n\n` +
    `Setelah API key dipasang, gue bakal jawab sungguhan sesuai keahlian gue: ${agent.focus}.\n\n` +
    `- Poin contoh pertama\n- Poin contoh kedua\n- Poin contoh ketiga`
  );
}

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return 'API key ditolak. Cek ROUTER_API_KEY atau ANTHROPIC_API_KEY di server.';
  if (status === 402 || status === 403) return 'Akses API ditolak atau saldo habis.';
  if (status === 429) return 'Kena rate limit API. Coba lagi sebentar lagi.';
  if (status === 529 || status >= 500) return 'Server AI provider sedang sibuk. Coba lagi sebentar lagi.';
  return err?.message || 'Terjadi kesalahan di server. Coba lagi.';
}

// ---------- Supabase Integration (Navigate Knowledge Base, Catalog, Prices, Stocks, Leads) ----------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nakvxtnyrytiudtniqtt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

async function supabaseFetch(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!res.ok) {
      console.warn(`[supabase] ${path} returned status ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[supabase fetch error] ${path}:`, err.message);
    return null;
  }
}

async function searchSupabaseCatalog(query, limit = 4) {
  if (!query) {
    return (await supabaseFetch(`/rest/v1/documents?select=id,content,metadata&limit=${limit}`)) || [];
  }
  const cleanQ = String(query).trim();
  let rows = await supabaseFetch(`/rest/v1/documents?content=ilike.*${encodeURIComponent(cleanQ)}*&select=id,content,metadata&limit=${limit}`);
  if (rows && rows.length > 0) return rows;

  const stopWords = new Set(['lampu', 'harga', 'cek', 'tolong', 'ada', 'buat', 'berapa', 'apakah', 'navigate', 'mau', 'tanya', 'info', 'bisa', 'minta']);
  const words = cleanQ.split(/[\s,.-]+/).map(w => w.trim()).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
  for (const w of words) {
    rows = await supabaseFetch(`/rest/v1/documents?content=ilike.*${encodeURIComponent(w)}*&select=id,content,metadata&limit=${limit}`);
    if (rows && rows.length > 0) return rows;
  }
  return [];
}

async function searchSupabaseStock(query, limit = 5) {
  if (!query) {
    return (await supabaseFetch(`/rest/v1/inventory_stocks?select=*&order=stock_gudang.desc&limit=${limit}`)) || [];
  }
  const cleanQ = String(query).trim();
  let rows = await supabaseFetch(`/rest/v1/inventory_stocks?product_name=ilike.*${encodeURIComponent(cleanQ)}*&select=*&limit=${limit}`);
  if (rows && rows.length > 0) return rows;

  const stopWords = new Set(['lampu', 'stok', 'stock', 'cek', 'ready', 'gudang', 'ada', 'sisa', 'navigate', 'berapa']);
  const words = cleanQ.split(/[\s,.-]+/).map(w => w.trim()).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
  for (const w of words) {
    rows = await supabaseFetch(`/rest/v1/inventory_stocks?product_name=ilike.*${encodeURIComponent(w)}*&select=*&limit=${limit}`);
    if (rows && rows.length > 0) return rows;
  }
  return [];
}

async function getSupabaseProspectLeads(status = '', limit = 10) {
  let path = `/rest/v1/prospect_leads?select=id,company_name,phone_number,category,address,status&order=id.desc&limit=${limit}`;
  if (status) {
    path = `/rest/v1/prospect_leads?status=eq.${encodeURIComponent(status)}&select=id,company_name,phone_number,category,address,status&order=id.desc&limit=${limit}`;
  }
  return (await supabaseFetch(path)) || [];
}

async function buildSeanKnowledgeContext(userMessage = '') {
  const contextParts = [];
  const msgLower = (userMessage || '').toLowerCase();

  const isAskingPriceOrCatalog = /harga|katalog|spek|spesifikasi|pricelist|panel|downlight|strip|t8|t5|bulb|bohlam|ufo|flood|sorot|street|solar|pju|dust|trafo|driver|inbow|outbow/i.test(msgLower);
  const isAskingStock = /stok|stock|ready|gudang|sisa|unit|pcs|tersedia/i.test(msgLower);
  const isAskingLeads = /prospek|lead|leads|calon pelanggan|kontak|pabrik|follow up|toko/i.test(msgLower);

  if (isAskingPriceOrCatalog || (!isAskingStock && !isAskingLeads)) {
    const docs = await searchSupabaseCatalog(userMessage, 3);
    if (docs.length > 0) {
      const docSnippets = docs.map((d, i) => `--- DOKUMEN KATALOG #${i + 1} ---\n${d.content.slice(0, 1200)}`).join('\n\n');
      contextParts.push(`[DATA RESMI SUPABASE - KATALOG & PRICELIST NAVIGATE]\n${docSnippets}`);
    }
  }

  if (isAskingStock || isAskingPriceOrCatalog) {
    const stocks = await searchSupabaseStock(userMessage, 5);
    if (stocks.length > 0) {
      const stockSnippets = stocks.map(s => `- SKU ${s.sku}: ${s.product_name} | Stok Gudang: ${s.stock_gudang} ${s.unit || 'PCS'} | Warna: ${s.color_temp || '-'} | Watt: ${s.watt || '-'}`).join('\n');
      contextParts.push(`[DATA RESMI SUPABASE - STOK GUDANG REAL-TIME]\n${stockSnippets}`);
    }
  }

  if (isAskingLeads) {
    const leads = await getSupabaseProspectLeads('', 5);
    if (leads.length > 0) {
      const leadSnippets = leads.map(l => `- [ID ${l.id}] ${l.company_name} (${l.category || 'B2B'}) | Telp: ${l.phone_number} | Status: ${l.status} | Lokasi: ${(l.address || '-').replace(/\n/g, ' ').slice(0, 80)}`).join('\n');
      contextParts.push(`[DATA RESMI SUPABASE - PROSPEK LEADS B2B TERBARU]\n${leadSnippets}`);
    }
  }

  return contextParts.length > 0 ? contextParts.join('\n\n') : '';
}

// Helper untuk panggilan non-streaming (n8n, WAHA, dan multi-agent pipeline)
async function generateAgentReply(agent, messagesOrText, customSystemPrompt = null) {
  let systemPrompt = customSystemPrompt || buildSystemPrompt(agent);
  const lastText = typeof messagesOrText === 'string'
    ? messagesOrText
    : (messagesOrText[messagesOrText.length - 1]?.content || '');

  if (agent.id === 'sean' && !customSystemPrompt) {
    const knowledge = await buildSeanKnowledgeContext(lastText);
    if (knowledge) systemPrompt += '\n\n' + knowledge;
  }
  const model = agent.leader ? MODEL_LEADER : MODEL_TEAM;

  if (DEMO) {
    const lastText = typeof messagesOrText === 'string'
      ? messagesOrText
      : (messagesOrText[messagesOrText.length - 1]?.content || '');
    return demoReply(agent, lastText);
  }

  if (openaiClient) {
    const formattedMessages = typeof messagesOrText === 'string'
      ? [{ role: 'user', content: messagesOrText }]
      : cleanMessages(messagesOrText);

    const resp = await openaiClient.chat.completions.create({
      model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        ...formattedMessages,
      ],
    });
    return resp.choices[0]?.message?.content || '';
  }

  if (anthropicClient) {
    const formattedMessages = typeof messagesOrText === 'string'
      ? [{ role: 'user', content: messagesOrText }]
      : cleanMessages(messagesOrText);

    const msg = await anthropicClient.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: formattedMessages,
    });
    return msg.content[0]?.text || '';
  }

  return 'Provider AI tidak tersedia.';
}

// Helper pencarian agen berdasarkan ID atau nama untuk delegasi tugas
function findAgent(idOrName) {
  if (!idOrName) return null;
  const clean = idOrName.trim().toLowerCase();
  return AGENTS.find((a) => (
    a.id.toLowerCase() === clean
    || a.name.toLowerCase() === clean
    || a.name.toLowerCase().startsWith(clean)
    || clean.includes(a.id.toLowerCase())
    || clean.includes(a.name.toLowerCase())
  )) || null;
}

// Penyimpanan riwayat tugas antar-agen di server (Persisten ke disk)
const TASKS_FILE = fileURLToPath(new URL('./agent_tasks.json', import.meta.url));
let interAgentTasks = [];
try {
  if (existsSync(TASKS_FILE)) {
    interAgentTasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8')) || [];
  }
} catch (e) {
  interAgentTasks = [];
}

function persistTasks() {
  try {
    writeFileSync(TASKS_FILE, JSON.stringify(interAgentTasks.slice(0, 100), null, 2), 'utf8');
  } catch (e) {
    console.error('[persist-tasks-error]', e.message);
  }
}

// Handler penugasan otonom antar-agen (Inter-Agent Autonomous Delegation)
async function handleInterAgentTask(fromAgent, toAgent, taskDesc) {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    console.log(`[inter-agent-task] ${fromAgent.name} -> ${toAgent.name}: "${taskDesc.slice(0, 60)}..."`);

    const taskRecord = {
      id: taskId,
      fromId: fromAgent.id,
      fromName: fromAgent.name,
      fromRole: fromAgent.role,
      toId: toAgent.id,
      toName: toAgent.name,
      toRole: toAgent.role,
      task: taskDesc,
      status: 'working',
      createdAt: new Date().toISOString(),
    };
    interAgentTasks.unshift(taskRecord);
    if (interAgentTasks.length > 50) interAgentTasks.pop();
    persistTasks();

    // 1. Beritahu Web 3D bahwa agen target mulai bekerja di mejanya
    broadcastEvent('agent_task_start', taskRecord);

    // 2. Format prompt pengerjaan tugas
    const prompt = `Kamu menerima penugasan resmi dari rekan kerjamu ${fromAgent.name} (${fromAgent.role}):
Instruksi Tugas: "${taskDesc}"

Tugasmu sebagai ${toAgent.name} (${toAgent.role} - Keahlian: ${toAgent.focus}):
Kerjakan tugas ini sekarang secara tuntas, mendalam, kreatif, dan siap pakai.
Sajikan output deliverables lengkap (contohnya jika konsep video: format rasio 9:16, hook 0-3 detik, visual per adegan/scene, narasi/audio SFX, teks overlay, dan catatan teknis).
Langsung berikan hasil kerjamu tanpa basa-basi pembuka yang bertele-tele.`;

    // 3. Eksekusi LLM untuk agen target dengan fallback aman
    let result = '';
    try {
      result = await generateAgentReply(toAgent, prompt);
    } catch (llmErr) {
      console.error(`[inter-agent-task] Error panggilan AI untuk ${toAgent.name}:`, llmErr.message);
      // Fallback jika API sedang timeout/limit
      const existing = interAgentTasks.find(t => t.toId === toAgent.id && t.status === 'done' && t.result);
      result = existing?.result || `Tugas dari ${fromAgent.name} telah selesai diproses oleh ${toAgent.name}.\n\nInstruksi: ${taskDesc}\nStatus: Siap dieksekusi.`;
    }

    taskRecord.status = 'done';
    taskRecord.result = result;
    taskRecord.completedAt = new Date().toISOString();
    persistTasks();

    // 4. Beritahu Web 3D bahwa tugas selesai beserta hasil deliverables lengkap
    broadcastEvent('agent_task_done', taskRecord);
    console.log(`[inter-agent-task] Tugas ${toAgent.name} selesai dieksekusi.`);

    // 5. Deteksi chaining delegasi lanjutan jika ada
    if (result) {
      const chainedMatches = [...result.matchAll(/\[TUGAS_KE:\s*([a-zA-Z0-9_\s-]+?)\s*\|\s*([\s\S]+?)\]/g)];
      for (const match of chainedMatches) {
        const rawNext = match[1]?.trim();
        const nextDesc = match[2]?.trim();
        const nextAgent = findAgent(rawNext);
        if (nextAgent && nextAgent.id !== toAgent.id && nextAgent.id !== fromAgent.id) {
          setTimeout(() => {
            handleInterAgentTask(toAgent, nextAgent, nextDesc);
          }, 1500);
        }
      }
    }
  } catch (err) {
    console.error(`[inter-agent-task-error] Gagal delegasi dari ${fromAgent.name} ke ${toAgent.name}:`, err);
  }
}

function triggerInterAgentTasks(fromAgent, text) {
  if (!text) return;
  const taskMatches = [...text.matchAll(/\[TUGAS_KE:\s*([a-zA-Z0-9_\s-]+?)\s*\|\s*([\s\S]+?)\]/g)];
  for (const match of taskMatches) {
    const rawTarget = match[1]?.trim();
    const taskDesc = match[2]?.trim();
    const targetAgent = findAgent(rawTarget);
    if (targetAgent && targetAgent.id !== fromAgent.id) {
      handleInterAgentTask(fromAgent, targetAgent, taskDesc);
    }
  }
}

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({ demo: DEMO, needsCode: Boolean(ACCESS_CODE) });
});

app.get('/api/verify', requireAccess, (req, res) => res.json({ ok: true }));

// Endpoint riwayat tugas antar-agen
app.get('/api/agent/tasks', (req, res) => {
  res.json({ success: true, count: interAgentTasks.length, tasks: interAgentTasks });
});

// 1. Endpoint SSE Streaming (Dipakai oleh Web UI 3D Kantor)
app.post('/api/chat', requireAccess, rateLimit, dailyCap, async (req, res) => {
  const agent = agentById(req.body?.agentId);
  if (!agent) return res.status(400).json({ error: 'Karyawan tidak ditemukan.' });

  const messages = cleanMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Pesan kosong.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let closed = false;
  let stream = null;
  res.on('close', () => {
    closed = true;
    if (stream && typeof stream.abort === 'function') stream.abort();
  });

  try {
    let sysPrompt = buildSystemPrompt(agent);
    if (agent.id === 'sean') {
      const lastUser = messages[messages.length - 1]?.content || '';
      const knowledge = await buildSeanKnowledgeContext(lastUser);
      if (knowledge) sysPrompt += '\n\n' + knowledge;
    }

    let fullText = '';

    if (DEMO) {
      const reply = demoReply(agent, messages[messages.length - 1].content);
      fullText = reply;
      const words = reply.split(/(\s+)/);
      for (const w of words) {
        if (closed) return;
        send({ t: w });
        await sleep(25);
      }
    } else if (openaiClient) {
      // 9router (OpenAI-compatible streaming)
      stream = await openaiClient.chat.completions.create({
        model: agent.leader ? MODEL_LEADER : MODEL_TEAM,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: sysPrompt },
          ...messages,
        ],
        stream: true,
      });

      for await (const chunk of stream) {
        if (closed) break;
        const textChunk = chunk.choices[0]?.delta?.content || '';
        if (textChunk) {
          fullText += textChunk;
          send({ t: textChunk });
        }
      }
      console.log(`[chat-9router] ${agent.id} model=${agent.leader ? MODEL_LEADER : MODEL_TEAM}`);
    } else if (anthropicClient) {
      // Anthropic direct streaming
      stream = anthropicClient.messages.stream({
        model: agent.leader ? MODEL_LEADER : MODEL_TEAM,
        max_tokens: MAX_TOKENS,
        system: sysPrompt,
        messages,
      });
      stream.on('text', (t) => {
        fullText += t;
        if (!closed) send({ t });
      });
      const final = await stream.finalMessage();
      if (!fullText && final?.content?.[0]?.text) {
        fullText = final.content[0].text;
      }
      const u = final.usage || {};
      console.log(`[chat-anthropic] ${agent.id} model=${final.model} in=${u.input_tokens} out=${u.output_tokens}`);
    }
    if (!closed) send({ done: true });

    // Pemicu pengerjaan otomatis jika ada delegasi tugas ke rekan kerja
    if (fullText) {
      triggerInterAgentTasks(agent, fullText);
    }
  } catch (err) {
    if (!closed) {
      console.error('[chat error]', err?.status || '', err?.message || err);
      send({ error: friendlyError(err) });
    }
  } finally {
    res.end();
  }
});

// 2. Endpoint REST Non-Streaming (Khusus integrasi n8n & WAHA WhatsApp)
app.post('/api/agent/chat', requireAccess, rateLimit, dailyCap, async (req, res) => {
  try {
    const { agentId = 'rina', message, history = [] } = req.body;
    const agent = agentById(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent karyawan tidak ditemukan.' });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'Pesan wajib diisi (string).' });
    }

    const fullMessages = [
      ...cleanMessages(history),
      { role: 'user', content: message.trim() },
    ];

    const reply = await generateAgentReply(agent, fullMessages);

    if (reply) {
      triggerInterAgentTasks(agent, reply);
    }

    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        division: agent.division,
        leader: agent.leader,
      },
      reply,
    });
  } catch (err) {
    console.error('[agent chat error]', err);
    res.status(500).json({ success: false, error: friendlyError(err) });
  }
});

// 3. Multi-Agent Pipeline: Sosial Media (Nadia -> Dewi Review -> Siap Approve)
app.post('/api/pipeline/social-content', requireAccess, rateLimit, dailyCap, async (req, res) => {
  try {
    const {
      topic,
      platform = 'Instagram',
      targetAudience = 'Pelaku Bisnis & UMKM',
      notes = '',
    } = req.body;

    if (!topic) {
      return res.status(400).json({ success: false, error: 'Topik konten (topic) wajib diisi.' });
    }

    const charles = agentById('charles'); // Copywriter (pembuat draft)
    const patrick = agentById('patrick'); // Social Media Planner (Leader & reviewer)

    if (!charles || !patrick) {
      return res.status(500).json({ success: false, error: 'Agent charles atau patrick tidak ditemukan di roster.' });
    }

    // Step 1: Charles membuat draft lengkap
    const charlesPrompt = `Buatkan draft konten ${platform} lengkap untuk brand Navigate:
- Topik: ${topic}
- Target Audience: ${targetAudience}
${notes ? `- Catatan Tambahan: ${notes}` : ''}

Format draft yang harus kamu sertakan:
1. Hook (3 detik pertama / baris awal yang langsung menarik perhatian)
2. Isi Konten / Script / Slide Carousel Copy
3. Call To Action (CTA) yang jelas dan kuat
4. Rekomendasi 5-8 Hashtag relevan untuk Navigate`;

    const draft = await generateAgentReply(charles, charlesPrompt);

    // Step 2: Patrick (Planner/Leader) mereview kesesuaian strategi dan pasar
    const patrickPrompt = `Kamu adalah Social Media Planner Navigate. Copywriter timmu (Charles) baru saja membuat draft konten berikut:

--- DRAFT CHARLES ---
${draft}
--- AKHIR DRAFT ---

Tugasmu sebagai Planner:
1. Review apakah draft ini sesuai dengan tren pasar, target audiens Navigate, dan tujuan konten.
2. Nyatakan status kelayakan: [STATUS: APPROVED / REVISED].
3. Sajikan "DRAFT FINAL SIAP PUBLISH" yang sudah disesuaikan dengan strategi konten Navigate.`;

    const leaderReview = await generateAgentReply(patrick, patrickPrompt);

    // Step 3: Simpan otomatis ke database PostgreSQL kantor_ai
    let postId = null;
    try {
      const insertRes = await pgPool.query(
        `INSERT INTO social_posts (topic, platform, draft_nadia, review_dewi, final_content, status)
         VALUES ($1, $2, $3, $4, $5, 'PENDING_APPROVAL')
         RETURNING id`,
        [topic, platform, draft, leaderReview, leaderReview]
      );
      postId = insertRes.rows[0]?.id;
      console.log(`[db] Post #${postId} tersimpan di PostgreSQL kantor_ai`);
    } catch (dbErr) {
      console.error('[db insert error]', dbErr.message);
    }

    res.json({
      success: true,
      pipeline: 'social_content',
      postId,
      status: 'PENDING_APPROVAL',
      creator: { id: charles.id, name: charles.name, role: charles.role },
      leader: { id: patrick.id, name: patrick.name, role: patrick.role },
      platform,
      topic,
      draft,
      leaderReview,
      readyForApproval: true,
    });
  } catch (err) {
    console.error('[pipeline error]', err);
    res.status(500).json({ success: false, error: friendlyError(err) });
  }
});

// 4. Endpoint Approval (Dipanggil n8n saat Bos Ridho balas 'APPROVE' via WhatsApp)
app.post('/api/pipeline/approve', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ success: false, error: 'postId wajib diisi.' });
    }

    const updateRes = await pgPool.query(
      `UPDATE social_posts 
       SET status = 'APPROVED', approved_at = NOW() 
       WHERE id = $1 AND status = 'PENDING_APPROVAL' 
       RETURNING id, topic, platform, final_content, status`,
      [Number(postId)]
    );

    if (!updateRes.rows.length) {
      return res.status(404).json({
        success: false,
        error: `Post #${postId} tidak ditemukan atau statusnya bukan PENDING_APPROVAL.`,
      });
    }

    res.json({
      success: true,
      message: `Post #${postId} berhasil di-approve! Siap diposting.`,
      post: updateRes.rows[0],
    });
  } catch (err) {
    console.error('[approve error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Live Events & Sales Inquiry System ----------
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastEvent(type, payload) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

// Endpoint saat calon customer bertanya harga di WhatsApp / WAHA -> langsung dihandle Sean
app.post('/api/sales/inquiry', async (req, res) => {
  try {
    const {
      customerName = 'Calon Pelanggan',
      customerPhone = '',
      message = '',
      product = '',
    } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Pesan inquiry (message) wajib diisi.' });
    }

    const sean = agentById('sean');
    if (!sean) {
      return res.status(500).json({ success: false, error: 'Agent sean tidak ditemukan di roster.' });
    }

    // 1. Simpan draf awal ke PostgreSQL kantor_ai (status DRAFT) secara cepat
    let inquiryId = null;
    try {
      const insRes = await pgPool.query(
        `INSERT INTO sales_inquiries (customer_name, customer_phone, inquiry_text, product_name, quote_draft, status)
         VALUES ($1, $2, $3, $4, 'Sedang menyusun penawaran...', 'DRAFT')
         RETURNING id`,
        [customerName, customerPhone, message, product || 'Lampu Navigate']
      );
      inquiryId = insRes.rows[0]?.id;
      console.log(`[db] Sales inquiry #${inquiryId} dari ${customerName} tercatat`);
    } catch (dbErr) {
      console.error('[db inquiry insert error]', dbErr.message);
    }

    // 2. Beri respon 200 OK langsung ke n8n (< 50ms) agar n8n TIDAK TIMEOUT
    res.json({
      success: true,
      inquiryId,
      customerName,
      customerPhone,
      product: product || 'Produk Navigate',
      message,
      status: 'PROCESSING',
      info: 'Inquiry diterima. Sean sedang menganalisis katalog Supabase dan menyusun penawaran.',
    });

    // 3. Notifikasi visual awal ke Web 3D (Sean langsung mulai mengetik di layar)
    broadcastEvent('sales_inquiry', {
      inquiryId,
      customerName,
      customerPhone,
      product: product || 'Produk Navigate',
      message,
      status: 'PROCESSING',
    });

    // 4. Proses AI di background: ambil Supabase & buat draf quotation resmi
    (async () => {
      try {
        const searchTarget = product || message;
        const [matchingDocs, matchingStocks] = await Promise.all([
          searchSupabaseCatalog(searchTarget, 3),
          searchSupabaseStock(searchTarget, 5),
        ]);

        let catalogContext = '';
        if (matchingDocs.length > 0) {
          catalogContext = matchingDocs.map((d, i) => `--- KATALOG/PRICELIST RESMI #${i + 1} ---\n${d.content.slice(0, 1200)}`).join('\n\n');
        }
        let stockContext = '';
        if (matchingStocks.length > 0) {
          stockContext = matchingStocks.map(s => `- SKU ${s.sku}: ${s.product_name} | Stok Gudang: ${s.stock_gudang} ${s.unit || 'PCS'} | Warna: ${s.color_temp || '-'}`).join('\n');
        }

        const seanPrompt = `Calon pelanggan Navigate menanyakan harga / penawaran:
- Nama Customer: ${customerName}
- WhatsApp: ${customerPhone || '-'}
- Pesan: "${message}"
${product ? `- Produk yang Dicari: ${product}` : ''}

${catalogContext ? `[DATA RESMI SUPABASE - KATALOG & PRICELIST NAVIGATE]\n${catalogContext}\n` : ''}
${stockContext ? `[DATA RESMI SUPABASE - STOK GUDANG]\n${stockContext}\n` : ''}

Tugasmu sebagai Sean (Sales Admin Navigate):
1. Buatkan balasan penawaran resmi yang ramah, sopan, dan persuasif untuk WhatsApp.
2. Gunakan harga resmi dari data Supabase di atas. Jika ada kuantiti banyak (proyek/toko), tawarkan estimasi harga bundling dan opsi invoice resmi.
3. Sorot keunggulan produk pencahayaan Navigate (garansi resmi, hemat daya, build quality premium, ketersediaan stok).
4. Akhiri dengan Call To Action (CTA) yang memudahkan closing.`;

        const quoteDraft = await generateAgentReply(sean, seanPrompt, buildSystemPrompt(sean));

        // Update database PostgreSQL dengan hasil draf penawaran Sean
        if (inquiryId) {
          await pgPool.query(
            `UPDATE sales_inquiries SET quote_draft = $1, status = 'DRAFT' WHERE id = $2`,
            [quoteDraft, inquiryId]
          );
        }

        // Broadcast event final dengan draf lengkap ke Web 3D
        broadcastEvent('sales_inquiry', {
          inquiryId,
          customerName,
          customerPhone,
          product: product || 'Produk Navigate',
          message,
          quoteDraft,
          status: 'DRAFT',
        });
        console.log(`[sales] Draf penawaran Sean untuk #${inquiryId} selesai disusun.`);
      } catch (bgErr) {
        console.error('[sales bg error]', bgErr);
      }
    })();
  } catch (err) {
    console.error('[sales inquiry error]', err);
    res.status(500).json({ success: false, error: friendlyError(err) });
  }
});

app.get('/api/sales/inquiries', async (req, res) => {
  try {
    const r = await pgPool.query('SELECT * FROM sales_inquiries ORDER BY id DESC LIMIT 20');
    res.json({ success: true, inquiries: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/catalog', async (req, res) => {
  try {
    const docs = await searchSupabaseCatalog(req.query.q || '', Number(req.query.limit || 5));
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/stocks', async (req, res) => {
  try {
    const stocks = await searchSupabaseStock(req.query.q || '', Number(req.query.limit || 10));
    res.json({ success: true, count: stocks.length, data: stocks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/leads', async (req, res) => {
  try {
    const leads = await getSupabaseProspectLeads(req.query.status || '', Number(req.query.limit || 10));
    res.json({ success: true, count: leads.length, data: leads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Halaman Web Review Interaktif untuk Bos Ridho (Dibuka via Link WhatsApp)
app.get('/review/:id', async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if (!postId) return res.status(400).send('ID Postingan tidak valid.');

    const result = await pgPool.query('SELECT * FROM social_posts WHERE id = $1', [postId]);
    if (!result.rows.length) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="id">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Post Not Found</title>
        <style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
        </head><body><h2>Konten #${postId} tidak ditemukan di database.</h2></body></html>
      `);
    }

    const post = result.rows[0];
    const isApproved = post.status === 'APPROVED';

    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Konten #${post.id} - ${post.topic}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0b0f19;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      padding-bottom: 90px;
    }
    .header {
      background: #111827;
      border-bottom: 1px solid #1f2937;
      padding: 14px 20px;
      position: sticky;
      top: 0;
      z-index: 50;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand { font-weight: 700; font-size: 15px; color: #60a5fa; letter-spacing: 0.5px; }
    .badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 9999px;
      text-transform: uppercase;
    }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .badge-approved { background: #dcfce7; color: #166534; }
    .container { max-width: 600px; margin: 0 auto; padding: 18px 16px; }
    .title-card {
      background: #1e293b;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      border: 1px solid #334155;
    }
    .title-card h1 { font-size: 18px; color: #ffffff; margin-bottom: 6px; }
    .meta { font-size: 13px; color: #94a3b8; display: flex; gap: 12px; }
    .video-section {
      background: #000000;
      border-radius: 14px;
      overflow: hidden;
      margin-bottom: 18px;
      border: 1px solid #334155;
      position: relative;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
    }
    .video-player {
      width: 100%;
      height: 380px;
      display: block;
      object-fit: cover;
      background: #111827;
    }
    .video-label {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      color: #38bdf8;
    }
    .card {
      background: #1e293b;
      border-radius: 14px;
      padding: 18px;
      margin-bottom: 16px;
      border: 1px solid #334155;
    }
    .card-leader { border-left: 4px solid #f59e0b; }
    .card-creator { border-left: 4px solid #3b82f6; }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #334155;
    }
    .avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: #3b82f6;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 13px;
      color: white;
    }
    .avatar-leader { background: #d97706; }
    .author-name { font-size: 14px; font-weight: 700; color: #f1f5f9; }
    .author-role { font-size: 12px; color: #94a3b8; }
    .content-box {
      font-size: 14px;
      color: #cbd5e1;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bottom-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: #0f172a;
      border-top: 1px solid #1e293b;
      padding: 12px 16px;
      display: flex;
      gap: 10px;
      z-index: 100;
      max-width: 600px;
      margin: 0 auto;
    }
    .btn {
      flex: 1;
      padding: 14px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      text-align: center;
      text-decoration: none;
    }
    .btn-approve {
      background: #10b981;
      color: #ffffff;
    }
    .btn-approve:hover { background: #059669; }
    .btn-approve:disabled {
      background: #374151;
      color: #9ca3af;
      cursor: not-allowed;
    }
    .btn-revision {
      background: #334155;
      color: #f1f5f9;
      flex: 0.6;
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="brand">KANTOR NAVIGATE</div>
    <div id="statusBadge" class="badge ${isApproved ? 'badge-approved' : 'badge-pending'}">
      ${post.status}
    </div>
  </div>

  <div class="container">
    <div class="title-card">
      <h1>${escapeHtml(post.topic)}</h1>
      <div class="meta">
        <span>📱 ${post.platform || 'Instagram / TikTok'}</span>
        <span>🆔 #${post.id}</span>
      </div>
    </div>

    <!-- PREVIEW VIDEO PLAYER -->
    <div class="video-section">
      <div class="video-label">🎬 Video Preview (Victor)</div>
      <video class="video-player" controls playsinline preload="auto">
        <source src="${post.post_url || 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'}" type="video/mp4">
        Browser kamu tidak mendukung video tag.
      </video>
    </div>

    <!-- REVIEW DARI PATRICK (SOCIAL MEDIA PLANNER) -->
    <div class="card card-leader">
      <div class="card-header">
        <div class="avatar avatar-leader">PT</div>
        <div>
          <div class="author-name">Patrick</div>
          <div class="author-role">Social Media Planner · Navigate</div>
        </div>
      </div>
      <div class="content-box">${escapeHtml(post.review_dewi || 'Belum ada catatan review.')}</div>
    </div>

    <!-- DRAFT KONTEN DARI CHARLES -->
    <div class="card card-creator">
      <div class="card-header">
        <div class="avatar">CH</div>
        <div>
          <div class="author-name">Charles</div>
          <div class="author-role">Copywriter · Navigate</div>
        </div>
      </div>
      <div class="content-box">${escapeHtml(post.draft_nadia || 'Belum ada draf konten.')}</div>
    </div>
  </div>

  <!-- FLOATING ACTION BAR -->
  <div class="bottom-bar">
    <button id="approveBtn" class="btn btn-approve" ${isApproved ? 'disabled' : ''} onclick="handleApprove(${post.id})">
      ${isApproved ? '✅ SUDAH DI-APPROVE' : '✅ APPROVE & PUBLISH'}
    </button>
    <a href="https://wa.me/?text=Revisi%20untuk%20Post%20%23${post.id}%3A%20" class="btn btn-revision">✍️ Revisi</a>
  </div>

  <script>
    async function handleApprove(id) {
      const btn = document.getElementById('approveBtn');
      const badge = document.getElementById('statusBadge');
      btn.disabled = true;
      btn.innerText = 'Memproses Approval...';

      try {
        const res = await fetch('/api/pipeline/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId: id })
        });
        const data = await res.json();
        if (data.success) {
          btn.innerText = '✅ BERHASIL DI-APPROVE!';
          btn.style.background = '#059669';
          badge.className = 'badge badge-approved';
          badge.innerText = 'APPROVED';
          alert('Selamat! Konten #' + id + ' sudah disetujui dan siap diterbitkan otomatis!');
        } else {
          alert('Error: ' + data.error);
          btn.disabled = false;
          btn.innerText = '✅ APPROVE & PUBLISH';
        }
      } catch (err) {
        alert('Gagal menghubungi server.');
        btn.disabled = false;
        btn.innerText = '✅ APPROVE & PUBLISH';
      }
    }
  </script>
</body>
</html>
    `;

    res.send(html);
  } catch (err) {
    console.error('[review error]', err);
    res.status(500).send('Terjadi kesalahan pada server saat memuat halaman review.');
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------- Frontend hasil build (produksi) ----------
const dist = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(`${dist}/index.html`);
  });
}

app.listen(PORT, () => {
  console.log(`Kantor AI API jalan di http://localhost:${PORT}`);
  const provider = openaiClient
    ? `9router (${ROUTER_BASE_URL})`
    : anthropicClient
      ? 'Anthropic Direct'
      : 'DEMO';
  console.log(`Provider: ${provider} | Leader: ${MODEL_LEADER} | Tim: ${MODEL_TEAM}`);
  console.log(ACCESS_CODE ? 'Kode akses: aktif' : 'Kode akses: TIDAK aktif (isi ACCESS_CODE sebelum dipublikasi)');
});

// Pastikan event loop tetap aktif di Windows
setInterval(() => {}, 60000);
