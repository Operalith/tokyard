export default function manifest() {
  return {
    name: 'TokYard — Shared AI access',
    short_name: 'TokYard',
    description: 'One workspace for AI accounts, people and token allowances.',
    start_url: '/',
    display: 'standalone',
    background_color: '#187553',
    theme_color: '#187553',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/favicon.svg',
        sizes: '192x192',
        type: 'image/svg+xml',
      },
      {
        src: '/favicon.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
      },
      {
        src: '/favicon.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  }
}
