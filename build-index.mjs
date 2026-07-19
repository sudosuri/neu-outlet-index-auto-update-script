// Builds filter-index.json — a compact facet+card index for the storefront filter.
//   node build-index.mjs                   -> facets computed from tags (pre-migration)
//   node build-index.mjs --from-metafields -> facets READ from the persisted filter.* metafields (canonical)
//
// SCOPE (client model, Jul 2026): Neu makes a new product per physical unit; sold units stay as
// active-but-0-stock products forever. Only IN-STOCK or inventory-NOT-TRACKED products should be
// browsable — so the index includes only variants with availableForSale === true (this also drops
// every 0-stock product). Gift cards, Installation Add-Ons (hookup connectors), and services are
// excluded from the grid. Untagged-but-available products still appear; they just aren't filterable
// until tagged, and counts fill in as tagging progresses.
import { writeFileSync } from 'node:fs';
import { gql, buildMetafields, conditionPriority } from './lib.mjs';

const FROM_MF = process.argv.includes('--from-metafields');

const COND_BADGE = {
  sdmin: { cond: 'scratch', label: 'Scratch & Dent', sev: 'Minor' },
  sdmod: { cond: 'scratch', label: 'Scratch & Dent', sev: 'Moderate' },
  sdmaj: { cond: 'scratch', label: 'Scratch & Dent', sev: 'Major' },
  ob: { cond: 'open', label: 'Open Box' },
  cr: { cond: 'refurb', label: 'Certified Refurb' },
  new: { cond: 'new', label: 'New in Box' },
};
const PRIO_ORDER = ['sdmin', 'sdmod', 'sdmaj', 'ob', 'cr', 'new'];
const PRIO_BY_COND = { scratch: 1, open: 2, refurb: 3, new: 4 };
const EXCLUDE_TYPE = /install|gift|service|warranty|add-?on|part\b|accessor/i;
// Non-appliance items that shouldn't be browsable: Neu Shield warranties (= "Appliance Services"),
// kits/parts, surge protector, decor panel, propane conversion, haul-away, freight, special/custom orders.
const EXCLUDE_TITLE = /neu shield|\bwarranty\b|stacking kit|fill hose|supply hose|surge protector|decor panel|propane conversion|haul[\s-]?away|\bfreight\b|special order|custom order/i;

// Condition lives mostly in LEGACY NUMERIC tags, not the new alpha codes — so the condition facet
// bridges both (same scheme neu-product-card / neu-tagmap use). This makes condition filtering + sort
// work across the whole in-stock catalog now, instead of only the ~10 alpha-tagged New products.
const NUM_COND = { '16': 'CR', '21': 'CR', '26': 'CR', '17': 'OB', '22': 'OB', '27': 'OB', '18': 'SDMIN', '23': 'SDMIN', '28': 'SDMIN', '19': 'SDMOD', '24': 'SDMOD', '29': 'SDMOD', '20': 'SDMAJ', '25': 'SDMAJ', '30': 'SDMAJ', '222': 'NEW', '333': 'NEW', '344': 'NEW' };
const ALPHA_C = { new: 'NEW', cr: 'CR', ob: 'OB', sdmin: 'SDMIN', sdmod: 'SDMOD', sdmaj: 'SDMAJ' };
const COND_PRIO = { SDMIN: 1, SDMOD: 1, SDMAJ: 1, OB: 2, CR: 3, NEW: 4 };
function condPrio(codes) { let best = null; for (const c of codes) { const p = COND_PRIO[String(c).toUpperCase()]; if (p != null && (best == null || p < best)) best = p; } return best; }
function pickOne(codes) { let best = null, bp = 999; for (const c of codes) { let p = COND_PRIO[String(c).toUpperCase()]; if (p == null) p = 500; if (p < bp) { bp = p; best = c; } } return best ? String(best).toUpperCase() : null; }

