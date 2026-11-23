import { exec } from 'node:child_process';
import { createWriteStream, existsSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Voice default bahasa Indonesia Microsoft Edge Neural
export const VOICES = {
  GADIS: 'id-ID-GadisNeural', // Suara wanita ramah, jernih & profesional
  ARDI: 'id-ID-ArdiNeural',   // Suara pria energik & meyakinkan
};

/**
 * Cek apakah command line `edge-tts` (Python) terinstall di sistem.
 */
export async function isEdgeTTSCliInstalled() {
  try {
    await execAsync('edge-tts --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Escape teks aman untuk shell command.
 */
function escapeShellArg(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/**
 * Sintesis suara via WebSocket Microsoft Edge TTS (Pure Node.js, tanpa dependensi eksternal).
 */
async function synthesizeViaWebSocket({ text, outputPath, voice = VOICES.GADIS }) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Global WebSocket tidak tersedia di runtime Node.js ini');
  }

  const endpoint = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readahead/edge/v1?TrustedClientToken=6A5AA1D4EA654941A3D3E052100892';
  const reqId = Math.random().toString(36).substring(2) + Date.now().toString(36);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      },
    });

    const fileStream = createWriteStream(outputPath);
    let hasReceivedAudio = false;

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      fileStream.close();
      if (existsSync(outputPath) && !hasReceivedAudio) {
        try { unlinkSync(outputPath); } catch {}
      }
      reject(new Error('Edge-TTS WebSocket timeout (15s)'));
    }, 15000);

    ws.onopen = () => {
      // 1. Kirim speech.config
      const speechConfig = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      });
      const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`;
      ws.send(configMsg);

      // 2. Kirim SSML teks
      const escapedXml = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='id-ID'><voice name='${voice}'>${escapedXml}</voice></speak>`;
      const ssmlMsg = `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg);
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          fileStream.end(() => {
            resolve({ success: true, audioPath: outputPath, voice });
          });
        }
      } else if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data) || event.data instanceof Blob) {
        let buffer;
        if (event.data instanceof ArrayBuffer) {
          buffer = Buffer.from(event.data);
        } else if (Buffer.isBuffer(event.data)) {
          buffer = event.data;
        } else if (typeof event.data.arrayBuffer === 'function') {
          const ab = await event.data.arrayBuffer();
          buffer = Buffer.from(ab);
        }

        if (buffer && buffer.length > 2) {
          const headerLength = buffer.readUInt16BE(0);
          if (buffer.length > headerLength + 2) {
            const audioData = buffer.subarray(headerLength + 2);
            fileStream.write(audioData);
            hasReceivedAudio = true;
          }
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      fileStream.close();
      reject(err);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      fileStream.close();
      if (hasReceivedAudio) {
        resolve({ success: true, audioPath: outputPath, voice });
      }
    };
  });
}

/**
 * Generate Voiceover MP3 menggunakan Edge-TTS (100% Gratis, Suara Alami Bahasa Indonesia).
 */
export async function generateEdgeTTS({ text, outputPath, voice = VOICES.GADIS }) {
  if (!text || !text.trim()) {
    return { success: false, error: 'Teks voiceover kosong' };
  }

  const cleanText = text
    .replace(/[#*`_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Opsi 1: Cek apakah CLI `edge-tts` (Python) tersedia di server
  const cliAvailable = await isEdgeTTSCliInstalled();
  if (cliAvailable) {
    try {
      console.log(`[edge-tts] Mensintesis audio via CLI edge-tts (Voice: ${voice})...`);
      const cmd = `edge-tts --voice ${voice} --text ${escapeShellArg(cleanText)} --write-media ${escapeShellArg(outputPath)}`;
      await execAsync(cmd);
      if (existsSync(outputPath)) {
        return { success: true, audioPath: outputPath, voice, method: 'cli' };
      }
    } catch (cliErr) {
      console.warn('[edge-tts cli error, beralih ke websocket]', cliErr.message);
    }
  }

  // Opsi 2: Gunakan native WebSocket langsung ke Microsoft Edge TTS
  try {
    console.log(`[edge-tts] Mensintesis audio via native WebSocket (Voice: ${voice})...`);
    const res = await synthesizeViaWebSocket({ text: cleanText, outputPath, voice });
    return { ...res, method: 'websocket' };
  } catch (wsErr) {
    console.error('[edge-tts websocket error]', wsErr.message);
    return {
      success: false,
      error: `Gagal sintesis Edge-TTS: ${wsErr.message}. Pasang python CLI: pip install edge-tts`,
    };
  }
}
