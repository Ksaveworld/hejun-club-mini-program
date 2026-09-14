// Run manually when updating the self-hosted Google Fonts assets. No build-time network.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const destination = new URL('../public/fonts/noto-sc/', import.meta.url);
await mkdir(destination, { recursive: true });
const cssUrl = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400..600&family=Noto+Serif+SC:wght@500..600&display=swap';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const response = await fetch(cssUrl, { headers: { 'User-Agent': userAgent } });
if (!response.ok) throw new Error(`Font CSS: ${response.status}`);
let css = await response.text();
if (!css.includes('woff2') || !css.includes('unicode-range')) throw new Error('Expected segmented WOFF2 fonts');
const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g)].map(match => match[1]))];
const manifest = [];
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < urls.length) {
    const url = urls[cursor++];
    const family = url.includes('/notoserifsc/') ? 'serif' : 'sans';
    const name = `${family}-${createHash('sha256').update(url).digest('hex').slice(0,12)}.woff2`;
    const file = new URL(name, destination);
    let buffer;
    try { buffer = await readFile(file); } catch {
      const result = await fetch(url);
      if (!result.ok) throw new Error(`${name}: ${result.status}`);
      buffer = Buffer.from(await result.arrayBuffer());
      if (buffer.toString('ascii',0,4) !== 'wOF2') throw new Error(`Invalid WOFF2: ${name}`);
      await writeFile(file, buffer);
    }
    manifest.push({ name, source: url, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
    css = css.replaceAll(url, `/fonts/noto-sc/${name}`);
  }
}));
for (const family of ['notosanssc','notoserifsc']) {
  const result = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${family}/OFL.txt`);
  if (!result.ok) throw new Error(`License ${family}: ${result.status}`);
  const license = await result.text();
  if (!license.includes('SIL OPEN FONT LICENSE')) throw new Error(`Unexpected font license: ${family}`);
  await writeFile(new URL(`${family}-OFL.txt`, destination), license);
}
await writeFile(new URL('../src/club-fonts.css', import.meta.url), `/* Noto Sans SC 400–600 and Noto Serif SC 500–600, self-hosted WOFF2.\n   Source: Google Fonts. SIL OFL 1.1 included in public/fonts/noto-sc/.\n   Original Unicode ranges retained: browsers load only necessary subsets. */\n${css}`);
await writeFile(new URL('manifest.json', destination), JSON.stringify({ source: cssUrl, downloadedAt: new Date().toISOString(), files: manifest.sort((a,b) => a.name.localeCompare(b.name)) },null,2));
console.log(JSON.stringify({files:manifest.length,bytes:manifest.reduce((sum,item)=>sum+item.bytes,0),cssBytes:css.length}));