// New live tag format is self-describing: <Dimension>_<Value> for globals (Category_REF, Location_Burnet)
// and <Dimension>_<Category>_<Value> for category-scoped dims (Condition_REF_SDMOD, Style_REF_3DR,
// Width_MCR_30in). We parse those AND still read the old bare codes (both coexist during transition),
// normalizing values to our taxonomy (30in -> 30", 7.4 -> 7.4+). Condition also bridges legacy numeric.
// Prefix -> facet dim. The 7.3 sheet RENAMED several prefixes (CleaningType/ClearIce/IceType/
// TopLoadStyle/TubMaterial) and added Venting — keep the old short keys for transition back-compat
// AND map the new ones, else those tags are silently dropped and their filters render empty (task 86e2a5jt5).
const DIM_PREFIX = { category: 'category', condition: 'condition', color: 'color', location: 'location', capacity: 'capacity', style: 'style', fuel: 'fuel_type', width: 'width', feature: 'features', features: 'features', type: 'type', cleaning: 'cleaning_type', cleaningtype: 'cleaning_type', tub: 'tub_material', tubmaterial: 'tub_material', ice: 'ice_type', icetype: 'ice_type', clear: 'clear_ice', clearice: 'clear_ice', drain: 'drain', pump: 'pump', topload: 'top_load_type', toploadstyle: 'top_load_type', venting: 'venting' };
const CATSET = new Set(['wdset', 'wash', 'dry', '2in1', 'lc', 'rng', 'dw', 'frz', 'mcr', 'vent', 'wal', 'ckt', 'ice', 'whtr', 'grill', 'ref', 'ac', 'misc']);
function normVal(dim, v) {
  v = String(v).trim();
  if (dim === 'width') { const m = v.match(/[\d.]+/); return m ? m[0] + '"' : v; }
  if (dim === 'capacity') { const m = v.match(/[\d.]+/); return m ? m[0] + '+' : v; }
  return v;
}
function facetsFromTags(tags) {
  const f = buildMetafields(tags); // old bare codes (category / color / attrs / alpha condition)
  const add = (k, v) => { if (v == null || v === '') return; const s = new Set(f[k] || []); s.add(v); f[k] = [...s]; };
  for (const raw of tags || []) {
    const t = String(raw); const us = t.indexOf('_'); if (us < 0) continue;
    const dim = DIM_PREFIX[t.slice(0, us).toLowerCase()]; if (!dim) continue;
    let rest = t.slice(us + 1);
    if (dim !== 'category' && dim !== 'location') { const n = rest.indexOf('_'); if (n >= 0 && CATSET.has(rest.slice(0, n).toLowerCase())) rest = rest.slice(n + 1); }
    add(dim, normVal(dim, rest));
  }
  // Condition: exactly ONE per product so the filter counts reconcile with the product total.
  // Prefer the authoritative new-system condition (prefixed/alpha, already in f.condition); fall back
  // to the legacy numeric tag ONLY when there's no new-system condition.
  let pool = (f.condition && f.condition.length) ? f.condition.slice() : [];
  if (!pool.length) { for (const t of (tags || []).map((x) => String(x).toLowerCase())) if (NUM_COND[t]) pool.push(NUM_COND[t]); }
  const one = pickOne(pool);
  if (one) f.condition = [one]; else delete f.condition;
  return f;
}

function alphaBadge(condCodes) {
  if (!condCodes || !condCodes.length) return null;
  const lc = condCodes.map((c) => String(c).toLowerCase());
  for (const k of PRIO_ORDER) {
    if (lc.includes(k)) { const b = COND_BADGE[k]; return { cond: b.cond, badge: b.sev ? `${b.label} · ${b.sev}` : b.label }; }
  }
  return null;
}

