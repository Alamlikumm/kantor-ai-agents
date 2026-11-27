// Menggabungkan klip AI (hasil render n8n → Fal.ai/Kling) menjadi 1 video Reels 9:16
// + voiceover Edge-TTS + teks overlay per scene. Dipanggil oleh /api/pipeline/attach-clips.
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateEdgeTTS, VOICES } from './edge_tts.js';
import { getFFmpegBinary } from './video_renderer.js';

const execAsync = promisify(exec);

// Path aman untuk dipakai di dalam filtergraph FFmpeg (Windows: C\:/...)
const ffPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

// Roboto tidak punya glyph emoji → buang emoji & markdown dari teks overlay
function cleanOverlay(str = '') {
  return String(str)
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/[*_`#]/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// `ffmpeg -i file` selalu exit error (tanpa output), tapi stderr memuat "Duration: HH:MM:SS.xx"
async function probeDuration(file) {
  let out = '';
  try {
    const r = await execAsync(`${getFFmpegBinary()} -hide_banner -i "${file}"`);
    out = r.stderr;
  } catch (e) {
    out = e.stderr || '';
  }
  const m = String(out).match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal download klip (${res.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * @param {object} o
 * @param {number|string} o.postId
 * @param {Array<{url:string, overlay_text?:string}>} o.clips  urut sesuai scene
 * @param {string} [o.voiceoverText]
 * @param {string} o.videosDir  folder statis /videos
 */
export async function assembleClips({ postId, clips, voiceoverText = '', videosDir }) {
  const started = Date.now();
  if (!Array.isArray(clips) || clips.length === 0) {
    return { success: false, error: 'Tidak ada klip untuk digabung.' };
  }

  const workDir = join(tmpdir(), `kantor-clips-${postId}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  try {
    // 1. Download semua klip dari CDN Fal.ai (paralel)
    const clipPaths = clips.map((_, i) => join(workDir, `clip-${i + 1}.mp4`));
    await Promise.all(clips.map((c, i) => download(c.url, clipPaths[i])));

    // 2. Voiceover (opsional — kalau TTS gagal, video tetap jadi tanpa suara VO)
    let audioPath = null;
    if (voiceoverText.trim()) {
      const vo = join(workDir, 'voiceover.mp3');
      const tts = await generateEdgeTTS({ text: voiceoverText, outputPath: vo, voice: VOICES.GADIS }).catch((e) => ({ success: false, error: e.message }));
      if (tts?.success && existsSync(vo)) audioPath = vo;
      else console.warn('[clip-assembler] Voiceover dilewati:', tts?.error);
    }

    // Total durasi video = jumlah durasi klip (dibaca dari header "Duration:" FFmpeg)
    const durations = await Promise.all(clipPaths.map(probeDuration));
    const totalDur = durations.reduce((a, b) => a + b, 0) || clips.length * 5;

    // 3. Filtergraph: normalisasi tiap klip ke 1080x1920@30fps (+ overlay teks) → concat
    const font = fileURLToPath(new URL('./assets/Roboto-Bold.ttf', import.meta.url));
    const fontParam = existsSync(font) ? `:fontfile='${ffPath(font)}'` : '';
    const buildFilter = (withText) => {
      const parts = clips.map((c, i) => {
        // Mode tanpa teks hanya pakai filter dasar (scale/crop/format) agar jalan di FFmpeg minimal
        let chain = `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`
          + (withText ? ',setsar=1,fps=30' : '') + ',format=yuv420p';
        const text = withText ? cleanOverlay(c.overlay_text) : '';
        if (text) {
          const txtFile = join(workDir, `overlay-${i + 1}.txt`);
          writeFileSync(txtFile, text, 'utf8');
          chain += `,drawbox=x=0:y=150:w=iw:h=140:color=black@0.45:t=fill`
            + `,drawtext=textfile='${ffPath(txtFile)}'${fontParam}:fontcolor=white:fontsize=46:x=(w-text_w)/2:y=195`;
        }
        return `${chain}[v${i}]`;
      });
      parts.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);
      // VO dipadatkan/dipotong tepat sepanjang video (apad + -shortest bisa menggantung)
      if (audioPath) parts.push(`[${clips.length}:a]apad,atrim=0:${totalDur.toFixed(2)}[aout]`);
      const filterFile = join(workDir, withText ? 'filter-text.txt' : 'filter-plain.txt');
      writeFileSync(filterFile, parts.join(';\n'), 'utf8');
      return filterFile;
    };

    if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
    const fileName = `post-${postId}-ai-${Date.now()}.mp4`;
    const outputPath = join(videosDir, fileName);

    const inputs = clipPaths.map((p) => `-i "${p}"`).join(' ') + (audioPath ? ` -i "${audioPath}"` : '');
    const maps = audioPath ? '-map "[vout]" -map "[aout]" -c:a aac -b:a 128k' : '-map "[vout]" -an';
    const run = (filterFile) => execAsync(
      `${getFFmpegBinary()} -y ${inputs} -filter_complex_script "${filterFile}" ${maps} -r 30 -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -movflags +faststart "${outputPath}"`,
      { maxBuffer: 1024 * 1024 * 20 },
    );
    try {
      await run(buildFilter(true));
    } catch (textErr) {
      // FFmpeg tanpa libfreetype (mis. binary bawaan Remotion) tidak punya drawtext → ulang tanpa teks
      console.warn('[clip-assembler] Overlay teks gagal, ulang tanpa teks:', String(textErr.stderr || textErr.message).slice(-300));
      await run(buildFilter(false));
    }

    if (!existsSync(outputPath)) throw new Error('FFmpeg selesai tapi file output tidak ditemukan.');
    return { success: true, videoUrl: `/videos/${fileName}`, elapsedMs: Date.now() - started, engine: 'fal_kling_n8n' };
  } catch (err) {
    console.error('[clip-assembler error]', err.stderr || err.message);
    return { success: false, error: err.message };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
