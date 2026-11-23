# Kantor Navigate - PT Feihong Trading International

Kantor isometrik 3D interaktif berisi 9 karyawan AI spesialis untuk operasional brand pencahayaan **Navigate**. Dilengkapi sistem delegasi otonom antar-agen (Inter-Agent Autonomous Delegation), database produk & stok Supabase real-time, PostgreSQL pipeline approval konten, dan integrasi WhatsApp (WAHA + n8n).

**Divisi & Tim Kantor Navigate** (5 Divisi, 9 Karyawan AI):

| Divisi | Karyawan | Peran & Keahlian Utama |
|---|---|---|
| **Direksi** | Herfina Zhang (`herfina` - Leader) | Direktur Utama: Pengambil keputusan strategis, evaluasi performa seluruh divisi, dan visi operasional. |
| **Executive Manager** | Agnes (`agnes` - Leader) | Executive Manager: Keputusan operasional harian, laporan harian via WA, dan rekap dashboard KPI mingguan. |
| **Social Media** | Patrick (`patrick` - Leader) | Social Media Planner: Riset tren pencahayaan LED, analisis audiens, ide konten, dan reviewer strategi. |
| | Charles (`charles`) | Copywriter: Script video Reels/TikTok, copywriting promosi, caption, dan materi edukasi produk. |
| | Shenny (`shenny`) | Publisher & Scheduler: Penjadwalan posting optimal dan manajemen queue konten media sosial. |
| | Steve (`steve`) | Analyst: Analisis data engagement dan performa konten Facebook, Instagram, dan TikTok. |
| **Content Production** | Victor (`victor` - Leader) | Video Creator: Blueprint produksi video, storyboard adegan, hook 0-3 detik, voiceover, dan instruksi audio SFX. |
| | Gavin (`gavin`) | Graphic & Visual Designer: Blueprint visual layout, thumbnail FB Reels 9:16, badge spek produk, dan prompt Midjourney/DALL-E. |
| **Sales** | Sean (`sean` - Leader) | Sales Admin Navigate: Terkoneksi langsung ke Supabase (katalog harga, stok gudang, dan prospek B2B). |

**Teknologi & Arsitektur:**
- **Frontend:** Three.js (Scene 3D Isometrik), ES Modules, HTML5/CSS3, Vite.
- **Backend:** Node.js + Express, Server-Sent Events (SSE) untuk streaming response dan realtime live event bus.
- **AI Gateway / LLM:** 9router / OpenAI-compatible endpoint (`hermes` / Claude / GPT) dengan fallback ke Anthropic SDK langsung.
- **Database:**
  - **PostgreSQL:** Manajemen approval pipeline konten (`social_posts`) dan customer sales inquiries (`sales_inquiries`).
  - **Supabase REST API:** Pencarian semantik katalog & pricelist resmi (`documents`), stok gudang (`inventory_stocks`), dan prospek lead B2B (`prospect_leads`).
- **Otomasi & WhatsApp:** Integrasi n8n workflow dan WAHA (WhatsApp HTTP API) untuk auto-responder dan sistem approval Bos Ridho via WhatsApp.

---

## 1. Persiapan & Konfigurasi

**Yang dibutuhkan:**
- **Node.js 20+** (LTS disarankan)
- **Git**
- **Docker & Docker Compose** (jika deploy via container di VPS)
- **PostgreSQL** (lokal atau host VPS)
- **Akun Supabase & AI Gateway API Key** (9router / OpenAI / Anthropic)

**Konfigurasi `.env`:**
Salin `.env.example` menjadi `.env`, lalu sesuaikan nilainya:

```env
# AI Gateway (9router / OpenAI-compatible)
ROUTER_BASE_URL=https://ai-feihong.my.id/v1
ROUTER_API_KEY=sk-xxxx-xxxx
MODEL_LEADER=hermes
MODEL_TEAM=hermes

# Port & Keamanan Akses
PORT=3001
ACCESS_CODE=kode_akses_rahasia_anda

# Database PostgreSQL
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=kantor_ai
PG_USER=postgres
PG_PASSWORD=password_postgres

# Supabase (Katalog, Stok, Leads Navigate)
SUPABASE_URL=https://nakvxtnyrytiudtniqtt.supabase.co
SUPABASE_KEY=sb_secret_xxxx
```

