import { exec } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateEdgeTTS, VOICES } from './edge_tts.js';
import { isRemotionInstalled, renderRemotionVideo } from './remotion_renderer.js';

const execAsync = promisify(exec);

// Direktori output video
const videosDir = fileURLToPath(new URL('../dist/videos', import.meta.url));
if (!existsSync(videosDir)) {
  mkdirSync(videosDir, { recursive: true });
}

// Cek ketersediaan FFmpeg di sistem
export async function isFFmpegInstalled() {
  try {
    await execAsync('ffmpeg -version');
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
}) {
  const outputFileName = `post-${postId || Date.now()}.mp4`;
  const outputPath = `${videosDir}/${outputFileName}`;
  const publicUrl = `/videos/${outputFileName}`;

  const audioFileName = `audio-${postId || Date.now()}.mp3`;
  const audioPath = `${videosDir}/${audioFileName}`;
  const audioPublicUrl = `/videos/${audioFileName}`;

  // 1. Sintesis Suara Manusia Real Bahasa Indonesia via Edge-TTS
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

  // 2. Coba Render dengan Remotion (React Framework) jika dependensi terpasang
  const remotionInstalled = await isRemotionInstalled();
  if (remotionInstalled) {
    try {
      console.log(`[video-renderer] Merender video dengan Remotion Engine...`);
      const remotionRes = await renderRemotionVideo({
        outputPath,
        inputProps: {
          topic,
          hook,
          narration: narrationText,
          specs: specs.length > 0 ? specs : ['Garansi Resmi PT Feihong', 'IP65 Weatherproof', 'Kualitas Standar Proyek'],
          cta,
          audioUrl: hasVoiceover ? audioPath : '',
          durationInSeconds: finalDuration,
        },
      });

      if (remotionRes.success) {
        return {
          success: true,
          videoUrl: publicUrl,
          audioUrl: hasVoiceover ? audioPublicUrl : null,
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

  // 3. Fallback High-Quality FFmpeg Renderer (Sudah Ditingkatkan dengan Suara Edge-TTS & Spesifikasi Real)
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

  // Font default di Linux Ubuntu
  const fontDejaVu = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontFreeSans = '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf';
  let fontParam = '';
  if (existsSync(fontDejaVu)) {
    fontParam = `:fontfile='${fontDejaVu}'`;
  } else if (existsSync(fontFreeSans)) {
    fontParam = `:fontfile='${fontFreeSans}'`;
  }

  // Filter kompleks FFmpeg: Background dark tech #0b1329 + Header + Topik + 3 Spek Real + Box CTA
  const filterGraph = [
    `color=c=0x070b14:s=1080x1920:d=${finalDuration}`,
    // Garis aksen cyan atas & bawah
    `drawbox=x=80:y=180:w=920:h=6:color=0x0ea5e9@0.9:t=fill`,
    `drawbox=x=80:y=1740:w=920:h=6:color=0x0ea5e9@0.9:t=fill`,
    // Header Brand Navigate
    `drawtext=text='NAVIGATE LIGHTING'${fontParam}:fontcolor=0x38bdf8:fontsize=52:x=(w-text_w)/2:y=240`,
    `drawtext=text='PT FEIHONG TRADING INTERNATIONAL'${fontParam}:fontcolor=0x94a3b8:fontsize=28:x=(w-text_w)/2:y=310`,
    // Box highlight tengah untuk Topik & Hook
    `drawbox=x=80:y=480:w=920:h=780:color=0x0f172a@0.9:t=fill`,
    `drawbox=x=80:y=480:w=920:h=780:color=0x38bdf8@0.5:t=2`,
    // Teks Topik & Hook
    `drawtext=text='${safeTopic}'${fontParam}:fontcolor=0xffffff:fontsize=44:x=(w-text_w)/2:y=540`,
    `drawtext=text='${safeHook}'${fontParam}:fontcolor=0xfacc15:fontsize=36:x=(w-text_w)/2:y=640`,
    // 3 Kartu Spesifikasi Real Produk Navigate
    `drawbox=x=120:y=760:w=840:h=90:color=0x1e293b@0.9:t=fill`,
    `drawtext=text='V  ${safeSpec1}'${fontParam}:fontcolor=0x4ade80:fontsize=32:x=(w-text_w)/2:y=790`,
    `drawbox=x=120:y=880:w=840:h=90:color=0x1e293b@0.9:t=fill`,
    `drawtext=text='V  ${safeSpec2}'${fontParam}:fontcolor=0x38bdf8:fontsize=32:x=(w-text_w)/2:y=910`,
    `drawbox=x=120:y=1000:w=840:h=90:color=0x1e293b@0.9:t=fill`,
    `drawtext=text='V  ${safeSpec3}'${fontParam}:fontcolor=0xfbcfe8:fontsize=32:x=(w-text_w)/2:y=1030`,
    // Indikator Voiceover Alami
    `drawtext=text='(Audio: Voiceover Narasi Alami Bahasa Indonesia)'${fontParam}:fontcolor=0x94a3b8:fontsize=24:x=(w-text_w)/2:y=1160`,
    // Box Call To Action bawah
    `drawbox=x=120:y=1400:w=840:h=130:color=0x16a34a@0.95:t=fill`,
    `drawtext=text='${safeCta}'${fontParam}:fontcolor=0xffffff:fontsize=32:x=(w-text_w)/2:y=1445`,
    `drawtext=text='Dapatkan Penawaran Proyek & Pricelist Resmi'${fontParam}:fontcolor=0xdcfce7:fontsize=22:x=(w-text_w)/2:y=1490`,
  ].join(',');

  // Gunakan audio Edge-TTS asli jika ada, fallback ke anullsrc jika tidak
  const audioInput = hasVoiceover
    ? `-i "${audioPath}" -c:a aac -b:a 128k`
    : `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:a aac -b:a 128k`;

  const cmd = `ffmpeg -y -f lavfi -i "${filterGraph}" ${audioInput} -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -t ${finalDuration} "${outputPath}"`;

  try {
    console.log(`[video-renderer] Memulai render FFmpeg (Audio: ${hasVoiceover ? 'Edge-TTS' : 'Mute'}, Durasi: ${finalDuration}s)...`);
    const startTime = Date.now();
    await execAsync(cmd);
    const elapsedMs = Date.now() - startTime;
    console.log(`[video-renderer] Render FFmpeg selesai dalam ${elapsedMs}ms: ${publicUrl}`);
    return {
      success: true,
      videoUrl: publicUrl,
      audioUrl: hasVoiceover ? audioPublicUrl : null,
      engine: 'ffmpeg_with_edgetts',
      duration: finalDuration,
      elapsedMs,
      fileName: outputFileName,
    };
  } catch (err) {
    console.error('[video-renderer error]', err.message);
    return {
      success: false,
      reason: 'render_failed',
      error: err.message,
    };
  }
}
