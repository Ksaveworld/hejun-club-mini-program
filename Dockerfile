FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
RUN node -e "Promise.all([import('sharp').then(m=>m.default({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer()),import('pdf-lib').then(async m=>{const d=await m.PDFDocument.create();d.addPage();return d.save()})]).catch(()=>process.exit(1))"
COPY server ./server
COPY shared ./shared
COPY miniprogram/data ./miniprogram/data
COPY public ./public
ENV PORT=8080 NODE_ENV=migration
USER node
EXPOSE 8080
CMD ["node", "server/cloudrun-index.mjs"]
