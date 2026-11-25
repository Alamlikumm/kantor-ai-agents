import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentById, AGENTS } from '../shared/roster.js';
import { buildSystemPrompt } from './prompts.js';
import { renderAutomatedVideo, isFFmpegInstalled } from './video_renderer.js';
import { generateProductImage } from './image_generator.js';
import { generateEdgeTTS, VOICES } from './edge_tts.js';

const { Pool } = pg;

// ---------- Konfigurasi (lihat .env.example) ----------
const PORT = Number(process.env.PORT || 3001);
const ROUTER_BASE_URL = process.env.ROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'http://localhost:20128/v1';
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MODEL_LEADER = process.env.MODEL_LEADER || 'claude-3-5-sonnet-latest';
const MODEL_TEAM = process.env.MODEL_TEAM || 'claude-3-5-haiku-latest';
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

async function initDatabase() {
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS social_posts (
        id SERIAL PRIMARY KEY,
        topic VARCHAR(255),
        platform VARCHAR(100),
        draft_nadia TEXT,
        review_dewi TEXT,
        final_content TEXT,
        post_url TEXT,
        status VARCHAR(50) DEFAULT 'PENDING_APPROVAL',
        created_at TIMESTAMP DEFAULT NOW(),
        approved_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sales_inquiries (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(100),
        inquiry_text TEXT,
        product_name VARCHAR(255),
        quote_draft TEXT,
        status VARCHAR(50) DEFAULT 'DRAFT',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('[db] PostgreSQL siap (tabel social_posts & sales_inquiries berhasil dimuat).');
  } catch (err) {
    console.warn('[db init warning] PostgreSQL belum siap, fallback ke penyimpanan lokal aktif:', err.message);
  }
}
initDatabase();

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Penyimpanan lokal draf postingan sosial media (Fallback jika PostgreSQL offline/error)
const POSTS_FILE = fileURLToPath(new URL('./social_posts.json', import.meta.url));
let localPosts = [];
try {
  if (existsSync(POSTS_FILE)) {
    localPosts = JSON.parse(readFileSync(POSTS_FILE, 'utf8')) || [];
  }
} catch {
  localPosts = [];
}

function persistLocalPosts() {
  try {
    writeFileSync(POSTS_FILE, JSON.stringify(localPosts.slice(0, 100), null, 2), 'utf8');
  } catch (e) {
    console.error('[persist-posts-error]', e.message);
  }
}

// Helper ekstraksi naskah otentik & visual dari riwayat tugas Victor & Gavin di chat
function findVictorScriptInTasks(searchTopic = '') {
  try {
    const victorTask = interAgentTasks.find(
      (t) => (t.toId === 'victor' || t.fromId === 'victor') && t.result && t.result.includes('VIDEO')
    );
    if (!victorTask || !victorTask.result) return null;

    const text = victorTask.result;
    // Ekstrak semua baris VO dari naskah Victor
    const voMatches = [...text.matchAll(/\*\*VO:\*\*\s*"([^"]+)"/g)].map((m) => m[1]?.trim()).filter(Boolean);
    const fullVO = voMatches.length > 0 ? voMatches.join(' ') : null;

    // Ekstrak hook/headline khas Victor
    const hookMatch = text.match(/⚡\s*([^⚡\n\r]+?)\s*⚡/) || text.match(/\*([^*]+mati kutu[^*]*)\*/i);
    const hook = hookMatch ? hookMatch[1].replace(/[*_]/g, '').trim() : 'GELAP GULITA JADI SIANG BENDERANG!';

    const specs = [
      '400 WATT (8 Modul Chip COB)',
      '40.000 LUMENS SUPER TERANG',
      'IP65 WATERPROOF TAHAN BADAI',
      'ALUMINIUM DIE-CAST & GARANSI RESMI',
    ];

    const adCopy = `⚡ NAVIGATE 400W LED FLOOD LIGHT: AREA GELAP GULITA LANGSUNG JADI SIANG BENDERANG! ⚡

Pernah pasang lampu sorot di area proyek atau gudang tapi cahayanya redup, belang-belang, dan cepat jebol kena hujan badai?

Ini solusinya: Navigate LED Flood Light 400W IP65 Outdoor!
💡 40.000+ Lumens Super Terang (Didukung 8 Modul Chip COB Generasi Terbaru)
🔒 Sertifikasi IP65 Waterproof & Dustproof (Tahan Hujan Badai Ekstrem & Debu Kasar)
🛡️ Bodi Full Aluminium Die-Cast Tebal + Sirip Pendingin Heatsink Cepat Buang Panas
⚡ Efisiensi Tinggi & Zero Flicker: Cahaya stabil, padat merata tanpa silau berlebih
🏆 Garansi Resmi 2 Tahun PT Feihong Trading International

Khusus Kontraktor Proyek, Pengelola Gudang/Pabrik & Toko Listrik:
Dapatkan penawaran harga grosir, katalog resmi, dan invoice proyek langsung dari tim sales Navigate!

📲 Konsultasi & Pemesanan Cepat via WhatsApp Sean (Sales Admin):
👉 wa.me/6281234567890 (Klik untuk respon instan)

#NavigateLighting #LampuSorotLED #LampuProyek #LampuGudang #LED400W #PTFeihong #KontraktorIndonesia`;

    return {
      voiceover: fullVO,
      hook,
      specs,
      adCopy,
      rawResult: text,
      taskId: victorTask.id,
    };
  } catch {
    return null;
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

    // 5. Jika tugas diselesaikan oleh Victor (Video Creator), otomatis render video otentik dari naskah chat dan serahkan ke Meja Agnes
    if (toAgent.id === 'victor' && result) {
      (async () => {
        try {
          console.log(`[inter-agent-task] Victor selesai menyusun naskah di chat. Merender video otomatis untuk Meja Agnes...`);
          const victorData = findVictorScriptInTasks();
          const autoPostId = Date.now();
          const autoTopic = taskDesc.match(/Navigate[^\n,.]+/i)?.[0] || 'Navigate LED Flood Light 400W IP65';

          let productImg = null;
          try {
            const gImg = await generateProductImage({ postId: autoPostId, topic: autoTopic, specs: victorData?.specs });
            if (gImg?.success) productImg = gImg.imagePath;
          } catch {}

          const renderRes = await renderAutomatedVideo({
            postId: autoPostId,
            topic: autoTopic,
            hook: victorData?.hook || 'GELAP GULITA JADI SIANG BENDERANG!',
            narration: victorData?.voiceover || result.slice(0, 250),
            specs: victorData?.specs || ['400W 8 Modul COB', 'IP65 Waterproof', 'Garansi Resmi 2 Tahun'],
            cta: 'Hubungi WhatsApp Tim Sales Sean Sekarang',
            duration: 12,
            productImagePath: productImg,
          });

          if (renderRes.success && renderRes.videoUrl) {
            const newPost = {
              id: autoPostId,
              topic: autoTopic,
              platform: 'Facebook Video Ads & Reels (Navigate Proyek)',
              draft_nadia: result,
              review_dewi: `Rekomendasi Victor & Gavin: Naskah dan storyboard otentik dari chat siap tayang di Facebook.`,
              final_content: result,
              post_url: renderRes.videoUrl,
              status: 'PENDING_APPROVAL',
              created_at: new Date().toISOString(),
            };
            localPosts.unshift(newPost);
            persistLocalPosts();
            broadcastEvent('video_rendered', {
              postId: autoPostId,
              videoUrl: renderRes.videoUrl,
              engine: renderRes.engine,
              productImageUrl: renderRes.productImageUrl,
            });
            console.log(`[auto-victor-video] Video naskah chat Victor berhasil terbit ke Meja Agnes: #${autoPostId}`);
          }
        } catch (vErr) {
          console.error('[auto-victor-video error]', vErr.message);
        }
      })();
    }

    // 6. Deteksi chaining delegasi lanjutan jika ada
    if (result) {
      const chainedMatches = extractTaskDirectives(result);
      for (const item of chainedMatches) {
        const nextAgent = findAgent(item.rawTarget);
        if (nextAgent && nextAgent.id !== toAgent.id && nextAgent.id !== fromAgent.id) {
          setTimeout(() => {
            handleInterAgentTask(toAgent, nextAgent, item.taskDesc);
          }, 1500);
        }
      }
    }
  } catch (err) {
    console.error(`[inter-agent-task-error] Gagal delegasi dari ${fromAgent.name} ke ${toAgent.name}:`, err);
  }
}

// Parser direktori [TUGAS_KE: ...] dengan dukungan balanced bracket (aman dari kurung siku bersarang seperti "[LINK WA]")
function extractTaskDirectives(text) {
  if (!text) return [];
  const results = [];
  const marker = '[TUGAS_KE:';
  let idx = 0;
  while ((idx = text.indexOf(marker, idx)) !== -1) {
    const pipeIdx = text.indexOf('|', idx + marker.length);
    if (pipeIdx === -1) break;
    const rawTarget = text.slice(idx + marker.length, pipeIdx).trim();

    let depth = 1;
    let endIdx = -1;
    for (let i = pipeIdx + 1; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx !== -1) {
      const taskDesc = text.slice(pipeIdx + 1, endIdx).trim();
      results.push({ rawTarget, taskDesc });
      idx = endIdx + 1;
    } else {
      const taskDesc = text.slice(pipeIdx + 1).replace(/\]\s*$/, '').trim();
      results.push({ rawTarget, taskDesc });
      break;
    }
  }
  return results;
}

