import { exec, execSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateEdgeTTS, VOICES } from './edge_tts.js';
import { generateProductImage } from './image_generator.js';
import { isRemotionInstalled, renderRemotionVideo } from './remotion_renderer.js';

const execAsync = promisify(exec);

// Direktori output video
const videosDir = fileURLToPath(new URL('../dist/videos', import.meta.url));
if (!existsSync(videosDir)) {
  mkdirSync(videosDir, { recursive: true });
}

// Cek ketersediaan FFmpeg di sistem
export function getFFmpegBinary() {
  // 1. Prioritaskan system ffmpeg (terutama di Linux VPS seperti Ubuntu /usr/bin/ffmpeg yang lengkap dengan libfreetype dan filter drawbox/drawtext)
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {}

  // 2. Fallback ke node_modules hanya jika system ffmpeg tidak ditemukan di PATH
  const possibleDirs = [
    '../node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe',
    '../node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg',
    '../node_modules/@remotion/compositor-linux-x64-musl/ffmpeg',
    '../node_modules/@remotion/compositor-darwin-x64/ffmpeg',
    '../node_modules/@remotion/compositor-darwin-arm64/ffmpeg',
  ];
  for (const rel of possibleDirs) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(p)) return `"${p}"`;
    } catch {}
  }
  return 'ffmpeg';
}

export async function isFFmpegInstalled() {
  try {
    const bin = getFFmpegBinary();
    if (bin !== 'ffmpeg') return true;
    await execAsync(`${bin} -version`);
    return true;
  } catch {
    return false;
  }
}

// Helper sanitasi teks untuk filter drawtext FFmpeg
function sanitizeText(str, maxLen = 45) {
  if (!str) return '';
  return String(str)
    .replace(/[\r\n]+/g, ' ')
    .replace(/['":\\]/g, '')
    .trim()
    .slice(0, maxLen);
}

/**
 * Dapatkan durasi audio (detik) menggunakan ffprobe.
 */
async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    const parsed = parseFloat(stdout.trim());
    if (!isNaN(parsed) && parsed > 0) return parsed;
  } catch {}
  return 10; // Default fallback 10 detik
}

function isJpegFile(filePath) {
  try {
    const fd = openSync(filePath, 'r');
    const b = Buffer.alloc(2);
    readSync(fd, b, 0, 2, 0);
    closeSync(fd);
    return b[0] === 0xff && b[1] === 0xd8;
  } catch {}
  return false;
}

/**
 * Render video 9:16 vertikal (1080x1920) Navigate Lighting:
 * - Suara: Edge-TTS Neural Voice (Bahasa Indonesia Alami - 100% Gratis).
 * - Visual: Remotion React (jika paket terpasang) atau FFmpeg High-Spec dengan audio terintegrasi.
 */
