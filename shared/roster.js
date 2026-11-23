// Data publik: dipakai frontend (visual + UI) dan backend (validasi agentId).
// System prompt ada di server/prompts.js (tidak ikut ke browser).

export const SKIN = ['#f3d2b3', '#e3b48a', '#c98f62', '#a97047', '#8a5a38'];

export const DIVISIONS = [
  { id: 'direksi',   name: 'Direksi',           short: 'Direksi',  color: '#7c3aed', row: 0, col: 0 },
  { id: 'manajer',   name: 'Executive Manager',  short: 'Manager',  color: '#0ea5e9', row: 0, col: 1 },
  { id: 'social',    name: 'Social Media',        short: 'Social',   color: '#ff5fa2', row: 0, col: 2 },
  { id: 'content',   name: 'Content Production',  short: 'Content',  color: '#f97316', row: 1, col: 0 },
  { id: 'sales',     name: 'Sales',               short: 'Sales',    color: '#16a34a', row: 1, col: 1 },
];

// look: skin = index SKIN, hair = warna, style = short | long | bun, glasses, hijab = warna
const A = (id, division, name, gender, role, focus, look, quick, leader = false) => ({
  id, division, name, gender, role, focus, look, quick, leader,
});

export const AGENTS = [
  // ---------- Direksi ----------
  A('herfina', 'direksi', 'Herfina Zhang', 'F', 'Direktur', 'pantau operasional, keputusan strategis, visi perusahaan',
    { skin: 0, hair: '#1a1a1a', style: 'bun', glasses: true },
    ['Pantau kondisi operasional hari ini', 'Evaluasi performa semua divisi', 'Prioritas strategi bulan ini'], true),

  // ---------- Executive Manager ----------
  A('agnes', 'manajer', 'Agnes', 'F', 'Executive Manager', 'keputusan operasional, laporan harian WA, dashboard KPI mingguan',
    { skin: 1, hair: '#2b1d16', style: 'long' },
    ['Buat laporan harian semua divisi', 'Ringkas KPI mingguan ke dashboard', 'Keputusan operasional mendesak'], true),

  // ---------- Social Media ----------
  A('patrick', 'social', 'Patrick', 'M', 'Social Media Planner', 'riset tren, peluang pasar, ide konten, tema, target audiens, jadwal konten',
    { skin: 2, hair: '#1c1c1c', style: 'short' },
    ['Cari tren konten minggu ini', 'Susun ide konten + tema 1 bulan', 'Siapa target audiens produk ini?'], true),
  A('charles', 'social', 'Charles', 'M', 'Copywriter', 'script konten, caption, materi promosi',
    { skin: 3, hair: '#2b2118', style: 'short', glasses: true },
    ['Tulis script Reels 60 detik', '5 caption promo produk', 'Materi promosi flashsale']),
  A('shenny', 'social', 'Shenny', 'F', 'Social Media Publisher', 'jadwal & publikasi konten sesuai jam ramai',
    { skin: 1, hair: '#3a2417', style: 'long' },
    ['Jadwal posting optimal minggu ini', 'Kapan jam terbaik posting di IG?', 'Susun konten queue 7 hari']),
  A('steve', 'social', 'Steve', 'M', 'Social Media Analyst', 'analisis engagement, performa konten FB/TikTok/IG',
    { skin: 2, hair: '#222222', style: 'short', glasses: true },
    ['Analisis performa konten bulan ini', 'Konten mana yang paling engage?', 'Rekomendasi dari data engagement']),

  // ---------- Content Production ----------
  A('victor', 'content', 'Victor', 'M', 'Video Creator', 'video promosi produk, Reels/TikTok, visual menarik sesuai riset planner',
    { skin: 3, hair: '#1c1c1c', style: 'short' },
    ['Konsep video promo produk 30 detik', 'Storyboard Reels + hook pembuka', 'Ide visual untuk TikTok trending'], true),
  A('gavin', 'content', 'Gavin', 'M', 'Graphic & Visual Designer', 'poster, flyer, katalog, foto produk, desain visual',
    { skin: 2, hair: '#2b1d16', style: 'short', glasses: true },
    ['Konsep desain poster promo', 'Layout katalog produk 1 halaman', 'Panduan visual untuk konten IG']),

  // ---------- Sales ----------
  A('sean', 'sales', 'Sean', 'M', 'Sales Admin', 'prospek pelanggan, info produk Navigate, follow-up, laporan penjualan harian',
    { skin: 2, hair: '#1c1c1c', style: 'short' },
    ['Cek harga Panel Light Inbow', 'Cek stok LED Strip gudang', 'Daftar prospek lead B2B baru'], true),
];

export const agentById  = (id)         => AGENTS.find((a) => a.id === id);
export const divisionById = (id)       => DIVISIONS.find((d) => d.id === id);
export const agentsOf   = (divisionId) => AGENTS.filter((a) => a.division === divisionId);