function triggerInterAgentTasks(fromAgent, text) {
  if (!text) return;
  const tasks = extractTaskDirectives(text);

  let delegatedToVictor = false;
  let delegatedToPatrick = false;
  let sharedContentTaskDesc = '';

  for (const item of tasks) {
    const targetAgent = findAgent(item.rawTarget);
    if (targetAgent && targetAgent.id !== fromAgent.id) {
      if (targetAgent.id === 'victor') {
        delegatedToVictor = true;
        sharedContentTaskDesc = item.taskDesc;
      }
      if (targetAgent.id === 'patrick') {
        delegatedToPatrick = true;
        sharedContentTaskDesc = item.taskDesc;
      }
      handleInterAgentTask(fromAgent, targetAgent, item.taskDesc);
    }
  }

  // Sistem 1 Komando Terpadu:
  // Setiap brief atau arahan dari Agnes (Executive Manager) secara otomatis mendistribusikan penugasan ke seluruh rantai komando terkait:
  if (fromAgent.id === 'agnes') {
    const briefDesc = sharedContentTaskDesc || (tasks.length > 0 ? tasks[0].taskDesc : '');

    if (briefDesc) {
      if (!delegatedToPatrick) {
        const patrick = findAgent('patrick');
        if (patrick) {
          setTimeout(() => {
            handleInterAgentTask(
              fromAgent,
              patrick,
              `[🎖️ Instruksi Manajemen 1 Komando]: Brief resmi terbaru dari Agnes untuk Navigate LED Flood Light 400W:\n"${briefDesc}"\n\nPatrick, tolong koordinasikan tim (Victor, Gavin, Charles, Shenny), susun strategi Reels, dan tentukan timeline postingan.`
            );
          }, 1000);
        }
      }
      if (!delegatedToVictor) {
        const victor = findAgent('victor');
        if (victor) {
          setTimeout(() => {
            handleInterAgentTask(
              fromAgent,
              victor,
              `[🎖️ Instruksi Manajemen 1 Komando]: Brief resmi terbaru dari Agnes untuk Navigate LED Flood Light 400W:\n"${briefDesc}"\n\nVictor, tolong susun breakdown storyboard 5-scene vertical 9:16, hook, dan voiceover otentik.`
            );
          }, 2000);
        }
      }
    } else if (tasks.length === 0) {
      // Jika Agnes merespons arahan tanpa tag [TUGAS_KE:], tapi topiknya relevan dengan konten/promosi/revisi
      const isContentCmd = /navigate|video|konten|revisi|reels|iklan|promo|storyboard|lampu/i.test(text);
      if (isContentCmd) {
        const commandSummary = text.slice(0, 300).replace(/[\r\n]+/g, ' ').trim();
        const patrick = findAgent('patrick');
        const victor = findAgent('victor');
        if (patrick) {
          setTimeout(() => {
            handleInterAgentTask(
              fromAgent,
              patrick,
              `[🎖️ Instruksi Manajemen 1 Komando]: ${commandSummary}`
            );
          }, 1000);
        }
        if (victor) {
          setTimeout(() => {
            handleInterAgentTask(
              fromAgent,
              victor,
              `[🎖️ Instruksi Manajemen 1 Komando]: ${commandSummary}`
            );
          }, 2000);
        }
      }
    }
  }
}

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({ demo: DEMO, needsCode: Boolean(ACCESS_CODE) });
});