// Fallback badge from legacy numeric tags / title. Returns null when there is NO real condition
// signal — so accessories/untagged products get NO badge (fixes the wrong default "Scratch & Dent").
function legacyCond(tags, title) {
  const t = (tags || []).map((x) => String(x));
  const has = (s) => t.indexOf(s) > -1;
  const hay = (String(title) + ' ' + t.join(' ')).toLowerCase();
  let cond = '', label = '', sev = '';
  if (has('222') || has('333') || has('344')) { cond = 'new'; label = 'New in Box'; }
  else if (has('17') || has('22') || has('27')) { cond = 'open'; label = 'Open Box'; }
  else if (has('16') || has('21') || has('26')) { cond = 'refurb'; label = 'Certified Refurb'; }
  else if (has('18') || has('23') || has('28')) { cond = 'scratch'; label = 'Scratch & Dent'; sev = 'Minor'; }
  else if (has('19') || has('24') || has('29')) { cond = 'scratch'; label = 'Scratch & Dent'; sev = 'Moderate'; }
  else if (has('20') || has('25') || has('30')) { cond = 'scratch'; label = 'Scratch & Dent'; sev = 'Major'; }
  if (!cond) {
    if (hay.indexOf('new in box') > -1 || hay.indexOf('new-in-box') > -1) { cond = 'new'; label = 'New in Box'; }
    else if (hay.indexOf('open box') > -1 || hay.indexOf('open-box') > -1) { cond = 'open'; label = 'Open Box'; }
    else if (hay.indexOf('refurb') > -1) { cond = 'refurb'; label = 'Certified Refurb'; }
    else if (hay.indexOf('scratch') > -1 || hay.indexOf('dent') > -1) {
      cond = 'scratch'; label = 'Scratch & Dent';
      if (hay.indexOf('major') > -1) sev = 'Major'; else if (hay.indexOf('moderate') > -1) sev = 'Moderate'; else if (hay.indexOf('minor') > -1) sev = 'Minor';
    } else {
      return { cond: '', badge: '', prio: 99 }; // NO condition signal -> no badge
    }
  }
  return { cond, badge: sev ? `${label} · ${sev}` : label, prio: PRIO_BY_COND[cond] || 99 };
}

const Q = `query($c:String){
  products(first:100, after:$c, query:"status:active published_status:published"){
    pageInfo{ hasNextPage endCursor }
    nodes{
      id handle title vendor isGiftCard productType totalInventory tags onlineStoreUrl createdAt
      featuredImage{ url(transform:{maxWidth:600}) }
      variants(first:1){ nodes{ price compareAtPrice availableForSale } }
      metafields(first:40, namespace:"filter"){ nodes{ key value } }
    }
  }
}`;
const numId = (g) => g.split('/').pop();

