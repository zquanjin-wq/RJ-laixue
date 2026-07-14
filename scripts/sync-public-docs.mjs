#!/usr/bin/env node
/**
 * Sync public-facing HTML from docs/ to public/docs/ so Vercel
 * serves them at /docs/* as static assets.
 *
 * Run before commit:
 *   node scripts/sync-public-docs.mjs
 *
 * Or wire into package.json scripts:
 *   "prebuild": "node scripts/sync-public-docs.mjs"
 */

import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SRC = join(process.cwd(), 'docs');
const DST = join(process.cwd(), 'public', 'docs');

// Files in docs/ that should be exposed publicly. Add more here
// as new public docs are created.
const PUBLIC_HTML_FILES = [
  'product-intro.html',
  'user-manual.html',
];

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function main() {
  ensureDir(SRC);
  ensureDir(DST);

  let copied = 0;
  for (const name of PUBLIC_HTML_FILES) {
    const src = join(SRC, name);
    if (!existsSync(src)) {
      console.warn(`[sync-docs] skip (not found): ${src}`);
      continue;
    }
    const dst = join(DST, name);
    copyFileSync(src, dst);
    const { size } = statSync(dst);
    console.log(`[sync-docs] ${name} (${size} bytes)`);
    copied++;
  }

  console.log(`[sync-docs] copied ${copied} file(s) from docs/ to public/docs/`);
}

main();