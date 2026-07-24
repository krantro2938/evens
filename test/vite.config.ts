import { defineConfig } from 'vite'

// The markdown server (see /server) runs on a different origin, which the
// simulator's webview refuses to open a cross-origin EventSource against.
// Proxy /markdown and /events through Vite so the app talks to them
// same-origin. Point the proxy elsewhere with VITE_MD_TARGET.
const MD_TARGET = process.env.VITE_MD_TARGET ?? 'http://192.168.0.117:8787'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/markdown': { target: MD_TARGET, changeOrigin: true },
      '/events': { target: MD_TARGET, changeOrigin: true },
    },
  },
  build: { target: 'esnext' },
})
