import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'openCalory',
    short_name: 'openCalory',
    description: 'Offline-first, adherence-neutral calorie & macro tracking PWA',
    start_url: '/',
    display: 'standalone',
    background_color: '#121316',
    theme_color: '#121316',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
}
