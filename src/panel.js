import { agentById, agentsOf, divisionById } from '../shared/roster.js';
import { renderMarkdown } from './md.js';
import { getHistory, setHistory, clearHistory, streamChat, getCode } from './chat.js';

const $ = (id) => document.getElementById(id);
const initials = (name) => name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export function createPanel({ onSelect, onClose, onStatus, onNeedCode, isDemo }) {
  const els = {
    avatar: $('avatar'),
    name: $('who-name'),
    role: $('who-role'),
    mates: $('mates'),
    messages: $('messages'),
    quick: $('quick'),
    form: $('composer'),
    input: $('input'),
    send: $('btn-send'),
    reset: $('btn-reset'),
    close: $('btn-close'),
  };

  let currentId = null;
  const live = new Map(); // agentId -> { text, el, abort }

  const scrollDown = (force = false) => {
    const m = els.messages;
    const near = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
    if (force || near) m.scrollTop = m.scrollHeight;
  };

  function bubble(role, html, { text } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const b = document.createElement('div');
    b.className = 'bubble';
    if (role === 'user') b.textContent = text;
    else b.innerHTML = html;
    wrap.appendChild(b);
    if (role === 'assistant') {
      const tools = document.createElement('div');
      tools.className = 'tools';
      tools.innerHTML = '<button type="button" data-copy>Salin</button>';
      wrap.appendChild(tools);
    }
    return wrap;
  }

  const typingHtml = '<span class="typing" aria-label="Sedang mengetik"><i></i><i></i><i></i></span>';

  function paint(l) {
    if (!l.el) return;
    const b = l.el.querySelector('.bubble');
    b.innerHTML = l.text ? renderMarkdown(l.text) : typingHtml;
    scrollDown();
  }

  function renderEmpty(agent) {
    const first = agent.name.split(' ')[0];
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = `<b>Halo, gue ${first}</b>${agent.role}. Tanya soal ${agent.focus}.`;
    els.messages.appendChild(e);
    els.quick.innerHTML = '';
    for (const q of agent.quick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q';
      btn.textContent = q;
      btn.addEventListener('click', () => submit(q));
      els.quick.appendChild(btn);
    }
  }

  function render(agentId) {
    const agent = agentById(agentId);
    const div = divisionById(agent.division);
    document.body.style.setProperty('--c', div.color);
    els.avatar.style.setProperty('--c', div.color);
    els.avatar.textContent = initials(agent.name);
    els.name.textContent = agent.name;
    els.role.textContent = agent.role === div.name ? agent.role : `${agent.role} · ${div.name}`;

    // rekan satu divisi
    els.mates.innerHTML = '';
    const team = agentsOf(agent.division);
    if (team.length > 1) {
      for (const m of team) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mate';
        b.style.setProperty('--c', div.color);
        b.setAttribute('aria-current', String(m.id === agentId));
        b.innerHTML = `<i>${initials(m.name)}</i>${m.name.split(' ')[0]}`;
        b.addEventListener('click', () => onSelect(m.id));
        els.mates.appendChild(b);
      }
    }

    els.messages.innerHTML = '';
    els.quick.innerHTML = '';
    const history = getHistory(agentId);
    const l = live.get(agentId);
    if (!history.length && !l) renderEmpty(agent);
    for (const m of history) {
      els.messages.appendChild(m.role === 'user' ? bubble('user', '', { text: m.content }) : bubble('assistant', renderMarkdown(m.content)));
    }
    if (l) {
      l.el = bubble('assistant', typingHtml);
      els.messages.appendChild(l.el);
      paint(l);
    }
    if (agentId === 'agnes') {
      loadAgnesReviewCard();
    }
    scrollDown(true);
    syncSend();
  }

  async function loadAgnesReviewCard() {
    try {
      let targetId = null;
      const hashParts = location.hash.split('?');
      if (hashParts[1]) {
        const p = new URLSearchParams(hashParts[1]);
        targetId = p.get('review');
      }
      if (!targetId && location.search) {
        targetId = new URLSearchParams(location.search).get('review');
      }

      let post = null;
      if (targetId) {
        const res = await fetch(`/api/pipeline/post/${targetId}`);
        if (res.ok) {
          const d = await res.json();
          post = d.post;
        }
      }

      if (!post) {
        const res = await fetch('/api/pipeline/pending');
        if (res.ok) {
          const d = await res.json();
          post = d.posts?.[0] || null;
        }
      }

      if (!post || currentId !== 'agnes') return;

      // Bersihkan greeting kosong dan quick chips agar layar review bersih dan rapi
      els.messages.querySelector('.empty')?.remove();
      els.quick.innerHTML = '';

      const existingCard = els.messages.querySelector('.agnes-review-card');
      if (existingCard) existingCard.remove();

      const card = document.createElement('div');
      card.className = 'agnes-review-card';
      const isApproved = post.status === 'APPROVED';

      card.innerHTML = `
        <div class="agnes-card-head">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;">🎬</span>
            <div>
              <strong style="font-size:13.5px;color:#0f172a;">Review Konten #${post.id}</strong>
              <div style="font-size:11px;color:#64748b;">${post.topic || 'Lampu Navigate'} · ${post.platform || 'Instagram'}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="badge ${isApproved ? 'badge-approved' : 'badge-pending'}">${post.status}</span>
            <button type="button" id="btn-close-review-card" style="border:none;background:transparent;cursor:pointer;color:#94a3b8;font-size:16px;line-height:1;padding:2px 4px;" title="Tutup Card">✕</button>
          </div>
        </div>

        <div style="margin:10px 0;border-radius:12px;overflow:hidden;background:#000;border:1px solid var(--line);position:relative;">
          <video id="review-video-player" controls playsinline preload="auto" style="width:100%;max-height:240px;display:block;object-fit:cover;" src="${(post.post_url || '/videos/post-' + post.id + '.mp4') + '?t=' + (post.updated_at ? new Date(post.updated_at).getTime() : post.id)}"></video>
          <div id="video-error-placeholder" style="display:none;position:absolute;inset:0;background:rgba(15,23,42,0.95);flex-direction:column;align-items:center;justify-content:center;padding:16px;text-align:center;color:#fff;">
            <span style="font-size:26px;margin-bottom:6px;">🎬</span>
            <strong style="font-size:12px;color:#facc15;margin-bottom:4px;">Video Belum Dirender di Server</strong>
            <p style="font-size:11px;color:#cbd5e1;margin:0 0 10px 0;">Klik tombol biru di bawah untuk render video otomatis sekarang.</p>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:-6px;margin-bottom:8px;">
          <span style="font-size:11px;color:#16a34a;font-weight:600;">▶️ Video Siap Diputar</span>
          <a href="${post.post_url || '/videos/post-' + post.id + '.mp4'}" target="_blank" style="font-size:11px;color:#0284c7;text-decoration:none;font-weight:600;">
            🔗 Buka Video di Tab Baru (MP4)
          </a>
        </div>

        <!-- Pratinjau Suara Voiceover Ardi -->
        <div style="background:#f0f9ff;border:1px solid #bae6fd;padding:6px 10px;border-radius:8px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
            <span style="font-size:11px;font-weight:700;color:#0369a1;">🎧 Suara Voiceover Ardi (Neural):</span>
            <a href="/api/ugc/download-audio" download="suara-navigate-400w.mp3" style="font-size:10px;color:#0284c7;text-decoration:none;font-weight:600;">📥 Unduh MP3</a>
          </div>
          <audio controls src="/api/ugc/download-audio?stream=1" style="width:100%;height:28px;outline:none;"></audio>
        </div>

        <!-- Tombol Render Video Otomatis 1-Klik -->
        <div style="margin-bottom:10px;">
          <button type="button" id="btn-render-video" style="width:100%;padding:9px 12px;background:#0284c7;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;box-shadow:0 2px 4px rgba(2,132,199,0.25);">
            ⚡ Render Ulang Video Otomatis (1-Klik)
          </button>
          <div id="render-video-msg" style="display:none;font-size:11px;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;padding:6px 10px;border-radius:6px;margin-top:6px;text-align:center;line-height:1.4;"></div>
        </div>

        <div style="font-size:12px;color:#334155;background:#f8fafc;padding:10px;border-radius:10px;margin-bottom:8px;border:1px solid var(--line);line-height:1.4;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <strong style="color:#0f172a;font-size:11.5px;">📢 Naskah Iklan Facebook (Ad Copy):</strong>
            <button type="button" id="btn-copy-adcopy" style="padding:3px 6px;font-size:10.5px;background:#e2e8f0;border:none;border-radius:5px;cursor:pointer;font-weight:600;">
              📋 Salin Naskah
            </button>
          </div>
          <div style="max-height:80px;overflow-y:auto;white-space:pre-wrap;font-size:11px;color:#475569;background:#ffffff;padding:6px 8px;border-radius:6px;border:1px solid #e2e8f0;">${(post.draft_nadia || post.final_content || '').trim()}</div>
        </div>

        <div style="font-size:11px;color:#475569;background:#f0fdf4;padding:6px 10px;border-radius:8px;margin-bottom:8px;border:1px solid #bbf7d0;">
          <b>Review Patrick:</b> ${(post.review_dewi || 'Konten siap dipublish').slice(0, 140)}...
        </div>

        <div style="display:flex;gap:8px;">
          <button type="button" id="btn-agnes-approve" class="btn-approve" ${isApproved ? 'disabled' : ''} style="flex:1;padding:10px;background:#10b981;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer;">
            ${isApproved ? '✅ SUDAH DI-APPROVE' : '✅ APPROVE & PUBLISH'}
          </button>
          <button type="button" id="btn-agnes-revision" style="padding:10px 14px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer;">
            ✍️ Minta Revisi
          </button>
        </div>

        <!-- Form Inline Revisi Cepat Langsung di Kartu -->
        <div id="agnes-revision-box" style="display:none;margin-top:10px;background:#fffbeb;border:1px solid #fde68a;padding:10px;border-radius:10px;">
          <div style="font-size:11.5px;font-weight:700;color:#92400e;margin-bottom:6px;">✍️ Instruksi Revisi untuk Tim Agnes:</div>
          <textarea id="agnes-revision-input" rows="2" style="width:100%;padding:8px;border:1px solid #fcd34d;border-radius:6px;font-size:11px;resize:vertical;font-family:inherit;box-sizing:border-box;" placeholder="Tulis instruksi revisi (contoh: ubah naskah hook lebih heboh, perjelas watt dan garansi)..."></textarea>
          <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px;">
            <button type="button" id="btn-cancel-revision" style="padding:5px 10px;font-size:11px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;">Batal</button>
            <button type="button" id="btn-submit-revision-direct" style="padding:6px 12px;font-size:11px;background:#d97706;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;">🚀 Kirim Revisi ke Agnes</button>
          </div>
        </div>

        <!-- OPSI TAMBAHAN: VIDEO AI UGC MODEL MANUSIA (HEDRA / KLING) -->
        <details style="margin-top:12px;background:#f8fafc;padding:10px;border-radius:10px;border:1px solid #e2e8f0;">
          <summary style="font-size:11px;font-weight:700;color:#64748b;cursor:pointer;">
            🛠️ Opsi Tambahan: Buat Talking Avatar di Hedra.com (Manual)
          </summary>
          <div style="margin-top:8px;">
            <div style="font-size:11px;color:#475569;line-height:1.4;margin-bottom:8px;">
              Jika ingin model berbicara realistis, unduh 2 bahan ini lalu unggah ke <b>Hedra.com</b>:
            </div>

            <!-- 1. Foto Model Pria Indonesia -->
            <div style="display:flex;gap:10px;align-items:center;background:#fff;padding:8px;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:8px;">
              <img src="/api/ugc/download-model?preview=1" alt="Model Navigate 400W" style="width:50px;height:50px;border-radius:6px;object-fit:cover;border:1px solid #cbd5e1;flex-shrink:0;" />
              <div style="flex:1;min-width:0;">
                <div style="font-size:11px;font-weight:700;color:#1e293b;margin-bottom:2px;">1. Foto Model Pria Indonesia</div>
                <a href="/api/ugc/download-model" download="model-navigate-400w.png" style="padding:4px 8px;background:#15803d;color:#fff;border-radius:5px;font-size:10px;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:4px;">
                  📥 Unduh Foto PNG (51 KB)
                </a>
              </div>
            </div>

            <!-- 2. Voiceover Suara Ardi (Neural) -->
            <div style="background:#fff;padding:8px;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-size:11px;font-weight:700;color:#0369a1;">2. Suara Voiceover Ardi (Neural)</span>
                <a href="/api/ugc/download-audio" download="suara-navigate-400w.mp3" style="padding:4px 8px;background:#0284c7;color:#fff;border-radius:5px;font-size:10px;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:4px;">
                  📥 Unduh MP3
                </a>
              </div>
              <audio controls src="/api/ugc/download-audio?stream=1" style="width:100%;height:30px;outline:none;"></audio>
            </div>

            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
              <a href="https://www.hedra.com" target="_blank" style="padding:6px 10px;background:#7e22ce;color:#fff;border-radius:6px;font-size:11px;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:4px;">
                🌐 Buka Hedra.com (Gratis)
              </a>
            </div>

            <div style="border-top:1px dashed #cbd5e1;padding-top:8px;margin-top:6px;display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:11px;color:#334155;">Punya video hasil Hedra?</span>
              <label style="padding:5px 10px;background:#0f172a;color:#fff;border-radius:6px;font-size:11px;cursor:pointer;font-weight:600;">
                📤 Pasang Video ke Sini
                <input type="file" id="input-upload-ugc" accept="video/mp4" style="display:none;" />
              </label>
            </div>
          </div>
        </details>
      `;

      const videoPlayer = card.querySelector('#review-video-player');
      const videoErrorPlaceholder = card.querySelector('#video-error-placeholder');
      if (videoPlayer && videoErrorPlaceholder) {
        videoPlayer.addEventListener('error', () => {
          videoErrorPlaceholder.style.display = 'flex';
        });
      }

      card.querySelector('#btn-render-video')?.addEventListener('click', async () => {
        const btn = card.querySelector('#btn-render-video');
        const msg = card.querySelector('#render-video-msg');
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.innerHTML = '⏳ Victor sedang merender video Multi-Scene... (~5-10 detik)';
        if (msg) {
          msg.style.display = 'block';
          msg.innerText = 'Menggabungkan 5 Scene Naskah + Foto Produk + Suara Ardi Neural...';
        }

        try {
          const res = await fetch('/api/pipeline/render-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-access-code': getCode() },
            body: JSON.stringify({ postId: post.id, duration: 25 }),
          });
          const data = await res.json();
          if (data.success && data.videoUrl) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.background = '#16a34a';
            btn.innerHTML = '✅ Video Berhasil Dibuat! (Klik untuk Render Ulang)';
            if (msg) msg.innerText = `Selesai dalam ${(data.elapsedMs / 1000).toFixed(1)} detik! Video siap diputar di atas.`;
            if (videoPlayer) {
              if (videoErrorPlaceholder) videoErrorPlaceholder.style.display = 'none';
              videoPlayer.src = data.videoUrl + '?t=' + Date.now();
              videoPlayer.load();
              videoPlayer.play().catch(() => {});
            }
          } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.background = '#dc2626';
            btn.innerHTML = '❌ Gagal Render. Coba Lagi';
            if (msg) msg.innerText = data.error || 'Terjadi kesalahan saat merender.';
          }
        } catch (err) {
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.style.background = '#dc2626';
          btn.innerHTML = '❌ Gagal Render. Coba Lagi';
          if (msg) msg.innerText = err.message;
        }
      });

      card.querySelector('#input-upload-ugc')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const res = await fetch('/api/pipeline/upload-video', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ postId: post.id, videoBase64: reader.result }),
            });
            const data = await res.json();
            if (data.success && data.videoUrl) {
              const videoPlayer = card.querySelector('#review-video-player');
              if (videoPlayer) {
                videoPlayer.src = data.videoUrl + '?t=' + Date.now();
                videoPlayer.play().catch(() => {});
              }
              alert('✅ Video AI UGC berhasil dipasang ke Meja Agnes!');
            }
          } catch (err) {
            alert('Gagal mengunggah video: ' + err.message);
          }
        };
        reader.readAsDataURL(file);
      });

      card.querySelector('#btn-close-review-card')?.addEventListener('click', () => {
        card.remove();
      });

      card.querySelector('#btn-copy-adcopy')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const textToCopy = post.draft_nadia || post.final_content || '';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(textToCopy).then(() => {
            btn.textContent = '✅ Tersalin!';
            setTimeout(() => { btn.textContent = '📋 Salin Naskah'; }, 2000);
          }).catch(() => {});
        }
      });

      card.querySelector('#btn-agnes-approve')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Memproses...';
        try {
          const r = await fetch('/api/pipeline/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-access-code': getCode() },
            body: JSON.stringify({ postId: post.id }),
          });
          const res = await r.json();
          if (res.success) {
            btn.textContent = '✅ BERHASIL DI-APPROVE!';
            btn.style.background = '#059669';
            const b = card.querySelector('.badge');
            if (b) {
              b.className = 'badge badge-approved';
              b.textContent = 'APPROVED';
            }
          } else {
            alert(res.error || 'Gagal approve');
            btn.disabled = false;
            btn.textContent = '✅ APPROVE & PUBLISH';
          }
        } catch {
          alert('Gagal menghubungi server.');
          btn.disabled = false;
          btn.textContent = '✅ APPROVE & PUBLISH';
        }
      });

      const revBox = card.querySelector('#agnes-revision-box');
      const revInput = card.querySelector('#agnes-revision-input');

      card.querySelector('#btn-agnes-revision')?.addEventListener('click', () => {
        if (revBox) {
          const isHidden = revBox.style.display === 'none';
          revBox.style.display = isHidden ? 'block' : 'none';
          if (isHidden && revInput) {
            revInput.focus();
          }
        }
        els.input.value = `Agnes, tolong instruksikan tim untuk revisi konten #${post.id} "${post.topic}": `;
        autosize();
        syncSend();
      });

      card.querySelector('#btn-cancel-revision')?.addEventListener('click', () => {
        if (revBox) revBox.style.display = 'none';
      });

      card.querySelector('#btn-submit-revision-direct')?.addEventListener('click', () => {
        const note = (revInput?.value || '').trim();
        const text = `Agnes, tolong instruksikan tim untuk revisi konten #${post.id} "${post.topic}": ${note || 'Tolong revisi naskah dan videonya.'}`;
        if (revBox) revBox.style.display = 'none';
        submit(text);
      });

      els.messages.insertBefore(card, els.messages.firstChild);
    } catch (e) {
      console.warn('[agnes review card error]', e);
    }
  }

  function syncSend() {
    const busy = live.has(currentId);
    els.send.disabled = busy || !els.input.value.trim();
    els.input.placeholder = busy ? `${agentById(currentId).name.split(' ')[0]} lagi ngetik…` : 'Tulis pesan…';
  }

  async function submit(text) {
    const id = currentId;
    text = (text || '').trim();
    if (!id || !text || live.has(id)) return;

    const history = getHistory(id);
    const sent = [...history, { role: 'user', content: text }];
    setHistory(id, sent);

    els.messages.querySelector('.empty')?.remove();
    els.quick.innerHTML = '';
    els.messages.appendChild(bubble('user', '', { text }));
    els.input.value = '';
    autosize();

    const l = { text: '', el: null, abort: new AbortController() };
    live.set(id, l);
    l.el = bubble('assistant', typingHtml);
    els.messages.appendChild(l.el);
    scrollDown(true);
    onStatus(id, 'working');
    syncSend();

    try {
      const full = await streamChat(id, sent, {
        signal: l.abort.signal,
        onText: (_t, all) => {
          l.text = all;
          if (!l.raf) {
            l.raf = requestAnimationFrame(() => {
              l.raf = 0;
              paint(l);
            });
          }
        },
      });
      setHistory(id, [...sent, { role: 'assistant', content: full }]);
      live.delete(id);
      if (l.el && currentId === id) l.el.querySelector('.bubble').innerHTML = renderMarkdown(full);
      onStatus(id, 'done');
    } catch (err) {
      live.delete(id);
      onStatus(id, 'idle');
      if (err.name === 'AbortError') {
        setHistory(id, sent.slice(0, -1));
      } else {
        // kembalikan teks ke kolom input supaya bisa dikirim ulang
        setHistory(id, sent.slice(0, -1));
        if (currentId === id) {
          l.el?.remove();
          const e = bubble('assistant', '');
          e.classList.add('error');
          e.querySelector('.bubble').textContent = err.message;
          e.querySelector('.tools')?.remove();
          els.messages.appendChild(e);
          els.input.value = text;
          autosize();
          scrollDown(true);
        }
        if (err.code === 401) onNeedCode();
      }
    } finally {
      if (currentId === id) syncSend();
    }
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
  }

  // ---------- event ----------
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(els.input.value);
  });
  els.input.addEventListener('input', () => {
    autosize();
    syncSend();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(els.input.value);
    }
  });
  els.close.addEventListener('click', () => onClose());
  els.reset.addEventListener('click', () => {
    if (!currentId) return;
    live.get(currentId)?.abort.abort();
    clearHistory(currentId);
    render(currentId);
  });
  els.messages.addEventListener('click', (e) => {
    const copyCode = e.target.closest('.copy');
    const copyMsg = e.target.closest('[data-copy]');
    const flash = (btn, t) => {
      const old = btn.textContent;
      btn.textContent = t;
      setTimeout(() => { btn.textContent = old; }, 1200);
    };
    const write = async (text, btn) => {
      try {
        await navigator.clipboard.writeText(text);
        flash(btn, 'Tersalin');
      } catch {
        flash(btn, 'Gagal');
      }
    };
    if (copyCode) write(copyCode.parentElement.querySelector('code').textContent, copyCode);
    else if (copyMsg) write(copyMsg.closest('.msg').querySelector('.bubble').innerText, copyMsg);
  });

  return {
    open(agentId) {
      currentId = agentId;
      render(agentId);
      if (isDemo()) document.getElementById('banner').hidden = false;
      setTimeout(() => {
        if (matchMedia('(hover: hover)').matches) els.input.focus({ preventScroll: true });
      }, 350);
    },
    close() {
      currentId = null;
    },
    get current() {
      return currentId;
    },
  };
}
