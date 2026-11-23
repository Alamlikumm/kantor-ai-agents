import 'dotenv/config';

const PORT = process.env.PORT || 3001;
const ACCESS_CODE = process.env.ACCESS_CODE || '';

async function runTest() {
  console.log('🚀 Memulai test pembuatan konten & render video otomatis Navigate...');

  const payload = {
    topic: 'Navigate LED Flood Light 400W IP65 Outdoor',
    platform: 'Instagram Reels / TikTok',
    targetAudience: 'Kontraktor Proyek, Pengelola Gudang & Lapangan',
    notes: 'Sorot keunggulan 8 Modul Chip COB, bodi aluminium tebal, sertifikasi IP65 tahan air badai, dan garansi resmi PT Feihong Trading International',
  };

  try {
    const res = await fetch(`http://localhost:${PORT}/api/pipeline/social-content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-code': ACCESS_CODE,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!data.success) {
      console.error('❌ Gagal:', data.error);
      return;
    }

    console.log(`\n✅ Konten #${data.postId} berhasil dirumuskan oleh Charles & Patrick!`);
    console.log(`📌 Topik: ${data.topic}`);
    console.log(`⏳ Sedang merender video MP4 via FFmpeg di background (estimasi 3-8 detik)...`);

    // Tunggu render selesai
    await new Promise((r) => setTimeout(r, 7000));

    const checkRes = await fetch(`http://localhost:${PORT}/api/pipeline/post/${data.postId}`);
    const postData = await checkRes.json();
    const post = postData.post;

    console.log('\n======================================================');
    console.log(`🎬 HASIL RENDER VIDEO: ${post?.post_url || 'Sedang proses'}`);
    console.log(`📋 STATUS POSTINGAN: ${post?.status || 'PENDING_APPROVAL'}`);
    console.log('======================================================');
    console.log(`\n👉 SILAKAN BUKA DI BROWSER BOS RIDHO:`);
    console.log(`https://domain-vps-anda/#agnes?review=${data.postId}`);
    console.log(`(Kamera 3D akan otomatis meluncur ke Meja Agnes dan memutar video di atas)`);
  } catch (err) {
    console.error('❌ Gagal menghubungi server kantor AI:', err.message);
    console.log('Pastikan backend server sudah berjalan (pm2 status atau npm run dev).');
  }
}

runTest();
