import './style.css';
import { DIVISIONS, agentById, divisionById } from '../shared/roster.js';
import { createStage } from './stage.js';
import { createTags } from './tags.js';
import { createPanel } from './panel.js';
import { fetchConfig, getCode, setCode, getHistory, setHistory } from './chat.js';
import { PITCH_X, PITCH_Z } from './office.js';

const $ = (id) => document.getElementById(id);
const mobile = matchMedia('(max-width: 760px)');

const config = { demo: false, needsCode: false, offline: false };

// ---------- scene ----------
const stage = createStage($('scene'));
const tags = createTags(stage, $('tags'));
const { byId, rooms } = stage.office;

// ---------- state tampilan ----------
let selectedId = null;
let view = { kind: 'overview', id: null };
const doneTimers = new Map();

// ---------- chips divisi ----------
const chipsEl = $('chips');
const chipDefs = [
  { id: 'overview', label: 'Seluruh kantor', color: '#1d2433' },
  ...DIVISIONS.map((d) => ({ id: d.id, label: d.name, color: d.color })),
  { id: 'pantry', label: 'Pantry', color: '#e08e5a' },
];
for (const c of chipDefs) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.dataset.id = c.id;
  b.style.setProperty('--c', c.color);
  b.innerHTML = c.id === 'overview' ? '' : '<span class="dot"></span>';
  b.append(c.label);
  b.addEventListener('click', () => goTo(c.id));
  chipsEl.appendChild(b);
}

