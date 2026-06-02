// scripts/copy-cesium-assets.js
// Copies Cesium's pre-built static assets (workers, textures, widgets CSS)
// into /public/cesium so the browser can load them at runtime.
// Runs automatically via `postinstall` after `npm install`.

const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'node_modules', 'cesium', 'Build', 'Cesium');
const DEST = path.join(__dirname, '..', 'public', 'cesium');

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dest, item);
    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.warn('[GridEvac] Cesium Build not found at:', SRC);
  console.warn('           Run `npm install` first.');
  process.exit(0);
}

console.log('[GridEvac] Copying Cesium assets → public/cesium …');
copyDir(SRC, DEST);
console.log('[GridEvac] Done. public/cesium ready.');
