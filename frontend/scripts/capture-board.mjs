#!/usr/bin/env node
/**
 * Capture the board for the README and for the Capitol gallery card.
 *
 * The two images are different shapes on purpose. The README shows the whole
 * 1600x1000 board. Every Capitol gallery card is 16:9 and crops its image with
 * object-fit: cover, so the card copy is cropped from the top: that keeps the
 * topbar whole instead of slicing it through the middle, and drops the bottom
 * strip the card can afford to lose.
 *
 *   npm run capture:shot
 *   npm run capture:shot -- --url https://grid-evac-ai.vercel.app
 *
 * Without --url the script builds nothing itself; `capture:shot` runs the
 * production build first, then this starts `next start` on port 3210, captures
 * and stops it. The build inlines NEXT_PUBLIC_API_URL, so the routing API has
 * to be reachable for the shot to say "Routing API"; otherwise the board says
 * "Local solver" and this warns.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const repo = resolve(frontend, '..');

const options = new Map();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index];
  if (!key.startsWith('--')) continue;
  const value = argv[index + 1];
  if (value && !value.startsWith('--')) {
    options.set(key, value);
    index += 1;
  } else {
    options.set(key, true);
  }
}

const port = Number(options.get('--port') ?? 3210);
const baseUrl = options.get('--url') ?? `http://127.0.0.1:${port}`;
const outPath = resolve(repo, String(options.get('--out') ?? 'docs/screenshot.png'));
const galleryPath = resolve(
  repo,
  String(options.get('--gallery') ?? '.capitol-pr/public/gallery/screenshots/wub796-gridevac-ai.webp'),
);
const settleMs = Number(options.get('--settle') ?? 12_000);

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`);
}

let server = null;
try {
  if (!options.has('--url')) {
    const nextBin = resolve(frontend, 'node_modules/.bin/next');
    server = spawn(nextBin, ['start', '-p', String(port)], { cwd: frontend, stdio: 'inherit' });
    await waitForServer(baseUrl);
  }

  const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('gridevac-guide-seen', '1');
        localStorage.setItem('gridevac-location-prompt', 'dismissed');
        localStorage.removeItem('gridevac-board-audit');
        localStorage.removeItem('gridevac-board-briefing');
      } catch {
        /* private mode */
      }
    });

    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('.rail-gauge-value', { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Let the route solve and the Cesium tiles paint before the shutter.
    await page.waitForTimeout(settleMs);

    const status = await page.evaluate(() => document.querySelector('.topbar-status')?.textContent?.trim() ?? '');
    if (!status.includes('Routing API')) {
      console.warn(`warn: board says "${status || 'unknown'}", not "Routing API"; check the API before publishing this shot`);
    }

    mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
    console.log(`wrote ${outPath} (${statSync(outPath).size} bytes)`);
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill('SIGTERM');
}

if (existsSync(dirname(galleryPath))) {
  const { width = 1600, height = 1000 } = await sharp(outPath).metadata();
  const info = await sharp(outPath)
    .extract({ left: 0, top: 0, width, height: Math.min(height, Math.round((width * 9) / 16)) })
    .webp({ quality: 80, effort: 6 })
    .toFile(galleryPath);
  console.log(`wrote ${galleryPath} (${info.width}x${info.height}, ${info.size} bytes)`);
} else {
  console.log(`skipped the gallery WebP: ${dirname(galleryPath)} does not exist`);
}
