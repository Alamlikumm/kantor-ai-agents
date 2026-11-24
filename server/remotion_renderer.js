import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(new URL('../remotion/index.js', import.meta.url));

let cachedBundleLocation = null;

/**
 * Cek apakah paket Remotion renderer & bundler terpasang.
 */
export async function isRemotionInstalled() {
  if (process.env.ENABLE_REMOTION !== 'true') {
    return false;
  }
  try {
    await import('@remotion/renderer');
    await import('@remotion/bundler');
    return true;
  } catch {
    return false;
  }
}

/**
 * Render video via Remotion Node API.
 */
export async function renderRemotionVideo({
  outputPath,
  inputProps,
  compositionId = 'NavigateVideo',
}) {
  const installed = await isRemotionInstalled();
  if (!installed) {
    return {
      success: false,
      reason: 'remotion_packages_missing',
      message: 'Paket Remotion belum terpasang. Jalankan "npm i remotion @remotion/renderer @remotion/bundler react react-dom"',
    };
  }

  try {
    const { bundle } = await import('@remotion/bundler');
    const { renderMedia, selectComposition } = await import('@remotion/renderer');

    console.log('[remotion] Memulai bundling komposisi Remotion...');
    const bundleStart = Date.now();
    if (!cachedBundleLocation || !existsSync(cachedBundleLocation)) {
      cachedBundleLocation = await bundle({
        entryPoint,
        // Minimal webpack config
      });
    }
    console.log(`[remotion] Bundle siap dalam ${Date.now() - bundleStart}ms`);

    const composition = await selectComposition({
      serveUrl: cachedBundleLocation,
      id: compositionId,
      inputProps,
    });

    console.log(`[remotion] Merender ${composition.durationInFrames} frames (${composition.fps} FPS) ke ${outputPath}...`);
    const renderStart = Date.now();

    await renderMedia({
      composition,
      serveUrl: cachedBundleLocation,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps,
      imageFormat: 'jpeg',
      parallelism: 2, // Hemat CPU & RAM di VPS
    });

    const elapsedMs = Date.now() - renderStart;
    console.log(`[remotion] Render video MP4 selesai dalam ${elapsedMs}ms`);

    return {
      success: true,
      elapsedMs,
    };
  } catch (err) {
    console.warn('[remotion render error]', err.message);
    return {
      success: false,
      reason: 'remotion_error',
      error: err.message,
    };
  }
}
