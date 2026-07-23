// Uploads the freshly built facet index to the LIVE theme via the Admin API (single asset PUT).
// Importable as deployIndex(jsonString); or run as a CLI (`node deploy-index.mjs`) which reads the
// on-disk filter-index.json that build-index.mjs wrote and deploys it.
//
//   NEU_SHOPIFY_STORE / NEU_SHOPIFY_ACCESS_TOKEN (read_products + read_themes + write_themes)
//   NEU_THEME_ID — OPTIONAL override only. Leave UNSET in production so the index always deploys to
//                  whatever theme is currently PUBLISHED (role=main), resolved live below (task 86e2d8qwh).
import { readFileSync } from 'node:fs';
import { loadEnv } from './lib.mjs';

// Emergency fallback ONLY (used if the Admin themes API can't be reached AND no override env is set).
// The normal path resolves the published theme live, so this rarely matters — but deploying to the
// last-known-good theme beats not deploying at all. Keep roughly current on a theme swap.
export const LIVE_THEME_ID = '156583362733';

// Resolve the currently PUBLISHED (role=main) theme id from the Admin API. A hardcoded/env theme id is
// fragile: every theme republish mints a NEW id, and a stale value silently deploys the fresh index to
// an old/unpublished theme while the live storefront serves a FROZEN index (the Jul 2026 outage).
export async function resolveLiveThemeId({ store, token, version }) {
  const url = `https://${store}/admin/api/${version}/themes.json?fields=id,role,name`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!res.ok) throw new Error(`themes.json failed: HTTP ${res.status}`);
  const { themes = [] } = await res.json();
  const main = themes.find((t) => t.role === 'main');
  if (!main) throw new Error('No published (role=main) theme found on the store.');
  return String(main.id);
}

// PUT a single theme asset. `jsonString` is the raw filter-index.json contents.
// themeId precedence: explicit arg > NEU_THEME_ID_OVERRIDE / NEU_THEME_ID (one-off) > live role=main.
export async function deployIndex(jsonString, { themeId, key = 'assets/filter-index.json' } = {}) {
  const cfg = loadEnv();
  const { store, token, version } = cfg;
  let targetId = themeId || process.env.NEU_THEME_ID_OVERRIDE || process.env.NEU_THEME_ID;
  if (!targetId) {
    try { targetId = await resolveLiveThemeId(cfg); }
    catch (e) { console.warn('resolveLiveThemeId failed; falling back to committed LIVE_THEME_ID:', e.message); targetId = LIVE_THEME_ID; }
  }
  const url = `https://${store}/admin/api/${version}/themes/${targetId}/assets.json`;
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
  return { key, themeId: targetId, updated_at: j.asset && j.asset.updated_at };
}

// CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy-index.mjs')) {
  const value = readFileSync(new URL('./filter-index.json', import.meta.url), 'utf8');
  const r = await deployIndex(value);
  console.log(`deployed ${r.key} -> theme ${r.themeId} (updated_at ${r.updated_at})`);
}
