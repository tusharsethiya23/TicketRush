import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000. Proxying keeps the app and the API on one
// origin, so the SameSite=Strict refresh cookie is sent (FR-20).
const api = { target: 'http://localhost:4000', changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': api, '/health': api, '/docs': api } },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    globals: true,
    restoreMocks: true,
  },
});
