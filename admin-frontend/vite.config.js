import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Port fixed at 5174 to match backend/.env's ADMIN_ALLOWED_ORIGINS
// (see backend/src/server.js CORS setup) — changing this requires
// updating that env var too.
export default defineConfig({
  plugins: [react()],
<<<<<<< HEAD
  base: '/admin/',
=======
  base: '/',
>>>>>>> origin/main
  server: {
    port: 5174,
    strictPort: true,
  },
})
