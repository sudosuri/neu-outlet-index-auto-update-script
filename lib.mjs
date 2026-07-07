// Shared helpers for the Neu metafield migration.
// Reads credentials from .env / .env.example by VARIABLE NAME only — never logs the token.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadEnv() {
  const env = {};
  // CI / shell environment variables (e.g. GitHub Actions secrets) take precedence over local files.
  for (const k of ['NEU_SHOPIFY_STORE', 'NEU_SHOPIFY_ACCESS_TOKEN', 'NEU_SHOPIFY_API_VERSION']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  for (const f of ['.env', '.env.example']) {        // .env wins; .env.example is fallback
    const p = join(DIR, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] && !(m[1] in env)) env[m[1]] = m[2];
    }
  }
  const store = env.NEU_SHOPIFY_STORE;
  const token = env.NEU_SHOPIFY_ACCESS_TOKEN;
  const version = env.NEU_SHOPIFY_API_VERSION || '2025-01';
  if (!store || !token) throw new Error('Missing NEU_SHOPIFY_STORE or NEU_SHOPIFY_ACCESS_TOKEN in .env');
  return { store, token, version };
}

let _cfg;
export async function gql(query, variables = {}) {
  if (!_cfg) _cfg = loadEnv();
  const url = `https://${_cfg.store}/admin/api/${_cfg.version}/graphql.json`;
  for (let attempt = 0; attempt < 6; attempt++) {
    let json;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': _cfg.token },
        body: JSON.stringify({ query, variables }),
      });
      json = await res.json();
    } catch (e) {
      if (attempt < 5) { await sleep(1500 * (attempt + 1)); continue; }
      throw e;
    }
    if (json.errors) {
      const throttled = JSON.stringify(json.errors).includes('THROTTLED');
      if (throttled && attempt < 5) { await sleep(2500 * (attempt + 1)); continue; }
      throw new Error('GraphQL errors: ' + JSON.stringify(json.errors));
    }
    return json.data;
  }
}

export const MAP = JSON.parse(readFileSync(join(DIR, 'filter-map.json'), 'utf8'));
export const ADMIN_BASE = 'https://admin.shopify.com/store/neu-appliances-2021/products/';

// ---- tag -> metafields (category-aware, case-insensitive) ----
const lc = (s) => String(s).trim().toLowerCase();
const G = MAP.globals;
const CATS = MAP.categories;
// Only the explicit text location tags from the sheet (Whs = Online Only, Burnet = In-Store).
// Bare numeric tags like "1"/"2" are NOT trusted as location — they collide with thousands of
// unrelated legacy numeric tags and produced false "Burnet"/"Whs" hits. Revisit if the client
// confirms a numeric->location encoding.
const LOCATION_ALIAS = { whs: 'Whs', burnet: 'Burnet' };

// canonical metafield key order + display names (the 17 definitions)
export const KEYS = [
  ['category', 'Category'], ['condition', 'Condition'], ['color', 'Color'], ['location', 'Location'],
  ['capacity', 'Capacity'], ['style', 'Style'], ['top_load_type', 'Top Load Type'], ['fuel_type', 'Fuel Type'],
  ['width', 'Width'], ['cleaning_type', 'Cleaning Type'], ['type', 'Type'], ['tub_material', 'Tub Material'],
  ['ice_type', 'Ice Type'], ['clear_ice', 'Clear Ice'], ['drain', 'Drain'], ['pump', 'Pump'], ['features', 'Features'],
];

// ---- numeric sort signal: condition priority (lower = shown first) ----
// S&D (any) = 1, Open Box = 2, Certified Refurbished = 3, New in Box = 4.
// No recognised condition tag => null (field not written; sorts last in the grid).
export const SORT_DEF = ['condition_priority', 'Condition Priority'];
const CONDITION_PRIORITY = { sdmin: 1, sdmod: 1, sdmaj: 1, ob: 2, cr: 3, new: 4 };

export function conditionPriority(tags) {
  let best = null;
  for (const t of (tags || []).map(lc)) {
    if (Object.prototype.hasOwnProperty.call(CONDITION_PRIORITY, t)) {
      const p = CONDITION_PRIORITY[t];
      if (best === null || p < best) best = p; // best (lowest) condition wins
    }
  }
  return best; // null when no recognised condition tag
}

export function buildMetafields(tags) {
  const tl = (tags || []).map(lc);
  const has = (code) => tl.includes(lc(code));
  const out = {};
  const add = (k, v) => { (out[k] = out[k] || new Set()).add(v); };

  const cats = [];
  for (const [code] of G.category) if (has(code)) { add('category', code); cats.push(code); }
  for (const [code] of G.condition) if (has(code)) add('condition', code);
  for (const [code] of G.color) if (has(code)) add('color', code);
  for (const t of tl) if (LOCATION_ALIAS[t]) add('location', LOCATION_ALIAS[t]);

  for (const cat of cats) {
    const groups = CATS[cat];
    if (!groups) continue;
    for (const [key, opts] of Object.entries(groups)) {
      for (const [code] of opts) if (has(code)) add(key, code);
    }
  }
  const result = {};
  for (const [k, set] of Object.entries(out)) result[k] = [...set];
  return result;
}
