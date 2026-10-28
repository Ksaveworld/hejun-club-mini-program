import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// No API proxy. Separate from ops build and no production navigation entry.
export default defineConfig({ plugins: [react()], publicDir: false, server: { host: '127.0.0.1', port: 51894, strictPort: true }, build: { outDir: 'work/grant-preview-build', rollupOptions: { input: 'grant-preview/index.html' } } });
