import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['dev.brigata.ai'],
    proxy: {
      '/api': 'http://localhost:3030',
      '/ws': { target: 'ws://localhost:3030', ws: true },
    },
  },
})
