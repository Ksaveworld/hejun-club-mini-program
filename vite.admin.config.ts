import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],base:'/ops/',publicDir:false,
  server:{host:'127.0.0.1',proxy:{'/api':{target:'http://127.0.0.1:5187',changeOrigin:false},'/images':{target:'http://127.0.0.1:5187',changeOrigin:false}}},
  build:{target:'es2020',outDir:'work/admin-build',rollupOptions:{input:'ops/index.html'}},
});
