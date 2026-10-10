import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built bundle can be dropped on any static host
  // (GitHub Pages project sites included) without rewriting asset paths.
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    // pdf.js ships a large worker bundle; keep the warning threshold realistic.
    chunkSizeWarningLimit: 1500,
  },
});
