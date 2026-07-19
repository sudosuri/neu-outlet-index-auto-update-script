// Uploads the freshly built facet index to the LIVE theme via the Admin API (single asset PUT).
// Importable as deployIndex(jsonString); or run as a CLI (`node deploy-index.mjs`) which reads the
// on-disk filter-index.json that build-index.mjs wrote and deploys it.
//
//   NEU_SHOPIFY_STORE / NEU_SHOPIFY_ACCESS_TOKEN (read_products + write_themes) / NEU_THEME_ID
import { readFileSync } from 'node:fs';
import { loadEnv } from './lib.mjs';

// The LIVE theme the index deploys to. Committed here on purpose (NOT read from NEU_THEME_ID) so a
// stale dashboard/CI env var can never silently keep deploying to an old theme — both the Vercel cron
// and the GitHub Action import this. When the live theme changes, update THIS value (or set an explicit
// NEU_THEME_ID_OVERRIDE env var for a one-off). Went live 2026-07-17 (was 156331507885). — task: theme swap
export const LIVE_THEME_ID = '156583362733';

// PUT a single theme asset. `jsonString` is the raw filter-index.json contents.
export async function deployIndex(jsonString, { themeId = process.env.NEU_THEME_ID_OVERRIDE || LIVE_THEME_ID, key = 'assets/filter-index.json' } = {}) {
  const { store, token, version } = loadEnv();
  if (!themeId) throw new Error('Missing NEU_THEME_ID (the live theme id to deploy to).');
  const url = `https://${store}/admin/api/${version}/themes/${themeId}/assets.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ asset: { key, value: jsonString } }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deploy of ${key} failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  return { key, themeId, updated_at: j.asset && j.asset.updated_at };
}

// CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy-index.mjs')) {
  const value = readFileSync(new URL('./filter-index.json', import.meta.url), 'utf8');
  const r = await deployIndex(value);
  console.log(`deployed ${r.key} -> theme ${r.themeId} (updated_at ${r.updated_at})`);
}
