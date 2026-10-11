import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const entries = await readdir('dist/assets');
async function brandFiles(directory = 'dist/brand', prefix = './brand/') {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(entry => entry.isDirectory()
    ? brandFiles(`${directory}/${entry.name}`, `${prefix}${entry.name}/`)
    : `${prefix}${entry.name}`));
  return paths.flat();
}
const files = ['./', './index.html', './icon.svg', './manifest.webmanifest', ...entries.map(name => `./assets/${name}`), ...await brandFiles()];
const version = createHash('sha256');
for (const file of files.filter(file => file !== './').sort()) {
  version.update(file).update(await readFile(`dist/${file.slice(2)}`));
}
const hash = version.digest('hex').slice(0, 12);
await writeFile('dist/sw.js', `const CACHE='budget-${hash}'; const FILES=${JSON.stringify(files)};
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('budget-')||k.startsWith('reserva-'))&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).catch(err=>{if(e.request.mode==='navigate')return caches.match('./index.html');throw err;})));});
`);
