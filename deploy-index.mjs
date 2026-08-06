// Uploads the freshly built facet index to the PUBLISHED (live) theme via the Admin API (single asset PUT).
// Importable as deployIndex(jsonString); or run as a CLI (`node deploy-index.mjs`) which reads the
// on-disk filter-index.json that build-index.mjs wrote and deploys it.
//
//   NEU_SHOPIFY_STORE / NEU_SHOPIFY_ACCESS_TOKEN (read_products + read_themes + write_themes)
//   NEU_THEME_ID_OVERRIDE — deliberate one-off escape hatch ONLY (e.g. seeding a dev theme). Leave it
//                  UNSET in production; the index then always lands on whatever theme is PUBLISHED.
//
// ⚠️ FROZEN-INDEX OUTAGE #2 (2026-08-06) — why the guards below exist. A stale `NEU_THEME_ID` that had
// been deleted from Vercel's Project Settings was still BAKED INTO the running deployment (Vercel
// snapshots env vars at build time — deleting a var does nothing until you redeploy). It pinned every
// run to the RETIRED theme 156583362733 while 157111025837 was live, so for ~5 days the cron reported
// HTTP 200 with zero warnings while the storefront served a frozen index and ~68 newly-posted products
// stayed invisible. Nothing failed; the wrong target was simply never checked or printed. Hence:
//   1. ALWAYS resolve the live theme and REFUSE to write anywhere else (unless NEU_THEME_ID_OVERRIDE).
//   2. NO silent fallback theme id — if the live theme can't be resolved, THROW. A failed run is loud
//      and self-correcting; a successful write to a dead theme is invisible.
//   3. Always LOG the target, and read the asset back to prove the write landed.
import { readFileSync } from 'node:fs';
import { loadEnv } from './lib.mjs';

// Resolve the currently PUBLISHED (role=main) theme id from the Admin API. A hardcoded/env theme id is
// fragile: every theme republish mints a NEW id, and a stale value silently deploys the fresh index to
// an old/unpublished theme while the live storefront serves a FROZEN index.
export async function resolveLiveThemeId({ store, token, version }) {
  const url = `https://${store}/admin/api/${version}/themes.json?fields=id,role,name`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!res.ok) throw new Error(`themes.json failed: HTTP ${res.status}`);
  const { themes = [] } = await res.json();
  const main = themes.find((t) => t.role === 'main');
  if (!main) throw new Error(`No published (role=main) theme found among ${themes.length} themes returned.`);
  return String(main.id);
}

// Read back ONE asset's metadata (key/size/updated_at) from a theme. Uses the asset LIST endpoint, which
// omits every asset's `value` — a cheap proof that the write actually landed on the theme we targeted,
// without pulling the ~1 MB index body back down.
export async function assetMeta({ store, token, version }, themeId, key) {
  const url = `https://${store}/admin/api/${version}/themes/${themeId}/assets.json?fields=key,size,updated_at`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!res.ok) throw new Error(`assets.json list failed: HTTP ${res.status}`);
  const { assets = [] } = await res.json();
  return assets.find((a) => a.key === key) || null;
}

// PUT a single theme asset. `jsonString` is the raw filter-index.json contents.
// Target: explicit `themeId` arg / NEU_THEME_ID_OVERRIDE (deliberate override) — otherwise the LIVE
// role=main theme, and a mismatched legacy NEU_THEME_ID is treated as an ERROR rather than obeyed.
export async function deployIndex(jsonString, { themeId, key = 'assets/filter-index.json', verify = true } = {}) {
  const cfg = loadEnv();
  const { store, token, version } = cfg;

  const live = await resolveLiveThemeId(cfg); // throws on failure — deliberately no fallback id
  const override = themeId || process.env.NEU_THEME_ID_OVERRIDE;

  // Legacy NEU_THEME_ID is NO LONGER an override. It is honoured only when it already agrees with the
  // live theme, so a forgotten value (or one baked into an old deployment) can never silently redirect
  // the index to a retired theme again — it fails the run instead.
  const legacy = process.env.NEU_THEME_ID;
  if (!override && legacy && String(legacy) !== live) {
    throw new Error(
      `NEU_THEME_ID=${legacy} does not match the live (role=main) theme ${live}. Refusing to deploy to a ` +
      `theme that isn't published. Unset NEU_THEME_ID and REDEPLOY (on Vercel, deleting an env var only ` +
      `takes effect on the next deployment), or set NEU_THEME_ID_OVERRIDE if this is intentional.`
    );
  }

  const targetId = String(override || live);
  if (targetId !== live) {
    console.warn(`WARNING: deploying to ${targetId} via an explicit override — the LIVE theme is ${live}. The storefront will NOT see this index.`);
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
  const out = {
    key,
    themeId: targetId,
    liveThemeId: live,
    isLive: targetId === live,
    bytes: jsonString.length,
    updated_at: j.asset && j.asset.updated_at,
  };

  // Prove it landed: re-read the asset from the theme we just wrote to.
  if (verify) {
    const meta = await assetMeta(cfg, targetId, key);
    if (!meta) throw new Error(`Post-deploy check FAILED: ${key} not found on theme ${targetId} after a 200 PUT.`);
    out.verified = { size: meta.size, updated_at: meta.updated_at };
  }

  // Printed on every run so the deploy target is visible at a glance in the logs — the missing signal
  // that let the Aug 2026 outage hide for 5 days.
  console.log(`deployed ${key} -> theme ${targetId}${out.isLive ? ' (LIVE)' : ' (OVERRIDE — NOT live)'} | ${jsonString.length} bytes`);
  return out;
}

// CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('deploy-index.mjs')) {
  const value = readFileSync(new URL('./filter-index.json', import.meta.url), 'utf8');
  const r = await deployIndex(value);
  console.log(`updated_at ${r.updated_at}${r.verified ? ` | verified ${r.verified.size} bytes on theme` : ''}`);
}