function markChip(id) {
  for (const b of chipsEl.children) b.setAttribute('aria-pressed', String(b.dataset.id === id));
  const active = chipsEl.querySelector(`[aria-pressed="true"]`);
  active?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function goTo(id) {
  if (selectedId) closeChat(false);
  if (id === 'overview') {
    stage.focus('overview');
    view = { kind: 'overview', id: null };
  } else if (id === 'pantry') {
    stage.focus('room', PITCH_X, PITCH_Z);
    view = { kind: 'pantry', id };
  } else {
    const r = rooms.get(id);
    stage.focus('room', r.center.x, r.center.z);
    view = { kind: 'room', id };
  }
  markChip(id);
  history.replaceState(null, '', location.pathname + location.search);
}

// ---------- panel chat ----------
function setInset() {
  if (!selectedId) return stage.setInset(0, 0);
  const el = $('panel');
  if (mobile.matches) stage.setInset(0, el.offsetHeight);
  else stage.setInset(el.offsetWidth + 24, 0);
}

function setStatus(id, status) {
  const c = byId.get(id);
  if (!c) return;
  clearTimeout(doneTimers.get(id));
  c.status = status;
  if (status === 'done') {
    doneTimers.set(id, setTimeout(() => { if (c.status === 'done') c.status = 'idle'; }, 5000));
  }
}

const panel = createPanel({
  onSelect: (id) => selectAgent(id),
  onClose: () => closeChat(true),
  onStatus: setStatus,
  onNeedCode: () => showGate('Kode akses salah atau belum diisi.'),
  isDemo: () => config.demo,
});

function selectAgent(id) {
  const agent = agentById(id);
  const c = byId.get(id);
  if (!agent || !c) return;
  if (selectedId && selectedId !== id) byId.get(selectedId).selected = false;

  selectedId = id;
  c.selected = true;
  c.wave();
  const div = divisionById(agent.division);

  document.body.classList.add('chatting');
  $('panel').setAttribute('aria-hidden', 'false');
  panel.open(id);
  const room = rooms.get(agent.division).center;
  stage.focus('agent', room.x + c.home.x, room.z + c.home.z + 0.9);
  stage.setRing(c, div.color);
  tags.setSelected(id);
  view = { kind: 'room', id: agent.division };
  markChip(agent.division);
  requestAnimationFrame(setInset);
  history.replaceState(null, '', `#${id}`);
}

function closeChat(refocus) {
  if (!selectedId) return;
  const c = byId.get(selectedId);
  const div = divisionById(c.agent.division);
  c.selected = false;
  selectedId = null;
  panel.close();
  document.body.classList.remove('chatting');
  $('panel').setAttribute('aria-hidden', 'true');
  stage.setRing(null);
  tags.setSelected(null);
  stage.setInset(0, 0);
  if (refocus) {
    const r = rooms.get(div.id);
    stage.focus('room', r.center.x, r.center.z);
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// ---------- input scene ----------
stage.onClick((id) => {
  if (id) selectAgent(id);
  else if (selectedId && mobile.matches) closeChat(true);
});
let lastHoveredId = null;
stage.onHover((id) => {
  tags.setHovered(id);
  if (id && id !== lastHoveredId) {
    const c = byId.get(id);
    if (c && !c.action && c.status === 'idle') {
      c.wave();
    }
  }
  lastHoveredId = id;
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedId) closeChat(true);
});
addEventListener('resize', () => requestAnimationFrame(setInset));
mobile.addEventListener?.('change', () => requestAnimationFrame(setInset));

// ---------- gate kode akses ----------
function showGate(msg) {
  $('gate').hidden = false;
  const err = $('gate-error');
  err.hidden = !msg;
  err.textContent = msg || '';
  setTimeout(() => $('gate-input').focus(), 50);
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('gate-input').value.trim();
  if (!code) return;
  try {
    const r = await fetch('/api/verify', { headers: { 'x-access-code': code } });
    if (r.ok) {
      setCode(code);
      $('gate').hidden = true;
      $('gate-input').value = '';
      return;
    }
    showGate(r.status === 401 ? 'Kode salah.' : 'Server menolak. Coba lagi.');
  } catch {
    showGate('Tidak bisa menghubungi server.');
  }
});

// ---------- start ----------
(async function start() {
  const cfg = await fetchConfig();
  Object.assign(config, cfg);

  const banner = $('banner');
  if (config.offline) {
    banner.hidden = false;
    banner.textContent = 'Backend belum jalan. Jalankan "npm run dev" atau "npm start" agar chat bisa dipakai.';
  } else if (config.demo) {
    banner.textContent = 'Mode demo: server belum punya ANTHROPIC_API_KEY, jadi jawaban hanya contoh.';
  }
  banner.hidden = !(config.offline || (config.demo && selectedId));
  if (config.needsCode && !getCode()) showGate('');

  // buka karyawan dari URL, mis. https://office.domain.com/#agnes?review=12
  const rawHash = location.hash.slice(1);
  const hashId = decodeURIComponent(rawHash.split('?')[0]);
  if (hashId && byId.has(hashId)) selectAgent(hashId);
  else goTo('overview');

  const hide = () => {
    if (stage.frames < 3) return requestAnimationFrame(hide);
    $('loading').classList.add('gone');
    setTimeout(() => $('loading').remove(), 900);
  };
  hide();

  // ---------- Task Persistence & Activity Monitor ----------
  const KEY_TASKS = 'kantorai.tasks.v1';
  function getTasks() {
    try { return JSON.parse(localStorage.getItem(KEY_TASKS) || '[]'); } catch { return []; }
  }
  function saveTasks(list) {
    try { localStorage.setItem(KEY_TASKS, JSON.stringify(list.slice(0, 30))); } catch {}
    updateTasksUI();
  }

  function updateTasksUI() {
    const list = getTasks();
    const badge = $('tasks-badge');
    const workingCount = list.filter((t) => t.status === 'working').length;
    if (badge) {
      if (workingCount > 0) {
        badge.hidden = false;
        badge.textContent = `${workingCount} proses`;
        badge.style.background = '#ea580c';
      } else if (list.length > 0) {
        badge.hidden = false;
        badge.textContent = `${list.length}`;
        badge.style.background = '#2563eb';
      } else {
        badge.hidden = true;
      }
    }

    const container = $('tasks-list');
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="tasks-empty">Belum ada aktivitas tugas antar-karyawan.</div>';
      return;
    }

    container.innerHTML = list.map((t) => `
      <div class="task-item ${t.status}">
        <div class="task-item-head">
          <strong style="color:${t.status === 'working' ? '#ea580c' : '#16a34a'};">
            ${t.status === 'working' ? '⚙️ Sedang Dikerjakan' : '✅ Selesai'} · ${t.toName} (${t.toRole})
          </strong>
          <span style="color:var(--ink-soft);">${new Date(t.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="task-item-desc">
          <b>Dari ${t.fromName}:</b> "${(t.task || '').slice(0, 110)}..."
        </div>
        <div class="task-item-foot">
          <span style="color:var(--ink-soft);">${t.status === 'done' ? 'Hasil tersimpan di meja' : 'Karakter sedang mengetik'}</span>
          <button type="button" data-task-open="${t.toId}" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">Buka Meja ${t.toName} ➔</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-task-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('tasks-modal').hidden = true;
        selectAgent(btn.dataset.taskOpen);
      });
    });
  }

  $('btn-tasks')?.addEventListener('click', () => {
    $('tasks-modal').hidden = false;
    updateTasksUI();
    fetchServerTasks();
  });
  $('btn-close-tasks')?.addEventListener('click', () => {
    $('tasks-modal').hidden = true;
  });
  $('tasks-backdrop')?.addEventListener('click', () => {
    $('tasks-modal').hidden = true;
  });

  async function fetchServerTasks() {
    try {
      const res = await fetch('/api/agent/tasks');
      if (!res.ok) return;
      const data = await res.json();
      if (data.tasks && data.tasks.length > 0) {
        for (const t of data.tasks) {
          if (t.status === 'done' && t.result) {
            const h = getHistory(t.toId);
            const userPrompt = `[Tugas Delegasi dari ${t.fromName} (${t.fromRole || 'Rekan'})]:\n${t.task}`;
            if (!h.some((m) => m.content === t.result)) {
              setHistory(t.toId, [
                ...h,
                { role: 'user', content: userPrompt },
                { role: 'assistant', content: t.result },
              ]);
            }
          }
        }
        saveTasks(data.tasks);
        updateTasksUI();
        if (selectedId && data.tasks.some((t) => t.toId === selectedId && t.status === 'done')) {
          panel.open(selectedId);
        }
      }
    } catch {}
  }

  updateTasksUI();
  fetchServerTasks();

  // ---------- Live Events (Inquiry Sales Sean & WhatsApp) ----------
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'agent_task_start') {
          const target = byId.get(data.toId);
          if (target) {
            target.status = 'working';
            target.customTag = `tugas dari ${data.fromName}…`;
            target.wave();
          }

          const tasks = getTasks();
          const taskObj = {
            id: `task-${Date.now()}`,
            fromId: data.fromId,
            fromName: data.fromName,
            toId: data.toId,
            toName: data.toName,
            toRole: data.toRole,
            task: data.task,
            status: 'working',
            createdAt: Date.now(),
          };
          saveTasks([taskObj, ...tasks.filter((t) => !(t.toId === data.toId && t.status === 'working'))]);

          const banner = $('banner');
          banner.hidden = false;
          banner.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:20px;display:inline-block;animation:spin 2s linear infinite;">⚡</span>
                <div>
                  <strong style="color:#60a5fa;">Tugas Diteruskan ke ${data.toName} (${data.toRole})</strong><br>
                  <span style="font-size:12px;color:#cbd5e1;">${data.toName} sedang memproses instruksi dari <b>${data.fromName}</b> di mejanya...</span>
                </div>
              </div>
            </div>
          `;
        }

        if (data.type === 'agent_task_done') {
          const target = byId.get(data.toId);
          if (target) {
            target.status = 'done';
            target.customTag = 'tugas selesai!';
            setTimeout(() => {
              if (target.status === 'done') {
                target.status = 'idle';
                target.customTag = null;
              }
            }, 15000);
          }

          const tasks = getTasks();
          const updated = tasks.map((t) => {
            if (t.toId === data.toId && t.status === 'working') {
              return { ...t, status: 'done', completedAt: Date.now() };
            }
            return t;
          });
          saveTasks(updated);

          if (data.result) {
            const h = getHistory(data.toId);
            setHistory(data.toId, [
              ...h,
              { role: 'user', content: `[Tugas Delegasi dari ${data.fromName} (${data.fromRole || 'Rekan'})]:\n${data.task}` },
              { role: 'assistant', content: data.result },
            ]);
            // Jika chat target sedang dibuka, update tampilannya
            if (selectedId === data.toId) {
              panel.open(data.toId);
            }
          }

          // Jika chat pengirim (misal Patrick) sedang aktif, sisipkan kartu notifikasi di dalam percakapan
          if (selectedId === data.fromId) {
            const msgs = $('messages');
            if (msgs) {
              const card = document.createElement('div');
              card.style.cssText = 'margin:12px 0;padding:12px 14px;background:#f0fdf4;border:1px solid #86efac;border-radius:14px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:10px;box-shadow:0 4px 12px rgba(22,163,74,0.12);';
              card.innerHTML = `
                <div>
                  <b style="color:#166534;">🎬 ${data.toName} telah menyelesaikan tugas!</b><br>
                  <span style="color:#15803d;font-size:12px;">Hasil storyboard/draft sudah siap.</span>
                </div>
                <button type="button" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">Lihat Hasil ${data.toName} ➔</button>
              `;
              card.querySelector('button')?.addEventListener('click', () => {
                selectAgent(data.toId);
              });
              msgs.appendChild(card);
              msgs.scrollTop = msgs.scrollHeight;
            }
          }

          const banner = $('banner');
          banner.hidden = false;
          banner.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:22px;">🎬</span>
                <div>
                  <strong style="color:#4ade80;">Tugas Selesai dari ${data.toName} (${data.toRole})!</strong><br>
                  <span style="font-size:12px;color:#cbd5e1;">Ditugaskan oleh <b>${data.fromName}</b>: "${data.task.slice(0, 50)}..."</span>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex:none;">
                <button id="btn-open-task-result" type="button" style="background:#2563eb;color:#fff;border:none;border-radius:10px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 4px 12px rgba(37,99,235,0.4);">Lihat Hasil ${data.toName} ➔</button>
                <button id="btn-close-banner" type="button" style="background:transparent;color:#94a3b8;border:none;font-size:18px;cursor:pointer;padding:4px 8px;">✕</button>
              </div>
            </div>
          `;
          $('btn-open-task-result')?.addEventListener('click', () => {
            banner.hidden = true;
            selectAgent(data.toId);
          });
          $('btn-close-banner')?.addEventListener('click', () => {
            banner.hidden = true;
          });
        }

        if (data.type === 'sales_inquiry') {
          const sean = byId.get('sean');
          if (sean) {
            sean.status = 'working';
            sean.wave();
            setTimeout(() => {
              if (sean.status === 'working') {
                sean.status = 'done';
                setTimeout(() => {
                  if (sean.status === 'done') sean.status = 'idle';
                }, 8000);
              }
            }, 12000);
          }

          if (data.quoteDraft) {
            const h = getHistory('sean');
            setHistory('sean', [
              ...h,
              { role: 'user', content: `[Inquiry dari ${data.customerName} (${data.customerPhone || 'WA'})]:\n${data.message}` },
              { role: 'assistant', content: data.quoteDraft },
            ]);
          }

          const banner = $('banner');
          banner.hidden = false;
          banner.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div>
                <strong>🔔 Permintaan Harga Masuk!</strong><br>
                <span><b>${data.customerName}</b> (${data.customerPhone || 'WA'}): "${data.message.slice(0, 80)}"</span>
              </div>
              <button id="btn-open-sean" type="button" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">Lihat Penawaran ➔</button>
            </div>
          `;
          $('btn-open-sean')?.addEventListener('click', () => {
            banner.hidden = true;
            selectAgent('sean');
          });
        }
      } catch (err) {}
    };
  } catch (err) {}
})();

window.__kantor = { stage, selectAgent, goTo };
