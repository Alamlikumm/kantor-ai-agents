import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const videosDir = fileURLToPath(new URL('../dist/videos', import.meta.url));
if (!existsSync(videosDir)) {
  mkdirSync(videosDir, { recursive: true });
}

/**
 * Generate fallback high-tech SVG graphic of Navigate industrial light if AI image API is offline.
 */
function createFallbackProductSvg({ topic, specs = [] }) {
  const safeTopic = (topic || 'NAVIGATE LED').replace(/['"&<>\\]/g, '');
  const spec1 = (specs[0] || 'IP65 Weatherproof').replace(/['"&<>\\]/g, '');
  const spec2 = (specs[1] || 'Industrial Heavy Duty').replace(/['"&<>\\]/g, '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <radialGradient id="bgGlow" cx="50%" cy="45%" r="50%">
      <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#070b14" stop-opacity="1"/>
    </radialGradient>
    <linearGradient id="beam" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#0284c7" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="housing" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#334155"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="15" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1080" height="1080" fill="url(#bgGlow)"/>

  <!-- Light Beam Cone -->
  <polygon points="540,430 200,980 880,980" fill="url(#beam)" opacity="0.65"/>

  <!-- Product Shadow -->
  <ellipse cx="540" cy="780" rx="360" ry="40" fill="#000000" opacity="0.6"/>

  <!-- Lamp Bracket (Mount) -->
  <path d="M 280,450 L 320,320 L 760,320 L 800,450" fill="none" stroke="#64748b" stroke-width="20" stroke-linecap="round"/>

  <!-- Main Industrial Floodlight Body -->
  <rect x="290" y="340" width="500" height="340" rx="28" fill="url(#housing)" stroke="#38bdf8" stroke-width="6"/>

  <!-- Heat Sink Fins Texture -->
  <line x1="330" y1="365" x2="750" y2="365" stroke="#475569" stroke-width="6"/>
  <line x1="330" y1="385" x2="750" y2="385" stroke="#475569" stroke-width="6"/>

  <!-- Front Lens Glass & Reflector -->
  <rect x="330" y="415" width="420" height="230" rx="16" fill="#0b1329" stroke="#0ea5e9" stroke-width="4"/>

  <!-- 8 Multi-Module LED Matrix (Glowing Yellow/White) -->
  <g fill="#fef08a" filter="url(#glow)">
    <circle cx="390" cy="480" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="490" cy="480" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="590" cy="480" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="690" cy="480" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="390" cy="570" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="490" cy="570" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="590" cy="570" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
    <circle cx="690" cy="570" r="28" fill="#ffffff" stroke="#facc15" stroke-width="6"/>
  </g>

  <!-- Brand Plate on Product -->
  <rect x="440" y="380" width="200" height="26" rx="6" fill="#0284c7"/>
  <text x="540" y="398" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#ffffff" text-anchor="middle" letter-spacing="3">NAVIGATE</text>

  <!-- Badge Spesifikasi Melayang -->
  <g>
    <rect x="140" y="860" width="360" height="64" rx="32" fill="#0f172a" stroke="#22c55e" stroke-width="3"/>
    <text x="320" y="902" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#4ade80" text-anchor="middle">✓ ${spec1}</text>

    <rect x="580" y="860" width="360" height="64" rx="32" fill="#0f172a" stroke="#38bdf8" stroke-width="3"/>
    <text x="760" y="902" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#38bdf8" text-anchor="middle">⚡ ${spec2}</text>
  </g>

  <!-- Title Bottom -->
  <text x="540" y="980" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#94a3b8" text-anchor="middle" letter-spacing="2">${safeTopic}</text>
</svg>`;
}

/**
 * Generate Visual Foto Produk Realistis untuk Navigate Lighting:
 * - Menggunakan Flux AI Image Engine (100% Gratis, Tanpa API Key).
 * - Fallback instan ke high-res vector visual card jika offline / timeout.
 */
export async function generateProductImage({ postId, topic = 'Navigate LED Flood Light', specs = [] }) {
  const fileName = `product-${postId || Date.now()}.png`;
  const outputPath = `${videosDir}/${fileName}`;
  const publicUrl = `/videos/${fileName}`;

  const prompt = `Commercial product photography of ${topic}, heavy-duty black aluminum housing, tempered glass, high-power COB LED modules emitting powerful warm white illumination, dark modern architectural background with subtle cyan rim lighting, 8k resolution, cinematic lighting, sleek photorealistic product ad`;

  const seed = Math.floor(Math.random() * 1000000);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1080&height=1080&nologo=true&model=flux&seed=${seed}`;

  try {
    console.log(`[gavin-visual] Gavin merender foto produk AI (FLUX) untuk: "${topic}"...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout

    const res = await fetch(pollinationsUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer && buffer.length > 5000) {
        const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
        const actualFileName = isJpeg ? `product-${postId || Date.now()}.jpg` : `product-${postId || Date.now()}.png`;
        const actualOutputPath = `${videosDir}/${actualFileName}`;
        const actualPublicUrl = `/videos/${actualFileName}`;
        writeFileSync(actualOutputPath, buffer);
        console.log(`[gavin-visual] Foto produk AI berhasil diunduh (${(buffer.length / 1024).toFixed(0)} KB): ${actualPublicUrl}`);
        return {
          success: true,
          imagePath: actualOutputPath,
          publicUrl: actualPublicUrl,
          engine: 'flux_ai',
        };
      }
    }
  } catch (err) {
    console.warn('[gavin-visual] Flux AI fetch dilewati atau timeout, beralih ke vector renderer:', err.message);
  }

  // Fallback: Tulis SVG beresolusi tinggi jika jaringan luar lambat
  try {
    const svgContent = createFallbackProductSvg({ topic, specs });
    const svgPath = `${videosDir}/product-${postId || Date.now()}.svg`;
    writeFileSync(svgPath, svgContent);
    console.log(`[gavin-visual] Vector render produk Navigate siap: ${svgPath}`);
    return {
      success: true,
      imagePath: svgPath,
      publicUrl: `/videos/product-${postId || Date.now()}.svg`,
      engine: 'vector_svg',
    };
  } catch (fallbackErr) {
    console.error('[gavin-visual] Gagal membuat fallback image:', fallbackErr.message);
    return {
      success: false,
      error: fallbackErr.message,
    };
  }
}