// Authoritative "truly live on the storefront" set: the product sitemap. It lists every product
// PUBLISHED to the Online Store (including 0-stock ones), but omits products that 404 on the
// storefront even though the Admin API still reports them as published with an onlineStoreUrl
// (a real data inconsistency we hit). Gating on sitemap membership drops those broken 404 cards
// without hiding legit in-stock products that merely aren't in the all-appliances collection.
const STORE_URL = (process.env.STORE_URL || 'https://neuapplianceoutlet.com').replace(/\/$/, '');
async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'user-agent': 'neu-index-builder' } }); if (r.ok) return await r.text(); lastErr = new Error('HTTP ' + r.status); }
    catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  throw lastErr || new Error('fetch failed: ' + url);
}
async function sitemapHandles() {
  const set = new Set();
  try {
    const idx = await fetchText(`${STORE_URL}/sitemap.xml`);
    const files = [...idx.matchAll(/<loc>([^<]*sitemap_products[^<]*)<\/loc>/g)].map((m) => m[1]);
    if (!files.length) throw new Error('no product sitemaps found in sitemap.xml');
    for (const f of files) {
      const xml = await fetchText(f);
      let n = 0;
      for (const m of xml.matchAll(/\/products\/([^<>"?#]+)/g)) { set.add(decodeURIComponent(m[1]).toLowerCase()); n++; }
      // A real product-sitemap page always has handles. Zero = throttled/partial response — bail so we
      // don't proceed with an incomplete "live" set that would gate out most of the catalog.
      if (n === 0) throw new Error('product sitemap returned 0 handles: ' + f);
    }
  } catch (e) {
    // SAFETY: never let an incomplete sitemap decimate the index. Disable the liveness gate for this
    // run instead (falls back to onlineStoreUrl + availableForSale). A few Admin-published-but-404
    // cards beats silently dropping thousands of real products (what produced the 226-product build).
    console.warn('sitemap fetch incomplete — DISABLING liveness gate for this run:', e.message);
    return new Set();
  }
  return set;
}
export async function buildIndex() {
  const LIVE_HANDLES = await sitemapHandles();
  console.error(`sitemap live product handles: ${LIVE_HANDLES.size}${LIVE_HANDLES.size ? '' : ' (gate disabled)'}`);

  let cursor = null, scanned = 0, excluded = 0;
  const items = [];
  do {
  const d = await gql(Q, { c: cursor });
  for (const p of d.products.nodes) {
    scanned++;
    const v = (p.variants.nodes && p.variants.nodes[0]) || {};
    if (!p.onlineStoreUrl) { excluded++; continue; }           // must be live on the Online Store (drops active-but-unpublished 404s)
    if (LIVE_HANDLES.size && !LIVE_HANDLES.has(String(p.handle || '').toLowerCase())) { excluded++; continue; } // must be in the storefront sitemap (drops Admin-published-but-404 products)
    if (!v.availableForSale) continue;                         // in-stock / not-tracked only (drops 0-stock)
    if (p.isGiftCard || EXCLUDE_TYPE.test(p.productType || '') || EXCLUDE_TITLE.test(p.title || '')) { excluded++; continue; } // gift/connections/services/warranties/kits/special orders

    let f, prio;
    if (FROM_MF) { const r = facetsFromMetafields(p.metafields.nodes); f = r.f; prio = r.prio; }
    else {
      f = facetsFromTags(p.tags);                  // old bare + new prefixed tags; condition bridged
      prio = condPrio(f.condition || []);
    }
    // Drop Miscellaneous-only products (special orders / uncategorized) — not browsable appliances.
    if (f.category && f.category.length === 1 && String(f.category[0]).toUpperCase() === 'MISC') { excluded++; continue; }

    let cond, badge;
    const ab = alphaBadge(f.condition);
    if (ab) { cond = ab.cond; badge = ab.badge; }
    else { const lg = legacyCond(p.tags, p.title); cond = lg.cond; badge = lg.badge; if (prio == null) prio = lg.prio; }

    const price = parseFloat(v.price || '0');
    const cap = v.compareAtPrice ? parseFloat(v.compareAtPrice) : 0;
    items.push({
      id: numId(p.id),
      url: `/products/${p.handle}`,
      title: p.title,
      vendor: p.vendor || 'Neu Outlet',
      img: p.featuredImage ? p.featuredImage.url : null,
      price, cap: cap > price ? cap : 0,
      avail: true,
      cond: cond || '',
      badge: badge || '',
      prio: prio == null ? 99 : prio,
      added: p.createdAt ? Date.parse(p.createdAt) : 0,   // for the "Recently Added" sort (task 86e26y4c9)
      liq: (p.tags || []).some(function (t) { return String(t).toLowerCase() === 'discount_liq'; }), // Discount_LIQ = no warranty / 30-day (task 86e26z33m) — cards read this
      rnd: Math.random(),   // stable-per-rebuild shuffle key for the "Outlet Appliances" random top mix (task 86e27z1mb)

      f,
    });
  }
  cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  if (scanned % 1000 < 100) console.error(`...scanned ${scanned}`);
} while (cursor);

function facetsFromMetafields(nodes) {
  const f = {}; let prio = null;
  for (const m of nodes) {
    if (m.key === 'condition_priority') { prio = parseInt(m.value, 10); continue; }
    let val; try { val = JSON.parse(m.value); } catch (e) { val = [m.value]; }
    if (Array.isArray(val) && val.length) f[m.key] = val;
  }
  return { f, prio };
}

  items.sort((a, b) => a.prio - b.prio || a.price - b.price);
  const tagged = items.filter((it) => it.f && it.f.category).length;
  const fc = {};
  for (const it of items) for (const k of Object.keys(it.f)) fc[k] = (fc[k] || 0) + 1;
  return { items, stats: { indexed: items.length, scanned, excluded, tagged, sitemap: LIVE_HANDLES.size, source: FROM_MF ? 'metafields' : 'tags', coverage: fc } };
}

// CLI: `node build-index.mjs` builds + writes filter-index.json (GitHub Action / local runs).
// When imported (e.g. by the Vercel function in api/rebuild.mjs) only buildIndex() is used and this is skipped.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build-index.mjs')) {
  const { items, stats } = await buildIndex();
  writeFileSync(new URL('./filter-index.json', import.meta.url), JSON.stringify(items));
  console.log(`[source: ${stats.source}] indexed ${stats.indexed} browsable products of ${stats.scanned} active scanned (excluded ${stats.excluded} gift/connection/service; 0-stock dropped)`);
  console.log(`  filterable now (have category facet): ${stats.tagged}  |  shown-but-not-yet-filterable: ${stats.indexed - stats.tagged}`);
  console.log('facet coverage:', JSON.stringify(stats.coverage));
}
