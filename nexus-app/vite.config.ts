import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Only use basicSsl in development for LAN camera access
    // In production, Coolify/nginx handles SSL
    ...(mode === 'development' ? [basicSsl()] : []),
  ],
  server: {
    host: '0.0.0.0',  // Listen on all network interfaces for LAN access
    port: 5173,
  },
}))
