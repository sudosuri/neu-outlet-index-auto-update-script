// Uploads the freshly built facet index + taxonomy to the LIVE theme via the Admin API.
// Run after build-index.mjs. No Shopify CLI / theme checkout needed — a single asset PUT per file.
//
//   NEU_SHOPIFY_STORE=neu-appliances-2021.myshopify.com   (from .env)
//   NEU_SHOPIFY_ACCESS_TOKEN=...   (Admin API token — needs read_products for the build AND write_themes for this)
//   NEU_THEME_ID=156181364909      (the LIVE theme id; set per environment / secret)
//
// Usage: node deploy-index.mjs
import { readFileSync } from 'node:fs';
import { loadEnv } from './lib.mjs';

const { store, token, version } = loadEnv();
const themeId = process.env.NEU_THEME_ID;
if (!themeId) throw new Error('Missing NEU_THEME_ID (the live theme id to deploy to).');

// Only the index goes stale (inventory changes). The taxonomy (labels/cascade) is static —
// deploy it manually when labels change, not on every scheduled run.
const FILES = ['filter-index.json'];

for (const f of FILES) {
  const value = readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const url = `https://${store}/admin/api/${version}/themes/${themeId}/assets.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ asset: { key: `assets/${f}`, value } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deploy of ${f} failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  console.log(`deployed assets/${f} -> theme ${themeId} (updated_at ${j.asset && j.asset.updated_at})`);
}
