import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: 'protect-local-business-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let path: string;
        try { path = decodeURIComponent((req.url || '/').split('?')[0]).replaceAll('\\', '/'); }
        catch { res.statusCode = 400; res.end('Invalid path'); return; }
        // Block private directories before Vite's SPA fallback, including /@fs/ paths.
        if (/(?:^|\/)(?:work|server|scripts|tests|tasks|\.git|\.work[^/]*|交付文件)(?:\/|$)/.test(path)
          || /(?:^|\/)(?:project-notes\.md|README\.md|\.impeccable\.md)$/.test(path)) {
          res.statusCode = 403; res.end('Private workspace file'); return;
        }
        next();
      });
    },
  }],
  build: { target: "es2020" },
  server: {
    proxy: { "/api": process.env.CLUB_API_TARGET || "http://127.0.0.1:5187" },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/work/**', '**/.work*/**', '**/server/**', '**/scripts/**', '**/tests/**', '**/交付文件/**'] },
  },
  preview: { proxy: { "/api": "http://127.0.0.1:5187" } },
});
