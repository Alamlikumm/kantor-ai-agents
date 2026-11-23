import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const NavigateVideo = ({
  topic = 'NAVIGATE LIGHTING',
  hook = 'SOLUSI PENCAHAYAAN PROYEK TERBAIK',
  narration = '',
  specs = [],
  cta = 'Hubungi Tim Sales Sean via WhatsApp',
  audioUrl = '',
  productImageUrl = '',
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Animasi Header entrance (Frame 0 - 25)
  const headerSpring = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.8 },
  });
  const headerOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  // Animasi Hook Text entrance (Frame 15 - 45)
  const hookSpring = spring({
    frame: frame - 15,
    fps,
    config: { damping: 12, mass: 1 },
  });
  const hookScale = interpolate(hookSpring, [0, 1], [0.85, 1]);

  // Ken-Burns Effect: Zoom perlahan pada foto produk
  const productZoom = interpolate(frame, [0, durationInFrames], [1.0, 1.09], { extrapolateRight: 'clamp' });

  // Ambient Lighting Pulse Effect (Lampu Navigate berdenyut elegan)
  const pulse = Math.sin((frame / fps) * Math.PI * 1.5) * 0.15 + 0.85;

  // Staggered Spec Cards
  const specItems = Array.isArray(specs) && specs.length > 0 ? specs : [
    'Garansi Resmi PT Feihong',
    'Sertifikasi IP65 Tahan Cuaca',
    'Efisiensi Cahaya Tinggi',
    'Ready Stock Gudang Jakarta',
  ];

  // CTA Button Entrance (Muncul kuat mulai detik ke-2 dan berkedip halus)
  const ctaSpring = spring({
    frame: frame - 60,
    fps,
    config: { damping: 15, mass: 0.9 },
  });
  const ctaScale = interpolate(ctaSpring, [0, 1], [0.9, 1]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#070b14',
        backgroundImage: 'radial-gradient(circle at 50% 35%, rgba(14, 165, 233, 0.22) 0%, rgba(7, 11, 20, 0.98) 75%)',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '100px 60px 120px 60px',
        overflow: 'hidden',
      }}
    >
      {/* Background Decorative Tech Grid */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundImage:
            'linear-gradient(rgba(56, 189, 248, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(56, 189, 248, 0.05) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          opacity: 0.8,
          pointerEvents: 'none',
        }}
      />

      {/* Glow Center Beam (Simulasi Sorotan Cahaya Lampu Navigate) */}
      <div
        style={{
          position: 'absolute',
          top: '25%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '700px',
          height: '500px',
          background: 'radial-gradient(ellipse at center, rgba(56, 189, 248, 0.35) 0%, rgba(14, 165, 233, 0) 70%)',
          filter: 'blur(50px)',
          opacity: pulse,
          pointerEvents: 'none',
        }}
      />

      {/* 1. BRAND HEADER */}
      <div
        style={{
          opacity: headerOpacity,
          transform: `translateY(${(1 - headerSpring) * -40}px)`,
          textAlign: 'center',
          zIndex: 10,
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 28px',
            borderRadius: '999px',
            backgroundColor: 'rgba(14, 165, 233, 0.15)',
            border: '1px solid rgba(56, 189, 248, 0.4)',
            marginBottom: '20px',
          }}
        >
          <span style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#38bdf8', boxShadow: '0 0 12px #38bdf8' }} />
          <span style={{ fontSize: '24px', letterSpacing: '4px', fontWeight: 800, color: '#38bdf8' }}>
            NAVIGATE LIGHTING
          </span>
        </div>
        <div style={{ fontSize: '20px', letterSpacing: '2px', color: '#94a3b8', fontWeight: 500 }}>
          PT FEIHONG TRADING INTERNATIONAL
        </div>
      </div>

      {/* 2. CENTER CONTENT & PRODUCT CARD */}
      <div
        style={{
          width: '100%',
          maxWidth: '920px',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '35px',
        }}
      >
        {/* Hook Headline */}
        <div
          style={{
            transform: `scale(${hookScale})`,
            opacity: frame < 15 ? 0 : 1,
            textAlign: 'center',
            padding: '0 20px',
          }}
        >
          <div
            style={{
              fontSize: '44px',
              fontWeight: 900,
              lineHeight: 1.25,
              color: '#facc15',
              textShadow: '0 4px 20px rgba(250, 204, 21, 0.35)',
              textTransform: 'uppercase',
            }}
          >
            {hook}
          </div>
          <div
            style={{
              marginTop: '16px',
              fontSize: '34px',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '0.5px',
            }}
          >
            {topic}
          </div>
        </div>

        {/* Hero Product Image Container */}
        {productImageUrl ? (
          <div
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '24px',
            }}
          >
            <div
              style={{
                width: '100%',
                maxHeight: '620px',
                height: '620px',
                borderRadius: '28px',
                overflow: 'hidden',
                backgroundColor: '#030712',
                border: '2px solid rgba(56, 189, 248, 0.6)',
                boxShadow: '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 45px rgba(14, 165, 233, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
              }}
            >
              <Img
                src={productImageUrl}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  transform: `scale(${productZoom})`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '20px',
                  right: '20px',
                  backgroundColor: 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  padding: '8px 18px',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 800,
                  color: '#38bdf8',
                  letterSpacing: '1px',
                }}
              >
                PRODUK RESMI
              </div>
            </div>

            {/* Floating Spec Badges Horizontal Row */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '14px',
                width: '100%',
              }}
            >
              {specItems.slice(0, 3).map((spec, i) => (
                <div
                  key={i}
                  style={{
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    borderRadius: '999px',
                    padding: '12px 24px',
                    fontSize: '22px',
                    fontWeight: 700,
                    color: i === 0 ? '#4ade80' : i === 1 ? '#38bdf8' : '#facc15',
                    boxShadow: '0 8px 20px rgba(0, 0, 0, 0.5)',
                  }}
                >
                  ✓ {spec}
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Fallback Real Product Feature Box jika tanpa gambar */
          <div
            style={{
              width: '100%',
              backgroundColor: 'rgba(15, 23, 42, 0.85)',
              border: '2px solid rgba(56, 189, 248, 0.5)',
              borderRadius: '24px',
              padding: '36px 30px',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), 0 0 30px rgba(14, 165, 233, 0.25)',
              backdropFilter: 'blur(16px)',
            }}
          >
            <div
              style={{
                fontSize: '22px',
                fontWeight: 800,
                letterSpacing: '3px',
                color: '#38bdf8',
                textTransform: 'uppercase',
                marginBottom: '24px',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
              }}
            >
              <span>⚡</span> SPESIFIKASI STANDAR PROYEK <span>⚡</span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: '16px',
              }}
            >
              {specItems.map((spec, i) => {
                const startFrame = 35 + i * 12;
                const itemSpring = spring({
                  frame: frame - startFrame,
                  fps,
                  config: { damping: 14, mass: 0.8 },
                });
                const itemOpacity = interpolate(frame, [startFrame, startFrame + 10], [0, 1], { extrapolateRight: 'clamp' });

                return (
                  <div
                    key={i}
                    style={{
                      opacity: frame < startFrame ? 0 : itemOpacity,
                      transform: `translateX(${(1 - itemSpring) * -30}px)`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '16px',
                      padding: '16px 22px',
                      borderRadius: '16px',
                      backgroundColor: 'rgba(30, 41, 59, 0.7)',
                      border: '1px solid rgba(148, 163, 184, 0.2)',
                    }}
                  >
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        backgroundColor: '#22c55e',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '18px',
                        fontWeight: 900,
                        color: '#ffffff',
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </div>
                    <div style={{ fontSize: '26px', fontWeight: 700, color: '#f1f5f9' }}>
                      {spec}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Dynamic Voiceover Subtitle Display */}
        {narration && (
          <div
            style={{
              width: '100%',
              backgroundColor: 'rgba(2, 6, 23, 0.75)',
              borderRadius: '18px',
              padding: '20px 26px',
              border: '1px dashed rgba(56, 189, 248, 0.35)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '18px', color: '#94a3b8', marginBottom: '6px', fontWeight: 600 }}>
              🎙️ Narasi Voiceover:
            </div>
            <div style={{ fontSize: '22px', lineHeight: 1.45, color: '#e2e8f0', fontWeight: 500, fontStyle: 'italic' }}>
              "{narration}"
            </div>
          </div>
        )}
      </div>

      {/* 3. CALL TO ACTION FOOTER */}
      <div
        style={{
          width: '100%',
          maxWidth: '920px',
          zIndex: 10,
          transform: `scale(${ctaScale})`,
          opacity: frame < 50 ? 0 : 1,
        }}
      >
        <div
          style={{
            backgroundColor: '#16a34a',
            backgroundImage: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
            borderRadius: '24px',
            padding: '24px 30px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '18px',
            boxShadow: '0 12px 35px rgba(22, 163, 74, 0.5), 0 0 20px rgba(34, 197, 94, 0.3)',
            border: '2px solid rgba(255, 255, 255, 0.3)',
          }}
        >
          <div style={{ fontSize: '36px' }}>💬</div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: '30px', fontWeight: 900, color: '#ffffff', letterSpacing: '1px' }}>
              {cta}
            </div>
            <div style={{ fontSize: '20px', color: '#dcfce7', fontWeight: 600 }}>
              Dapatkan Katalog Lengkap & Penawaran Harga Proyek
            </div>
          </div>
        </div>
      </div>

      {/* Voiceover Audio Component */}
      {audioUrl && <Audio src={audioUrl} />}
    </AbsoluteFill>
  );
};
