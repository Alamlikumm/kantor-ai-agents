import React from 'react';
import { Composition } from 'remotion';
import { NavigateVideo } from './NavigateVideo.jsx';

export const RemotionRoot = () => {
  return (
    <Composition
      id="NavigateVideo"
      component={NavigateVideo}
      durationInFrames={300} // Default 10 detik @ 30 FPS (akan di-override dinamis oleh durasi audio)
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        topic: 'Navigate LED Flood Light 400W IP65 Outdoor',
        hook: 'SOLUSI PENCAHAYAAN PROYEK TAHAN BADAI',
        narration: 'Proyek lapangan dan gudang Anda butuh penerangan tangguh tahan badai? Kenalkan Navigate LED Flood Light 400 Watt IP65! Dilengkapi 8 modul COB super terang, bodi aluminium die-cast kokoh, dan garansi resmi PT Feihong Trading International.',
        cta: 'Hubungi WhatsApp Tim Sales Sean Sekarang!',
        specs: [
          '400 Watt Super Bright',
          'IP65 Waterproof & Anti Badai',
          'Garansi Resmi PT Feihong',
          'Bodi Aluminium Die-Cast Tebal',
        ],
        audioUrl: '',
        durationInSeconds: 10,
      }}
      calculateMetadata={async ({ props }) => {
        const sec = props.durationInSeconds && props.durationInSeconds > 0 ? props.durationInSeconds : 10;
        return {
          durationInFrames: Math.ceil(sec * 30),
          props,
        };
      }}
    />
  );
};