> **Catatan Keamanan:** `ACCESS_CODE` wajib diisi saat deploy ke publik/VPS agar API dan data internal tidak dapat diakses pihak luar tanpa autentikasi. File `.env` sudah masuk dalam `.gitignore` dan `.dockerignore`.

---

## 2. Menjalankan di Lokal (Development)

1. Clone repositori:
```bash
git clone https://github.com/Alamlikumm/kantor-ai-agents.git
cd kantor-ai-agents
```

2. Install dependency:
```bash
npm install
```

3. Salin dan konfigurasi environment:
```bash
cp .env.example .env
# Edit .env sesuai konfigurasi AI Gateway, Database, dan Supabase
```

4. Jalankan development server:
```bash
npm run dev
```
Buka browser ke `http://localhost:5173`. Frontend Three.js dan backend server akan berjalan bersamaan.

---

## 3. Deploy di VPS (Production)

### Opsi A: Menggunakan Docker & Docker Compose (Disarankan)

Container sudah dilengkapi konfigurasi isolasi keamanan dan network bridge.

1. Clone ke VPS:
```bash
cd /opt
git clone https://github.com/Alamlikumm/kantor-ai-agents.git kantor-navigate
cd kantor-navigate
```

2. Konfigurasi file `.env` di VPS:
```bash
cp .env.example .env
nano .env
```
> **Penting:** 
> - Pastikan `ACCESS_CODE` diisi dengan kode rahasia.
> - Jika PostgreSQL berjalan di host VPS, atur `PG_HOST=host.docker.internal`.

3. Build dan jalankan container:
```bash
docker compose up -d --build
```

4. Cek log status:
```bash
docker compose logs -f
```

---

### Opsi B: Menggunakan Node.js, PM2 & Nginx

1. Install dependency & build frontend:
```bash
npm install
npm run build
```

2. Jalankan server dengan PM2:
```bash
pm2 start server/index.js --name kantor-navigate
pm2 save
pm2 startup
```

3. Konfigurasi Nginx Reverse Proxy (`/etc/nginx/sites-available/kantor-navigate`):
```nginx
server {
  server_name office.domainkamu.com;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Endpoint Streaming SSE (Wajib disable buffering)
  location ~ ^/(api/chat|api/events) {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 120s;
  }
}
```

---

## 4. Alur Kerja Otomasi & Fitur Utama

1. **Autonomous Task Delegation (Antar-Karyawan):**
   Karyawan dapat saling membagi tugas secara otomatis di latar belakang dengan format:
   `[TUGAS_KE: id_karyawan | rincian tugas...]`
   Riwayat pengerjaan tersimpan di `server/agent_tasks.json` dan langsung direfleksikan di animasi meja 3D.

2. **Supabase Real-Time Knowledge Base (Sean):**
   Sean (Sales Admin) secara otomatis mengambil konteks spesifikasi teknis, harga grosir/eceran, dan ketersediaan stok fisik gudang secara live untuk membalas calon pelanggan.

3. **Approval Flow Konten Sosial Media:**
   Draft yang dibuat Charles (Copywriter) akan direview oleh Patrick (Planner). Setelah status `PENDING_APPROVAL`, link review (`/review/:id`) dikirimkan ke WhatsApp Bos Ridho untuk di-approve langsung atau via tombol web.

---

## 5. Struktur Direktori Project

```
├── server/
│   ├── index.js             # API Express, SSE streaming, routing, DB PostgreSQL & Supabase
│   ├── prompts.js           # System prompts tiap karyawan & divisi
│   └── agent_tasks.json     # Riwayat tugas antar-agen
├── shared/
│   └── roster.js            # Definisi divisi, daftar 9 karyawan, profil visual 3D
├── src/
│   ├── main.js              # State manager & event listener
│   ├── stage.js             # Setup Three.js scene, kamera isometrik, pencahayaan
│   ├── office.js            # Layout denah kantor, ruangan tiap divisi
│   ├── character.js         # Karakter voxel 3D, animasi mengetik & meja
│   ├── panel.js             # UI modal dialog chat per karyawan
│   └── style.css            # Styling antarmuka
├── docker-compose.yml       # Konfigurasi container produksi
├── Dockerfile               # Multi-stage Docker build
└── .dockerignore            # Pengaman secret & binary build
```

---

*Hak Cipta © PT Feihong Trading International — Brand Navigate Lighting.*