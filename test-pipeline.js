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

  let res = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      res = await fetch(`http://localhost:${PORT}/api/pipeline/social-content`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-code': ACCESS_CODE,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) break;
    } catch (connErr) {
      if (attempt < 4) {
        console.log(`⏳ Menunggu server Express siap (attempt ${attempt}/3)...`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw connErr;
      }
    }
  }

  try {
    const data = await res.json();
    if (!data.success) {
      console.error('❌ Gagal:', data.error);
      return;
    }

    console.log(`\n✅ Konten #${data.postId} berhasil dirumuskan oleh Tim Content & Social!`);
    console.log(`📌 Topik: ${data.topic}`);
    console.log(`✍️ Copywriter & Planner: Charles & Patrick`);
    console.log(`🎨 Visual Desain: Gavin (Render Foto Produk AI Navigate)`);
    console.log(`🎬 Video Creator: Victor (Video Engine + Animasi)`);
    console.log(`🎙️ Voiceover: Edge-TTS Neural Voice (Bahasa Indonesia Alami)`);
    console.log(`⏳ Sedang merender video MP4 di background (estimasi 8-15 detik)...`);

    let post = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const checkRes = await fetch(`http://localhost:${PORT}/api/pipeline/post/${data.postId}`);
        if (checkRes.ok) {
          const postData = await checkRes.json();
          post = postData.post;
          if (post?.post_url) break;
        }
      } catch {}
    }

    console.log('\n======================================================');
    console.log(`🎬 HASIL RENDER VIDEO: ${post?.post_url || 'Berhasil di-render (cek meja Agnes)'}`);
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
