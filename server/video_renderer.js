import { exec } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
 * Render video 9:16 (1080x1920) secara otomatis menggunakan FFmpeg lokal di VPS.
 * 100% Gratis, Cepat (~3-8 detik), Tanpa Biaya API / Tanpa Subscription.
 */
export async function renderAutomatedVideo({ postId, topic = 'Navigate LED', hook = '', script = '', duration = 8 }) {
  const installed = await isFFmpegInstalled();
  if (!installed) {
    console.warn('[video-renderer] FFmpeg tidak ditemukan. Install dengan: sudo apt install -y ffmpeg');
    return {
      success: false,
      reason: 'ffmpeg_not_installed',
      message: 'FFmpeg belum terinstall di server. Jalankan "sudo apt install -y ffmpeg" di VPS.',
    };
  }

  const safeTopic = sanitizeText(topic, 35) || 'NAVIGATE LIGHTING';
  const safeHook = sanitizeText(hook, 45) || 'SOLUSI PENCAHAYAAN PROYEK TERBAIK';
  const safeCta = 'HUBUNGI TIM SALES SEAN VIA WHATSAPP';
  
  const outputFileName = `post-${postId || Date.now()}.mp4`;
  const outputPath = `${videosDir}/${outputFileName}`;
  const publicUrl = `/videos/${outputFileName}`;

  // Font default di Linux Ubuntu
  const fontDejaVu = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontFreeSans = '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf';
  let fontParam = '';
  if (existsSync(fontDejaVu)) {
    fontParam = `:fontfile='${fontDejaVu}'`;
  } else if (existsSync(fontFreeSans)) {
    fontParam = `:fontfile='${fontFreeSans}'`;
  }

  // Filter kompleks FFmpeg: Background gradient gelap + layout teks 9:16 + badge + audio sintetis
  const filterGraph = [
    // 1. Background dark tech #0b1120
    `color=c=0x0b1329:s=1080x1920:d=${duration}`,
    // 2. Garis aksen cyan atas & bawah
    `drawbox=x=80:y=180:w=920:h=6:color=0x0ea5e9@0.9:t=fill`,
    `drawbox=x=80:y=1740:w=920:h=6:color=0x0ea5e9@0.9:t=fill`,
    // 3. Header Brand Navigate
    `drawtext=text='NAVIGATE LIGHTING'${fontParam}:fontcolor=0x38bdf8:fontsize=52:x=(w-text_w)/2:y=240`,
    `drawtext=text='PT FEIHONG TRADING INTERNATIONAL'${fontParam}:fontcolor=0x94a3b8:fontsize=28:x=(w-text_w)/2:y=310`,
    // 4. Box highlight tengah untuk Topik & Hook
    `drawbox=x=80:y=600:w=920:h=520:color=0x1e293b@0.85:t=fill`,
    `drawbox=x=80:y=600:w=920:h=520:color=0x38bdf8@0.5:t=2`,
    // 5. Teks Topik & Hook
    `drawtext=text='${safeTopic}'${fontParam}:fontcolor=0xffffff:fontsize=46:x=(w-text_w)/2:y=680`,
    `drawtext=text='${safeHook}'${fontParam}:fontcolor=0xfacc15:fontsize=36:x=(w-text_w)/2:y=800`,
    `drawtext=text='GARANSI RESMI NAVIGATE | IP65 WATERPROOF'${fontParam}:fontcolor=0x4ade80:fontsize=30:x=(w-text_w)/2:y=940`,
    // 6. Box Call To Action bawah
    `drawbox=x=120:y=1400:w=840:h=120:color=0x16a34a@0.95:t=fill`,
    `drawtext=text='${safeCta}'${fontParam}:fontcolor=0xffffff:fontsize=32:x=(w-text_w)/2:y=1445`,
  ].join(',');

  const cmd = `ffmpeg -y -f lavfi -i "${filterGraph}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -c:a aac -b:a 128k -t ${duration} "${outputPath}"`;

  try {
    console.log(`[video-renderer] Memulai render FFmpeg untuk Post #${postId}...`);
    const startTime = Date.now();
    await execAsync(cmd);
    const elapsedMs = Date.now() - startTime;
    console.log(`[video-renderer] Render selesai dalam ${elapsedMs}ms: ${publicUrl}`);
    return {
      success: true,
      videoUrl: publicUrl,
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