export async function renderAutomatedVideo({
  postId,
  topic = 'Navigate LED',
  hook = '',
  narration = '',
  script = '',
  specs = [],
  cta = 'Hubungi Tim Sales Sean via WhatsApp',
  duration = 10,
  productImagePath = null,
}) {
  const outputFileName = `post-${postId || Date.now()}.mp4`;
  const outputPath = `${videosDir}/${outputFileName}`;
  const publicUrl = `/videos/${outputFileName}`;

  const audioFileName = `audio-${postId || Date.now()}.mp3`;
  const audioPath = `${videosDir}/${audioFileName}`;
  const audioPublicUrl = `/videos/${audioFileName}`;

  // 1. Dapatkan / Generate Foto Produk Realistis dari Gavin (FLUX AI / Vector)
  const defaultProductImage = fileURLToPath(new URL('./assets/product-navigate-400w.png', import.meta.url));
  let activeProductImage = productImagePath;
  let activeProductPublicUrl = null;
  if (!activeProductImage || !existsSync(activeProductImage) || activeProductImage.endsWith('.svg')) {
    try {
      console.log(`[video-renderer] Memanggil Gavin untuk menghasilkan visual produk "${topic}"...`);
      const imgRes = await generateProductImage({ postId, topic, specs });
      if (imgRes.success && imgRes.imagePath && existsSync(imgRes.imagePath) && !imgRes.imagePath.endsWith('.svg')) {
        activeProductImage = imgRes.imagePath;
        activeProductPublicUrl = imgRes.publicUrl;
      }
    } catch (gavinErr) {
      console.warn('[video-renderer] Gavin image gen error:', gavinErr.message);
    }
  }

  // Gunakan foto produk otentik Navigate 400W jika image generator menghasilkan SVG atau kosong
  if ((!activeProductImage || !existsSync(activeProductImage) || activeProductImage.endsWith('.svg')) && existsSync(defaultProductImage)) {
    activeProductImage = defaultProductImage;
    activeProductPublicUrl = '/videos/product-navigate-400w.png';
  }

  // 2. Sintesis Suara Manusia Real Bahasa Indonesia via Edge-TTS
  const narrationText = (narration || script || hook || topic)
    .replace(/[#*`_~]/g, '')
    .trim();

  let hasVoiceover = false;
  let finalDuration = duration;

  try {
    console.log(`[video-renderer] Menyiapkan Voiceover Edge-TTS untuk Post #${postId}...`);
    const ttsRes = await generateEdgeTTS({
      text: narrationText,
      outputPath: audioPath,
      voice: VOICES.GADIS, // id-ID-GadisNeural (suara wanita jernih & ramah)
    });

    if (ttsRes.success && existsSync(audioPath)) {
      hasVoiceover = true;
      const audioDuration = await getAudioDuration(audioPath);
      finalDuration = Math.max(8, Math.ceil(audioDuration + 1.5)); // Beri jeda 1.5 detik di akhir
      console.log(`[video-renderer] Voiceover selesai (${audioDuration.toFixed(1)}s). Durasi video disetel: ${finalDuration}s`);
    } else {
      console.warn('[video-renderer] Voiceover Edge-TTS dilewati:', ttsRes.error);
    }
  } catch (ttsErr) {
    console.warn('[video-renderer] Gagal generate Edge-TTS, beralih tanpa audio:', ttsErr.message);
  }

  // 3. Coba Render dengan Remotion (React Framework) jika dependensi terpasang
  const remotionInstalled = await isRemotionInstalled();
  if (remotionInstalled) {
    try {
      console.log(`[video-renderer] Merender video dengan Remotion Engine (Gambar: ${activeProductImage ? 'Tersedia' : 'Tidak'})...`);
      const remotionRes = await renderRemotionVideo({
        outputPath,
        inputProps: {
          topic,
          hook,
          narration: narrationText,
          specs: specs.length > 0 ? specs : ['Garansi Resmi PT Feihong', 'IP65 Weatherproof', 'Kualitas Standar Proyek'],
          cta,
          audioUrl: hasVoiceover ? audioPath : '',
          productImageUrl: activeProductImage || '',
          durationInSeconds: finalDuration,
        },
      });

      if (remotionRes.success) {
        return {
          success: true,
          videoUrl: publicUrl,
          audioUrl: hasVoiceover ? audioPublicUrl : null,
          productImageUrl: activeProductPublicUrl,
          engine: 'remotion',
          duration: finalDuration,
          elapsedMs: remotionRes.elapsedMs,
          fileName: outputFileName,
        };
      }
    } catch (remotionErr) {
      console.warn('[video-renderer] Remotion gagal, fallback otomatis ke FFmpeg:', remotionErr.message);
    }
  }

  // 4. Fallback High-Quality FFmpeg Renderer (Ditingkatkan dengan Foto Produk Asli & Suara Edge-TTS)
  const installed = await isFFmpegInstalled();
  if (!installed) {
    return {
      success: false,
      reason: 'ffmpeg_not_installed',
      message: 'FFmpeg belum terinstall di server. Jalankan "sudo apt install -y ffmpeg" di VPS.',
    };
  }

  const safeTopic = sanitizeText(topic, 35) || 'NAVIGATE LIGHTING';
  const safeHook = sanitizeText(hook, 45) || 'SOLUSI PENCAHAYAAN PROYEK TERBAIK';
  const safeCta = sanitizeText(cta, 45) || 'HUBUNGI TIM SALES SEAN VIA WHATSAPP';
  const safeSpec1 = sanitizeText(specs[0] || 'GARANSI RESMI NAVIGATE', 40);
  const safeSpec2 = sanitizeText(specs[1] || 'IP65 WEATHERPROOF OUTDOOR', 40);
  const safeSpec3 = sanitizeText(specs[2] || 'EFISIENSI DAYA TINGGI', 40);

  function getLinuxFontParam() {
  const bundledFont = fileURLToPath(new URL('./assets/Roboto-Bold.ttf', import.meta.url));
  if (existsSync(bundledFont)) {
    const cleanPath = bundledFont.replace(/\\/g, '/').replace(/:/g, '\\:');
    return `:fontfile='${cleanPath}'`;
  }
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return `:fontfile='${p}'`;
  }
  return '';
}

function cleanFfmpegText(str, maxLen = 50) {
  if (!str) return '';
  return String(str)
    .replace(/[\r\n]+/g, ' ')
    .replace(/['":\\%\[\]]/g, '')
    .trim()
    .slice(0, maxLen);
}

  const fontParam = getLinuxFontParam();

  // Multi-Scene Timeline Victor (Night to Day Transformation - 25 Detik):
  // Menggunakan ekspresi tanpa koma gte(t, a)*lt(t, b) agar filter FFmpeg tidak terpecah
  // Scene 1: 00:00 - 00:03 -> Gelap Total Outdoor (Hook Masalah)
  // Scene 2: 00:03 - 00:09 -> Saklar ON: Gelap Jadi Siang (Navigate 400W)
  // Scene 3: 00:09 - 00:16 -> Bedah 8 Modul COB 40.000 Lumens (Kualitas Cahaya)
  // Scene 4: 00:16 - 00:22 -> Bodi Aluminium Die-Cast & IP65 (Ketahanan Ekstrem)
  // Scene 5: 00:22 - 00:25 -> Outro Call To Action WhatsApp Sales Admin Sean

  const filterGraph = [
    // Persistent Header & Branding (Seluruh Durasi)
    `drawbox=x=80:y=80:w=920:h=6:color=0x0ea5e9@0.9:t=fill`,
    `drawtext=text='NAVIGATE LIGHTING'${fontParam}:fontcolor=0x38bdf8:fontsize=48:x=(w-text_w)/2:y=130`,
    `drawtext=text='PT FEIHONG TRADING INTERNATIONAL'${fontParam}:fontcolor=0x94a3b8:fontsize=24:x=(w-text_w)/2:y=190`,

    // Persistent Footer (Seluruh Durasi)
    `drawbox=x=80:y=1760:w=920:h=6:color=0x0ea5e9@0.9:t=fill`,
    `drawtext=text='STANDAR PENCAHAYAAN PROYEK & INDUSTRI'${fontParam}:fontcolor=0x64748b:fontsize=22:x=(w-text_w)/2:y=1790`,

    // SCENE 1 (0 - 3s): LAPANGAN GELAP TOTAL (HOOK MASALAH)
    `drawbox=x=80:y=520:w=920:h=620:color=0x180b0b@0.95:t=fill:enable='gte(t,0)*lt(t,3)'`,
    `drawbox=x=80:y=520:w=920:h=620:color=0xef4444@0.8:t=4:enable='gte(t,0)*lt(t,3)'`,
    `drawtext=text='AREA OUTDOOR ATAU GUDANG'${fontParam}:fontcolor=0xf87171:fontsize=32:x=(w-text_w)/2:y=580:enable='gte(t,0)*lt(t,3)'`,
    `drawtext=text='Lampu sorot biasa mati kutu di area seluas ini'${fontParam}:fontcolor=0xffffff:fontsize=36:x=(w-text_w)/2:y=720:enable='gte(t,0)*lt(t,3)'`,
    `drawtext=text='GELAP TOTAL & REDUP MERUGIKAN PROYEK'${fontParam}:fontcolor=0xfca5a5:fontsize=28:x=(w-text_w)/2:y=850:enable='gte(t,0)*lt(t,3)'`,

    // SCENE 2 (3 - 9s): SAKLAR ON -> GELAP JADI SIANG BENDERANG!
    `drawbox=x=80:y=460:w=920:h=740:color=0x0f172a@0.95:t=fill:enable='gte(t,3)*lt(t,9)'`,
    `drawbox=x=80:y=460:w=920:h=740:color=0xfacc15@0.9:t=4:enable='gte(t,3)*lt(t,9)'`,
    `drawtext=text='SAKLAR ON - GELAP JADI SIANG!'${fontParam}:fontcolor=0xfacc15:fontsize=46:x=(w-text_w)/2:y=520:enable='gte(t,3)*lt(t,9)'`,
    `drawtext=text='NAVIGATE 400W LED FLOOD LIGHT'${fontParam}:fontcolor=0xffffff:fontsize=36:x=(w-text_w)/2:y=610:enable='gte(t,3)*lt(t,9)'`,
    `drawbox=x=120:y=710:w=840:h=110:color=0x0284c7@0.95:t=fill:enable='gte(t,3)*lt(t,9)'`,
    `drawtext=text='SEKETIKA TERANG BENDERANG 100+ METER'${fontParam}:fontcolor=0xffffff:fontsize=32:x=(w-text_w)/2:y=745:enable='gte(t,3)*lt(t,9)'`,
    `drawtext=text='Sorotan Merata Tanpa Titik Gelap'${fontParam}:fontcolor=0x38bdf8:fontsize=30:x=(w-text_w)/2:y=880:enable='gte(t,3)*lt(t,9)'`,
    `drawtext=text='Efisiensi Daya Tinggi - Terang Maksimal'${fontParam}:fontcolor=0x4ade80:fontsize=26:x=(w-text_w)/2:y=950:enable='gte(t,3)*lt(t,9)'`,

    // SCENE 3 (9 - 16s): BEDAH 8 MODUL CHIP COB & 40.000 LUMENS
    `drawbox=x=80:y=420:w=920:h=840:color=0x0b1329@0.95:t=fill:enable='gte(t,9)*lt(t,16)'`,
    `drawbox=x=80:y=420:w=920:h=840:color=0x38bdf8@0.7:t=3:enable='gte(t,9)*lt(t,16)'`,
    `drawtext=text='BEDAH KEKUATAN MODUL & CAHAYA'${fontParam}:fontcolor=0x38bdf8:fontsize=36:x=(w-text_w)/2:y=470:enable='gte(t,9)*lt(t,16)'`,
    `drawbox=x=120:y=550:w=840:h=90:color=0x1e293b@0.95:t=fill:enable='gte(t,9)*lt(t,16)'`,
    `drawtext=text='V  40.000+ LUMENS SUPER TERANG'${fontParam}:fontcolor=0x4ade80:fontsize=32:x=(w-text_w)/2:y=580:enable='gte(t,9)*lt(t,16)'`,
    `drawbox=x=120:y=670:w=840:h=90:color=0x1e293b@0.95:t=fill:enable='gte(t,9)*lt(t,16)'`,
    `drawtext=text='V  8 MODUL CHIP COB TERBAIK'${fontParam}:fontcolor=0x38bdf8:fontsize=32:x=(w-text_w)/2:y=700:enable='gte(t,9)*lt(t,16)'`,
    `drawbox=x=120:y=790:w=840:h=90:color=0x1e293b@0.95:t=fill:enable='gte(t,9)*lt(t,16)'`,
    `drawtext=text='V  ZERO FLICKER & NYAMAN DI MATA'${fontParam}:fontcolor=0xfbcfe8:fontsize=32:x=(w-text_w)/2:y=820:enable='gte(t,9)*lt(t,16)'`,
    `drawtext=text='Sorotan Padat Menembus Seluruh Sudut Proyek'${fontParam}:fontcolor=0x94a3b8:fontsize=26:x=(w-text_w)/2:y=940:enable='gte(t,9)*lt(t,16)'`,
    `drawtext=text='Lensa Optik Fokus & Terarah Presisi'${fontParam}:fontcolor=0x67e8f9:fontsize=24:x=(w-text_w)/2:y=1000:enable='gte(t,9)*lt(t,16)'`,

    // SCENE 4 (16 - 22s): BODI ALUMINIUM & KETAHANAN IP65
    `drawbox=x=80:y=420:w=920:h=840:color=0x0f172a@0.95:t=fill:enable='gte(t,16)*lt(t,22)'`,
    `drawbox=x=80:y=420:w=920:h=840:color=0x22c55e@0.7:t=3:enable='gte(t,16)*lt(t,22)'`,
    `drawtext=text='KETAHANAN EKSTREM STANDAR PROYEK'${fontParam}:fontcolor=0x4ade80:fontsize=36:x=(w-text_w)/2:y=470:enable='gte(t,16)*lt(t,22)'`,
    `drawbox=x=120:y=550:w=840:h=90:color=0x1e293b@0.95:t=fill:enable='gte(t,16)*lt(t,22)'`,
    `drawtext=text='V  BODI FULL ALUMINIUM DIE-CAST'${fontParam}:fontcolor=0xffffff:fontsize=32:x=(w-text_w)/2:y=580:enable='gte(t,16)*lt(t,22)'`,
    `drawbox=x=120:y=670:w=840:h=90:color=0x1e293b@0.95:t=fill:enable='gte(t,16)*lt(t,22)'`,
    `drawtext=text='V  IP65 WATERPROOF TAHAN BADAI'${fontParam}:fontcolor=0x38bdf8:fontsize=32:x=(w-text_w)/2:y=700:enable='gte(t,16)*lt(t,22)'`,
    `drawbox=x=120:y=790:w=840:h=90:color=0x1e293b@0.95:t=fill:enable='gte(t,16)*lt(t,22)'`,
    `drawtext=text='V  GARANSI RESMI 2 TAHUN PT FEIHONG'${fontParam}:fontcolor=0xfacc15:fontsize=32:x=(w-text_w)/2:y=820:enable='gte(t,16)*lt(t,22)'`,
    `drawtext=text='Sirip Heatsink Tebal - Buang Panas Cepat'${fontParam}:fontcolor=0x94a3b8:fontsize=26:x=(w-text_w)/2:y=940:enable='gte(t,16)*lt(t,22)'`,
    `drawtext=text='Masa Pakai Awet Hingga 50.000 Jam'${fontParam}:fontcolor=0x86efac:fontsize=24:x=(w-text_w)/2:y=1000:enable='gte(t,16)*lt(t,22)'`,

    // SCENE 5 (22 - 25s): OUTRO & CALL TO ACTION SALES ADMIN SEAN
    `drawbox=x=80:y=460:w=920:h=740:color=0x064e3b@0.95:t=fill:enable='gte(t,22)*lte(t,25)'`,
    `drawbox=x=80:y=460:w=920:h=740:color=0x22c55e@0.9:t=4:enable='gte(t,22)*lte(t,25)'`,
    `drawtext=text='UPGRADE PENERANGAN SEKARANG!'${fontParam}:fontcolor=0xfacc15:fontsize=42:x=(w-text_w)/2:y=520:enable='gte(t,22)*lte(t,25)'`,
    `drawtext=text='HUBUNGI SALES ADMIN SEAN VIA WHATSAPP'${fontParam}:fontcolor=0xffffff:fontsize=32:x=(w-text_w)/2:y=620:enable='gte(t,22)*lte(t,25)'`,
    `drawbox=x=120:y=720:w=840:h=120:color=0x15803d@0.9:t=fill:enable='gte(t,22)*lte(t,25)'`,
    `drawtext=text='DAPATKAN KATALOG RESMI & PRICELIST'${fontParam}:fontcolor=0xffffff:fontsize=30:x=(w-text_w)/2:y=755:enable='gte(t,22)*lte(t,25)'`,
    `drawtext=text='Penawaran Spesial Kontraktor & Grosir'${fontParam}:fontcolor=0xdcfce7:fontsize=22:x=(w-text_w)/2:y=795:enable='gte(t,22)*lte(t,25)'`,
    `drawtext=text='Distributor Resmi - PT Feihong Trading International'${fontParam}:fontcolor=0x86efac:fontsize=24:x=(w-text_w)/2:y=940:enable='gte(t,22)*lte(t,25)'`,
  ].join(',');

  const bundledAudio = fileURLToPath(new URL('./assets/audio-model-navigate-400w.mp3', import.meta.url));
  let finalAudioPath = null;
  if (hasVoiceover && existsSync(audioPath)) {
    finalAudioPath = audioPath;
  } else if (existsSync(bundledAudio)) {
    finalAudioPath = bundledAudio;
    hasVoiceover = true;
  }

  const audioArgs = finalAudioPath
    ? `-i "${finalAudioPath}"`
    : `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100`;

  // Tulis filtergraph ke file script terpisah untuk menghindari limit command line OS
  const filterScriptPath = `${videosDir}/filter-${postId || Date.now()}.txt`;
  writeFileSync(filterScriptPath, filterGraph, 'utf8');

  const ffmpegBin = getFFmpegBinary();
  const cmd = `${ffmpegBin} -y -f lavfi -i "color=c=0x070b14:s=1080x1920:d=${finalDuration}" ${audioArgs} -filter_script:v "${filterScriptPath}" -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -t ${finalDuration} "${outputPath}"`;

  try {
    console.log(`[video-renderer] Memulai render FFmpeg Multi-Scene Victor (Audio: ${hasVoiceover ? 'Ardi/Gadis Neural' : 'Mute'}, Durasi: ${finalDuration}s)...`);
    const startTime = Date.now();
    try {
      await execAsync(cmd);
    } catch (primaryErr) {
      console.warn('[video-renderer] Multi-scene script gagal, mencoba fallback emergency render:', primaryErr.message);
      if (primaryErr.stderr) console.warn('[ffmpeg stderr]', primaryErr.stderr);
      try {
        const emergencyCmd = `${ffmpegBin} -y -f lavfi -i "color=c=0x070b14:s=1080x1920:d=${finalDuration}" ${audioArgs} -vf "drawbox=x=80:y=180:w=920:h=6:color=0x0ea5e9@0.9:t=fill,drawbox=x=80:y=1740:w=920:h=6:color=0x0ea5e9@0.9:t=fill,drawtext=text='NAVIGATE LIGHTING'${fontParam}:fontcolor=0x38bdf8:fontsize=52:x=(w-text_w)/2:y=240,drawbox=x=80:y=480:w=920:h=780:color=0x0f172a@0.9:t=fill,drawtext=text='${safeTopic}'${fontParam}:fontcolor=0xffffff:fontsize=40:x=(w-text_w)/2:y=540,drawtext=text='${safeHook}'${fontParam}:fontcolor=0xfacc15:fontsize=32:x=(w-text_w)/2:y=640,drawbox=x=120:y=1400:w=840:h=130:color=0x16a34a@0.95:t=fill,drawtext=text='${safeCta}'${fontParam}:fontcolor=0xffffff:fontsize=30:x=(w-text_w)/2:y=1445" -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -t ${finalDuration} "${outputPath}"`;
        await execAsync(emergencyCmd);
      } catch (secErr) {
        console.warn('[video-renderer] Emergency drawtext gagal, menggunakan foto produk Navigate asli...');
        const imageFile = activeProductImage && existsSync(activeProductImage)
          ? activeProductImage
          : defaultProductImage;
        const vcodecArg = isJpegFile(imageFile) ? '-vcodec mjpeg' : '';
        const stillCmd = `${ffmpegBin} -y -loop 1 -f image2 ${vcodecArg} -i "${imageFile}" ${audioArgs} -c:v libx264 -tune stillimage -c:a aac -b:a 128k -pix_fmt yuv420p -shortest -movflags +faststart -t ${finalDuration} "${outputPath}"`;
        await execAsync(stillCmd);
      }
    }

    if (!existsSync(outputPath)) {
      throw new Error(`Output file ${outputPath} tidak ditemukan setelah render selesai.`);
    }

    const elapsedMs = Date.now() - startTime;
    console.log(`[video-renderer] Render FFmpeg selesai dalam ${elapsedMs}ms: ${publicUrl}`);
    return {
      success: true,
      videoUrl: publicUrl,
      audioUrl: hasVoiceover ? audioPublicUrl : null,
      productImageUrl: activeProductPublicUrl,
      engine: 'ffmpeg_multi_scene',
      duration: finalDuration,
      elapsedMs,
      fileName: outputFileName,
    };
  } catch (err) {
    console.error('[video-renderer error]', err.message);
    if (err.stderr) console.error('[ffmpeg stderr]', err.stderr);
    return {
      success: false,
      reason: 'render_failed',
      error: err.message,
      stderr: err.stderr,
    };
  }
}