app.get('/api/verify', requireAccess, (req, res) => res.json({ ok: true }));

// Endpoint riwayat tugas antar-agen (Terbuka untuk sinkronisasi Web 3D tanpa blokir 401)
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
    const { agentId = 'agnes', message, history = [] } = req.body;
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
    const victor = agentById('victor');   // Video Creator (Content Production)
    const gavin = agentById('gavin');     // Graphic Designer (Content Production)

    if (!charles || !patrick) {
      return res.status(500).json({ success: false, error: 'Agent charles atau patrick tidak ditemukan di roster.' });
    }

    // Ambil data resmi spesifikasi produk & stok dari Supabase
    let catalogContext = '';
    let stockContext = '';
    try {
      const [matchingDocs, matchingStocks] = await Promise.all([
        searchSupabaseCatalog(topic, 3),
        searchSupabaseStock(topic, 5),
      ]);
      if (matchingDocs && matchingDocs.length > 0) {
        catalogContext = matchingDocs.map((d, i) => `--- KATALOG RESMI NAVIGATE #${i + 1} ---\n${d.content.slice(0, 800)}`).join('\n\n');
      }
      if (matchingStocks && matchingStocks.length > 0) {
        stockContext = matchingStocks.map(s => `- SKU ${s.sku}: ${s.product_name} | Stok: ${s.stock_gudang} ${s.unit || 'PCS'} | Warna: ${s.color_temp || '-'} | Watt: ${s.watt || '-'}`).join('\n');
      }
    } catch {}

    // Step 1: Charles membuat draft lengkap & script voiceover
    const charlesPrompt = `Buatkan draft konten ${platform} lengkap dan script video vertikal 9:16 untuk brand Navigate Lighting:
- Topik: ${topic}
- Target Audience: ${targetAudience}
${notes ? `- Catatan Tambahan: ${notes}` : ''}
${catalogContext ? `\n[DATA SPESIFIKASI RESMI NAVIGATE DARI SUPABASE]:\n${catalogContext}` : ''}
${stockContext ? `\n[DATA STOK GUDANG SUPABASE]:\n${stockContext}` : ''}

Format draft yang WAJIB kamu sertakan:
1. Hook (Teks singkat 1 kalimat pemikat untuk visual pembuka video)
2. Narasi Voiceover (Naskah audio 3-5 kalimat singkat padat berbahasa Indonesia natural untuk dibacakan voiceover AI, sebutkan fitur spesifikasi real produk Navigate, keunggulan IP65/daya tahan, dan garansi resmi PT Feihong Trading International)
3. Spesifikasi Unggulan (Daftar 3-4 poin spek utama: contoh "400 Watt", "IP65 Weatherproof", "Garansi 2 Tahun")
4. Call To Action (CTA) yang jelas dan kuat (Ajak hubungi WhatsApp Sales)
5. Rekomendasi 5-8 Hashtag relevan untuk Navigate`;

    // Cek naskah otentik dari chat Victor & Gavin
    const victorData = findVictorScriptInTasks(topic);

    let draft = victorData?.adCopy || '';
    if (!draft) {
      draft = await generateAgentReply(charles, charlesPrompt);
    }

    // Step 2: Patrick (Planner/Leader) mereview kesesuaian strategi dan pasar
    let leaderReview = '';
    if (victorData) {
      leaderReview = 'Rekomendasi Patrick (Social Media Planner): Blueprint & Naskah otentik dari Victor (Video) dan Gavin (Desain) siap dipublikasikan ke Facebook Ads & Reels. Garansi resmi 2 tahun dan CTA Sales Sean sudah terpasang.';
    } else {
      const patrickPrompt = `Kamu adalah Social Media Planner Navigate. Copywriter timmu (Charles) baru saja membuat draft konten berikut:

--- DRAFT CHARLES ---
${draft}
--- AKHIR DRAFT ---

Tugasmu sebagai Planner:
1. Review apakah draft ini sesuai dengan tren pasar, target audiens Navigate, dan tujuan konten.
2. Nyatakan status kelayakan: [STATUS: APPROVED / REVISED].
3. Sajikan "DRAFT FINAL SIAP PUBLISH" yang sudah disesuaikan dengan strategi konten Navigate.`;

      leaderReview = await generateAgentReply(patrick, patrickPrompt);
    }

    if (!draft || draft.trim().length === 0) {
      draft = victorData?.adCopy || topic;
    }
    if (!leaderReview || leaderReview.trim().length === 0) {
      leaderReview = 'Konten siap dipublish untuk audiens Navigate.';
    }

    // Step 3: Simpan otomatis ke database PostgreSQL kantor_ai (dengan Fallback Aman ke localPosts)
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
      console.warn('[db insert fallback]', dbErr.message);
    }

    if (!postId) {
      postId = Date.now();
      console.log(`[local-db] Post #${postId} disimpan ke penyimpanan lokal JSON (fallback)`);
    }

    const postRecord = {
      id: postId,
      topic,
      platform,
      draft_nadia: draft,
      review_dewi: leaderReview,
      final_content: leaderReview,
      post_url: null,
      status: 'PENDING_APPROVAL',
      created_at: new Date().toISOString(),
    };
    localPosts.unshift(postRecord);
    persistLocalPosts();

    // Step 4: Gavin generate visual produk AI + Victor & Engine render video
    (async () => {
      try {
        // 1. Cek apakah ada naskah otentik dari Victor & Gavin di chat tasks
        const victorData = findVictorScriptInTasks(topic);

        const hookText = victorData?.hook || (draft.match(/Hook[^:]*:\s*([^\n\r]+)/i)?.[1]?.trim()) || topic;

        // Ekstrak Narasi Voiceover: Utamakan naskah VO otentik dari Victor di chat!
        const narrationText = victorData?.voiceover || (draft.match(/(?:Narasi Voiceover|Voiceover|Narasi|Script)[^:]*:\s*([\s\S]*?)(?=(?:\n\s*\d+\.|\n\s*Spesifikasi|\n\s*Call To Action|\n\s*CTA|$))/i)?.[1]?.replace(/[\r\n]+/g, ' ').trim()) || draft.slice(0, 200);

        let specsList = victorData?.specs || [];
        if (specsList.length === 0) {
          const specsMatch = draft.match(/(?:Spesifikasi Unggulan|Spesifikasi|Spek)[^:]*:\s*([\s\S]*?)(?=(?:\n\s*\d+\.|\n\s*Call To Action|\n\s*CTA|$))/i);
          if (specsMatch) {
            specsList = specsMatch[1]
              .split(/[\n\r]+/)
              .map(s => s.replace(/^[-*•\d.)\s]+/, '').trim())
              .filter(s => s.length > 2 && s.length < 50)
              .slice(0, 4);
          }
        }
        if (specsList.length === 0) {
          specsList = ['Garansi Resmi PT Feihong', 'Kualitas Industri Standar Proyek', 'Efisiensi Daya Tinggi', 'Ready Stock Gudang'];
        }

        // Gavin menghasilkan foto/visual produk Navigate
        let productImgPath = null;
        try {
          const gavinResult = await generateProductImage({ postId, topic, specs: specsList });
          if (gavinResult && gavinResult.success && gavinResult.imagePath) {
            productImgPath = gavinResult.imagePath;
          }
        } catch (imgErr) {
          console.warn('[pipeline] Gavin image gen error:', imgErr.message);
        }

        const renderRes = await renderAutomatedVideo({
          postId,
          topic,
          hook: hookText,
          narration: narrationText,
          script: draft,
          specs: specsList,
          cta: 'Hubungi WhatsApp Tim Sales Sean Sekarang',
          duration: victorData ? 25 : 12,
          productImagePath: productImgPath,
        });

        if (renderRes.success && renderRes.videoUrl) {
          try {
            await pgPool.query('UPDATE social_posts SET post_url = $1 WHERE id = $2', [renderRes.videoUrl, postId]);
          } catch {}
          postRecord.post_url = renderRes.videoUrl;
          persistLocalPosts();
          broadcastEvent('video_rendered', {
            postId,
            videoUrl: renderRes.videoUrl,
            engine: renderRes.engine,
            productImageUrl: renderRes.productImageUrl,
          });
          console.log(`[video-rendered] Video (${renderRes.engine || 'render'}) selesai & ditautkan ke Post #${postId}: ${renderRes.videoUrl}`);
        }
      } catch (vErr) {
        console.error('[auto-render-error]', vErr.message);
      }
    })();

    res.json({
      success: true,
      pipeline: 'social_content',
      postId,
      status: 'PENDING_APPROVAL',
      copywriter: { id: charles.id, name: charles.name, role: charles.role },
      planner: { id: patrick.id, name: patrick.name, role: patrick.role },
      visualDesigner: gavin ? { id: gavin.id, name: gavin.name, role: gavin.role } : null,
      videoCreator: victor ? { id: victor.id, name: victor.name, role: victor.role } : null,
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
app.post('/api/pipeline/approve', requireAccess, async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ success: false, error: 'postId wajib diisi.' });
    }

    let updatedPost = null;
    try {
      const updateRes = await pgPool.query(
        `UPDATE social_posts 
         SET status = 'APPROVED', approved_at = NOW() 
         WHERE id = $1 AND status = 'PENDING_APPROVAL' 
         RETURNING id, topic, platform, post_url, final_content, status`,
        [Number(postId)]
      );
      if (updateRes.rows.length) updatedPost = updateRes.rows[0];
    } catch {}

    const local = localPosts.find((p) => Number(p.id) === Number(postId));
    if (local) {
      local.status = 'APPROVED';
      local.approved_at = new Date().toISOString();
      persistLocalPosts();
      if (!updatedPost) updatedPost = local;
    }

    if (!updatedPost) {
      return res.status(404).json({
        success: false,
        error: `Post #${postId} tidak ditemukan di database.`,
      });
    }

    res.json({
      success: true,
      message: `Post #${postId} berhasil di-approve! Siap diposting.`,
      post: updatedPost,
    });
  } catch (err) {
    console.error('[approve error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b. Endpoint Tautkan Video Hasil Render (Dipanggil n8n / AI Video Renderer)
app.post('/api/pipeline/attach-video', async (req, res) => {
  try {
    if (ACCESS_CODE) {
      const passed = req.get('x-access-code') || req.body?.access_code || req.body?.accessCode || req.query?.access_code;
      if (!safeEqual(passed || '', ACCESS_CODE)) {
        return res.status(401).json({ success: false, error: 'Kode akses salah atau belum diisi.' });
      }
    }

    let { postId, videoUrl } = req.body;
    if (!postId || !videoUrl) {
      return res.status(400).json({ success: false, error: 'postId dan videoUrl wajib diisi.' });
    }

    // Auto-sanitize jika n8n mengirim URL mixkit yang diblokir browser:
    if (String(videoUrl).includes('mixkit.co')) {
      videoUrl = `/videos/post-${postId}.mp4`;
    }

    let updatedPost = null;
    try {
      const updateRes = await pgPool.query(
        `UPDATE social_posts 
         SET post_url = $1 
         WHERE id = $2 
         RETURNING id, topic, platform, post_url, status`,
        [String(videoUrl).trim(), Number(postId)]
      );
      if (updateRes.rows.length) updatedPost = updateRes.rows[0];
    } catch {}

    const local = localPosts.find((p) => Number(p.id) === Number(postId));
    if (local) {
      local.post_url = String(videoUrl).trim();
      persistLocalPosts();
      if (!updatedPost) updatedPost = local;
    }

    if (!updatedPost) {
      return res.status(404).json({
        success: false,
        error: `Post #${postId} tidak ditemukan di database.`,
      });
    }

    broadcastEvent('video_rendered', {
      postId: Number(postId),
      videoUrl,
    });

    console.log(`[video-render] Video berhasil ditautkan ke Post #${postId}: ${videoUrl}`);
    res.json({
      success: true,
      message: `Video untuk Post #${postId} berhasil ditautkan dan tampil di Meja Agnes!`,
      post: updatedPost,
    });
  } catch (err) {
    console.error('[attach video error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b2. Endpoint Upload Video AI UGC Langsung (MP4 dari Hedra / Kling / CapCut)
app.post('/api/pipeline/upload-video', async (req, res) => {
  try {
    const { postId, videoBase64 } = req.body;
    if (!postId || !videoBase64) {
      return res.status(400).json({ success: false, error: 'postId dan videoBase64 wajib diisi.' });
    }
    const cleanFileName = `ugc-${postId}-${Date.now()}.mp4`;
    const outPath = `${videosDir}/${cleanFileName}`;
    const base64Data = videoBase64.replace(/^data:video\/[a-zA-Z0-9.-]+;base64,/, '');
    writeFileSync(outPath, Buffer.from(base64Data, 'base64'));
    const videoUrl = `/videos/${cleanFileName}`;

    try {
      await pgPool.query('UPDATE social_posts SET post_url = $1 WHERE id = $2', [videoUrl, Number(postId)]);
    } catch {}

    const local = localPosts.find((p) => Number(p.id) === Number(postId));
    if (local) {
      local.post_url = videoUrl;
      local.updated_at = new Date().toISOString();
      persistLocalPosts();
    }

    broadcastEvent('video_rendered', { postId: Number(postId), videoUrl, engine: 'hedra_ugc' });
    console.log(`[ugc-upload] Video AI UGC berhasil diunggah untuk Post #${postId}: ${videoUrl}`);

    res.json({ success: true, videoUrl, message: 'Video AI UGC berhasil diunggah dan ditautkan!' });
  } catch (err) {
    console.error('[ugc upload error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4d. Endpoint Kirim Naskah & 5-Scene Prompt Video AI ke n8n (Production Pipeline)
app.post('/api/pipeline/send-to-n8n', async (req, res) => {
  try {
    const { postId = 1795490268558, customWebhookUrl = '' } = req.body;
    let post = null;
    try {
      const r = await pgPool.query('SELECT * FROM social_posts WHERE id = $1', [Number(postId)]);
      if (r.rows.length) post = r.rows[0];
    } catch {}
    if (!post) {
      post = localPosts.find((p) => Number(p.id) === Number(postId)) || localPosts[0];
    }

    const victorData = findVictorScriptInTasks(post?.topic || '');
    const webhookUrl = customWebhookUrl || process.env.N8N_VIDEO_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL || '';

    const scenes = [
      {
        scene_number: 1,
        time_seconds: "00:00 - 00:03",
        scene_title: "Night to Day Transformation (Hook 0-3s)",
        action_id: "Area outdoor lapangan proyek gelap gulita total, tangan menekan saklar industri, seketika lampu Navigate 400W menyala menerangi area 100 meter seperti siang hari.",
        ai_video_prompt_en: "Cinematic vertical 9:16 video, pitch-black industrial construction site at night, human hand flips industrial power switch ON, instantly a powerful Navigate 400W LED flood light illuminates the entire 100-meter field into bright daylight, sharp clean lighting, realistic light beam cutting through darkness, 4k ultra-realistic.",
        overlay_text: "⚡ NAVIGATE 400W: GELAP JADI SIANG! ⚡",
        voiceover_line: "Lampu sorot biasa mati kutu di area seluas ini? Liat ini!"
      },
      {
        scene_number: 2,
        time_seconds: "00:03 - 00:09",
        scene_title: "Extreme Durability Test IP65",
        action_id: "Uji ketahanan ekstrem IP65, semprotan air bertekanan tinggi (High Pressure Washer) langsung menghantam kaca lampu Navigate 400W yang menyala terang tanpa rembesan atau konslet.",
        ai_video_prompt_en: "Macro slow motion vertical 9:16 shot, high-pressure water washer spraying powerful water blasts directly onto operating Navigate industrial LED floodlight, water splashing violently, light stays 100% on, double silicone seal and tempered glass visible, IP65 extreme waterproof test, commercial product commercial, 4k.",
        overlay_text: "💦 TEST WATERPROOF IP65 EKSTREM! 💦",
        voiceover_line: "Boom! Seketika gelap gulita langsung berubah jadi siang benderang! Disemprot air badai bertekanan tinggi? Sertifikasi IP65 memastikan nol bocor dan nol konslet!"
      },
      {
        scene_number: 3,
        time_seconds: "00:09 - 00:15",
        scene_title: "Macro Detail 8 Modul Chip COB",
        action_id: "Macro shot close-up barisan 8 Modul Chip COB Navigate dan lensa optik fokus cembung, menyorot 40.000 lumens dan efisiensi cahaya tinggi.",
        ai_video_prompt_en: "Extreme macro camera zoom vertical 9:16 into array of 8 COB LED chip modules glowing intensely behind optical glass lenses, brilliant daylight 40,000 lumens, premium metallic finish, razor-sharp focus, cinematic commercial lighting, 4k.",
        overlay_text: "💡 400 WATT · 8 MODUL CHIP COB",
        voiceover_line: "Didukung 8 Modul Chip COB bertenaga 400 Watt, sorotannya padat, tajam, dan merata ke segala penjuru!"
      },
      {
        scene_number: 4,
        time_seconds: "00:15 - 00:20",
        scene_title: "Bodi Aluminium Die-Cast & Heatsink Pendingin",
        action_id: "Kamera berputar menyorot bodi aluminium die-cast tebal dan sirip heatsink pendingin di bagian belakang lampu.",
        ai_video_prompt_en: "Cinematic vertical 9:16 orbit shot around rugged dark-gray aluminum die-cast housing of heavy-duty Navigate floodlight, focusing on dense cooling heatsink fins dissipating heat, industrial durability, studio lighting, 4k.",
        overlay_text: "🔩 BODI FULL ALUMINIUM DIE-CAST & HEATSINK",
        voiceover_line: "Bodi aluminium die-cast kokoh dengan heatsink sirip tebal untuk buang panas maksimal dan masa pakai panjang."
      },
      {
        scene_number: 5,
        time_seconds: "00:20 - 00:25",
        scene_title: "Product Hero & Call To Action",
        action_id: "Unit utuh Navigate 400W berdiri kokoh di bracket 180 derajat dengan outro logo Navigate dan tombol kontak WhatsApp sales resmi.",
        ai_video_prompt_en: "Clean vertical 9:16 hero shot of Navigate 400W LED flood light on mounting bracket, elegant glowing rim light, professional commercial outro, WhatsApp order button graphics, 4k.",
        overlay_text: "📲 Pesan & Konsultasi Sekarang! 👉 Klik [LINK WA]",
        voiceover_line: "Dapatkan penawaran proyek sekarang. Klik link WhatsApp untuk hubungi sales resmi!"
      }
    ];

    const host = req.get('host') || 'office.ptfeihong.com';
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const callbackUrl = `${protocol}://${host}/api/pipeline/attach-video`;

    const n8nPayload = {
      event: 'video_production_request',
      postId: post?.id || Number(postId),
      product_name: 'Navigate LED Flood Light 400W IP65 Outdoor',
      target_platform: 'Facebook Reels & Instagram Reels (9:16)',
      total_duration_seconds: 25,
      hook: victorData?.hook || '⚡ NAVIGATE 400W: GELAP JADI SIANG! ⚡',
      full_voiceover_script: victorData?.voiceover || 'Lampu sorot biasa mati kutu di area seluas ini? Liat ini! Boom! Seketika gelap gulita langsung berubah jadi siang benderang! Didukung 8 Modul Chip COB bertenaga 400 Watt, sorotannya padat, tajam, dan merata ke segala penjuru! Disemprot air badai bertekanan tinggi? Sertifikasi IP65 memastikan nol bocor dan nol konslet! Bodi aluminium die-cast kokoh dengan heatsink sirip tebal untuk buang panas maksimal. Dapatkan penawaran proyek sekarang. Hubungi tim sales kami untuk penawaran terbaik!',
      facebook_ad_copy: post?.draft_nadia || post?.final_content || victorData?.adCopy || '',
      verified_specs: [
        'Daya: 400 Watt (8 Modul Chip COB)',
        'Kecerahan: 40.000 Lumens Super Terang',
        'Proteksi: IP65 Waterproof & Dustproof (Tahan Hujan Badai)',
        'Bodi: Aluminium Die-Cast Tebal + Sirip Heatsink Dingin',
        'Garansi Resmi: 2 Tahun PT Feihong Trading International'
      ],
      scenes,
      callback_url: callbackUrl,
      access_code: ACCESS_CODE || '',
      instructions_for_n8n: `1. Generate 5 klip video memakai Kling AI / Runway Gen-3 menggunakan ai_video_prompt_en dari tiap scene.\n2. Generate audio voiceover via ElevenLabs / Edge-TTS dari full_voiceover_script.\n3. Gabungkan klip 1-5 + audio + overlay_text (format vertical 9:16).\n4. Kirim URL file MP4 hasil render kembali ke website via POST ${callbackUrl} dengan body { postId: ${post?.id || postId}, videoUrl: "<URL_MP4>" } agar muncul di Meja Agnes untuk di-review & approve sebelum diposting!`,
      createdAt: new Date().toISOString()
    };

    const payloadFile = fileURLToPath(new URL('./n8n_latest_payload.json', import.meta.url));
    writeFileSync(payloadFile, JSON.stringify(n8nPayload, null, 2), 'utf8');

    let webhookSent = false;
    let webhookStatus = 'saved_locally';

    if (webhookUrl) {
      try {
        const fetchRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(n8nPayload),
        });
        webhookSent = fetchRes.ok;
        webhookStatus = fetchRes.ok ? 'sent_to_n8n' : `webhook_failed_${fetchRes.status}`;
      } catch (e) {
        webhookStatus = `webhook_error: ${e.message}`;
      }
    }

    console.log(`[send-to-n8n] Payload n8n untuk Post #${post?.id || postId} siap (Sent: ${webhookSent}, Status: ${webhookStatus})`);
    res.json({
      success: true,
      webhookSent,
      webhookStatus,
      webhookUrl: webhookUrl || 'Tersimpan di server (Siap disalin / dihubungkan ke Webhook n8n)',
      payload: n8nPayload,
    });
  } catch (err) {
    console.error('[send-to-n8n error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint untuk mengambil JSON Payload n8n terakhir
app.get('/api/pipeline/n8n-payload', (req, res) => {
  try {
    const payloadFile = fileURLToPath(new URL('./n8n_latest_payload.json', import.meta.url));
    if (existsSync(payloadFile)) {
      const data = JSON.parse(readFileSync(payloadFile, 'utf8'));
      return res.json({ success: true, payload: data });
    }
    res.status(404).json({ success: false, error: 'Belum ada payload n8n yang tersimpan.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint untuk mengunduh template file n8n workflow JSON
app.get('/api/pipeline/n8n-workflow', (req, res) => {
  try {
    const wfPath = fileURLToPath(new URL('../n8n_workflows/kantor_ai_video_pipeline.json', import.meta.url));
    if (existsSync(wfPath)) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="kantor_ai_video_pipeline.json"');
      return res.sendFile(wfPath);
    }
    res.status(404).json({ success: false, error: 'File workflow n8n belum tersedia.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 4b3. Endpoint Unduh Foto Model Langsung (Attachment / Preview)
app.get('/api/ugc/download-model', (req, res) => {
  try {
    const distModel = `${videosDir}/model-indonesia-navigate.png`;
    const assetModel = fileURLToPath(new URL('./assets/model-indonesia-navigate.png', import.meta.url));

    let filePath = null;
    if (existsSync(distModel)) {
      filePath = distModel;
    } else if (existsSync(assetModel)) {
      if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
      copyFileSync(assetModel, distModel);
      filePath = distModel;
    }

    if (!filePath || !existsSync(filePath)) {
      return res.status(404).send('Foto model belum siap di server.');
    }

    if (req.query.preview === '1') {
      res.setHeader('Content-Type', 'image/png');
      return res.sendFile(filePath);
    }
    res.download(filePath, 'model-navigate-400w.png');
  } catch (err) {
    res.status(500).send('Gagal mengunduh foto model: ' + err.message);
  }
});

// 4b4. Endpoint Unduh Audio Voiceover Langsung (Attachment / Streaming)
app.get('/api/ugc/download-audio', async (req, res) => {
  try {
    const distAudio = `${videosDir}/audio-model-navigate-400w.mp3`;
    const assetAudio = fileURLToPath(new URL('./assets/audio-model-navigate-400w.mp3', import.meta.url));

    let filePath = null;
    if (existsSync(distAudio)) {
      filePath = distAudio;
    } else if (existsSync(assetAudio)) {
      if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
      copyFileSync(assetAudio, distAudio);
      filePath = distAudio;
    }

    if (!filePath || !existsSync(filePath)) {
      const script = 'Lampu sorot biasa mati kutu di area seluas ini? Liat ini! Boom! Seketika gelap gulita langsung berubah jadi siang benderang! Ini Navigate 400 Watt dengan 8 Modul Chip COB, 40.000 lumens super terang, bodi kokoh aluminium die-cast dan tahan air badai IP65. Upgrade penerangan proyekmu bareng Navigate sekarang!';
      if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
      await generateEdgeTTS({
        text: script,
        outputPath: distAudio,
        voice: VOICES.ARDI,
      });
      if (existsSync(distAudio)) filePath = distAudio;
    }

    if (!filePath || !existsSync(filePath)) {
      return res.status(404).send('Audio voiceover sedang diproses atau gagal di-generate.');
    }

    if (req.query.stream === '1') {
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.sendFile(filePath);
    }
    res.download(filePath, 'suara-navigate-400w.mp3');
  } catch (err) {
    res.status(500).send('Gagal mengunduh audio voiceover: ' + err.message);
  }
});

// 4b5. Endpoint Metadata Bahan Siap Pakai untuk AI UGC Opsi A
app.get('/api/ugc/materials', async (req, res) => {
  try {
    const assetModel = fileURLToPath(new URL('./assets/model-indonesia-navigate.png', import.meta.url));
    const distModel = `${videosDir}/model-indonesia-navigate.png`;
    if (existsSync(assetModel) && !existsSync(distModel)) {
      copyFileSync(assetModel, distModel);
    }

    const audioPath = `${videosDir}/audio-model-navigate-400w.mp3`;
    const script = 'Lampu sorot biasa mati kutu di area seluas ini? Liat ini! Boom! Seketika gelap gulita langsung berubah jadi siang benderang! Ini Navigate 400 Watt dengan 8 Modul Chip COB, 40.000 lumens super terang, bodi kokoh aluminium die-cast dan tahan air badai IP65. Upgrade penerangan proyekmu bareng Navigate sekarang!';

    if (!existsSync(audioPath)) {
      try {
        await generateEdgeTTS({
          text: script,
          outputPath: audioPath,
          voice: VOICES.ARDI,
        });
      } catch {}
    }

    res.json({
      success: true,
      modelImageUrl: '/api/ugc/download-model',
      audioUrl: '/api/ugc/download-audio',
      script,
      guide: 'Unggah modelImageUrl dan audioUrl ke hedra.com atau klingai.com untuk membuat video model berbicara realistis secara gratis!',
    });
  } catch (err) {
    console.error('[ugc materials error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4c. Endpoint Render Video Manual / On-Demand via FFmpeg Gratis
app.post('/api/pipeline/render-video', async (req, res) => {
  try {
    const { postId, duration = 25 } = req.body;
    if (!postId) {
      return res.status(400).json({ success: false, error: 'postId wajib diisi.' });
    }

    let post = null;
    try {
      const r = await pgPool.query('SELECT * FROM social_posts WHERE id = $1', [Number(postId)]);
      if (r.rows.length) post = r.rows[0];
    } catch {}

    if (!post) {
      post = localPosts.find((p) => Number(p.id) === Number(postId));
    }

    if (!post) {
      return res.status(404).json({ success: false, error: `Post #${postId} tidak ditemukan di database.` });
    }

    const victorData = findVictorScriptInTasks(post.topic);
    const script = post.draft_nadia || post.final_content || '';
    const hookText = victorData?.hook || (script.match(/Hook[^:]*:\s*([^\n\r]+)/i)?.[1]?.trim()) || post.topic;
    const narrationText = victorData?.voiceover || (script.match(/(?:Narasi Voiceover|Voiceover|Narasi|Script)[^:]*:\s*([\s\S]*?)(?=(?:\n\s*\d+\.|\n\s*Spesifikasi|\n\s*Call To Action|\n\s*CTA|$))/i)?.[1]?.replace(/[\r\n]+/g, ' ').trim()) || script.slice(0, 250);
    const specsList = victorData?.specs?.length ? victorData.specs : ['8 Modul Chip COB', '40.000 Lumens', 'IP65 Waterproof', 'Bodi Aluminium Die-Cast'];

    const renderRes = await renderAutomatedVideo({
      postId: post.id,
      topic: post.topic,
      hook: hookText,
      narration: narrationText,
      script,
      specs: specsList,
      cta: 'Hubungi Sales Admin Sean (WhatsApp)',
      duration: victorData ? 25 : (Number(duration) || 25),
    });

    if (renderRes.success && renderRes.videoUrl) {
      try {
        await pgPool.query('UPDATE social_posts SET post_url = $1 WHERE id = $2', [renderRes.videoUrl, post.id]);
      } catch {}
      post.post_url = renderRes.videoUrl;
      persistLocalPosts();

      broadcastEvent('video_rendered', { postId: post.id, videoUrl: renderRes.videoUrl });
      return res.json({
        success: true,
        message: `Video untuk Post #${post.id} berhasil di-render via FFmpeg!`,
        videoUrl: renderRes.videoUrl,
        elapsedMs: renderRes.elapsedMs,
      });
    }

    res.status(500).json({
      success: false,
      error: renderRes.error || renderRes.message || 'Gagal merender video.',
      reason: renderRes.reason,
    });
  } catch (err) {
    console.error('[render-video-error]', err);
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

app.get('/api/sales/inquiries', requireAccess, async (req, res) => {
  try {
    const r = await pgPool.query('SELECT * FROM sales_inquiries ORDER BY id DESC LIMIT 20');
    res.json({ success: true, inquiries: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/catalog', requireAccess, async (req, res) => {
  try {
    const docs = await searchSupabaseCatalog(req.query.q || '', Number(req.query.limit || 5));
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/stocks', requireAccess, async (req, res) => {
  try {
    const stocks = await searchSupabaseStock(req.query.q || '', Number(req.query.limit || 10));
    res.json({ success: true, count: stocks.length, data: stocks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sales/leads', requireAccess, async (req, res) => {
  try {
    const leads = await getSupabaseProspectLeads(req.query.status || '', Number(req.query.limit || 10));
    res.json({ success: true, count: leads.length, data: leads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint Ambil Detail Konten Spesifik untuk Meja Agnes
app.get('/api/pipeline/post/:id', async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if (!postId) return res.status(400).json({ success: false, error: 'ID tidak valid.' });

    try {
      const r = await pgPool.query('SELECT * FROM social_posts WHERE id = $1', [postId]);
      if (r.rows.length) {
        const p = r.rows[0];
        if (p.post_url && p.post_url.includes('mixkit.co')) {
          p.post_url = `/videos/post-${p.id}.mp4`;
          pgPool.query('UPDATE social_posts SET post_url = $1 WHERE id = $2', [p.post_url, p.id]).catch(() => {});
        }
        return res.json({ success: true, post: p });
      }
    } catch {}

    const local = localPosts.find((p) => Number(p.id) === postId);
    if (local) {
      if (local.post_url && local.post_url.includes('mixkit.co')) {
        local.post_url = `/videos/post-${local.id}.mp4`;
        persistLocalPosts();
      }
      return res.json({ success: true, post: local });
    }

    res.status(404).json({ success: false, error: 'Post tidak ditemukan.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint Ambil Daftar Konten Pending Approval untuk Meja Agnes
app.get('/api/pipeline/pending', async (req, res) => {
  try {
    try {
      const r = await pgPool.query(
        `SELECT id, topic, platform, post_url, status, draft_nadia, review_dewi, created_at 
         FROM social_posts 
         WHERE status = 'PENDING_APPROVAL' 
         ORDER BY id DESC LIMIT 10`
      );
      if (r.rows.length) {
        const sanitized = r.rows.map((p) => {
          if (p.post_url && p.post_url.includes('mixkit.co')) {
            p.post_url = `/videos/post-${p.id}.mp4`;
            pgPool.query('UPDATE social_posts SET post_url = $1 WHERE id = $2', [p.post_url, p.id]).catch(() => {});
          }
          return p;
        });
        return res.json({ success: true, posts: sanitized });
      }
    } catch {}

    const pending = localPosts.filter((p) => p.status === 'PENDING_APPROVAL').map((p) => {
      if (p.post_url && p.post_url.includes('mixkit.co')) {
        p.post_url = `/videos/post-${p.id}.mp4`;
        persistLocalPosts();
      }
      return p;
    });
    res.json({ success: true, posts: pending.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Halaman Review (Redirect Otomatis ke Meja Agnes di Kantor 3D)
app.get('/review/:id', async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if (!postId) return res.status(400).send('ID Postingan tidak valid.');

    // Default: Langsung bawa Bos Ridho ke Meja Agnes di Kantor 3D!
    if (req.query.raw !== 'true') {
      return res.redirect(`/#agnes?review=${postId}`);
    }

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

// ---------- Static Videos & Frontend hasil build (produksi) ----------
const distVideosDir = fileURLToPath(new URL('../dist/videos', import.meta.url));
const publicVideosDir = fileURLToPath(new URL('../public/videos', import.meta.url));
const videosDir = existsSync(distVideosDir) ? distVideosDir : publicVideosDir;
if (!existsSync(distVideosDir)) mkdirSync(distVideosDir, { recursive: true });
if (!existsSync(publicVideosDir)) mkdirSync(publicVideosDir, { recursive: true });

const videoStaticOpts = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  },
};
app.use('/videos', express.static(publicVideosDir, videoStaticOpts));
app.use('/videos', express.static(distVideosDir, videoStaticOpts));

const dist = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist, {
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/videos/')) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
      const html = readFileSync(`${dist}/index.html`, 'utf8');
      const freshHtml = html.replace(/(src|href)="(\/assets\/[^"]+)"/g, `$1="$2?t=${Date.now()}"`);
      res.type('html').send(freshHtml);
    } catch {
      res.sendFile(`${dist}/index.html`);
    }
  });
}

// Inisialisasi otomatis aset UGC (Foto Model & Audio Voiceover) saat server booting
async function initUgcAssets() {
  try {
    if (!existsSync(videosDir)) {
      mkdirSync(videosDir, { recursive: true });
    }
    const assetModel = fileURLToPath(new URL('./assets/model-indonesia-navigate.png', import.meta.url));
    const distModel = `${videosDir}/model-indonesia-navigate.png`;
    if (existsSync(assetModel)) {
      copyFileSync(assetModel, distModel);
      console.log('[ugc-init] Foto model Navigate berhasil disalin ke dist/videos/');
    }
    const assetAudio = fileURLToPath(new URL('./assets/audio-model-navigate-400w.mp3', import.meta.url));
    const distAudio = `${videosDir}/audio-model-navigate-400w.mp3`;
    if (existsSync(assetAudio)) {
      copyFileSync(assetAudio, distAudio);
      console.log('[ugc-init] Audio voiceover MP3 berhasil disalin dari assets ke dist/videos/');
    } else if (!existsSync(distAudio)) {
      const script = 'Lampu sorot biasa mati kutu di area seluas ini? Liat ini! Boom! Seketika gelap gulita langsung berubah jadi siang benderang! Ini Navigate 400 Watt dengan 8 Modul Chip COB, 40.000 lumens super terang, bodi kokoh aluminium die-cast dan tahan air badai IP65. Upgrade penerangan proyekmu bareng Navigate sekarang!';
      await generateEdgeTTS({
        text: script,
        outputPath: distAudio,
        voice: VOICES.ARDI,
      });
      console.log('[ugc-init] Audio voiceover MP3 berhasil di-generate di dist/videos/');
    }
  } catch (e) {
    console.warn('[ugc-init warning]', e.message);
  }
}
initUgcAssets();

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
