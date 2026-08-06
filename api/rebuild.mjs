// Vercel Serverless Function — rebuilds the storefront filter index and deploys it to the live theme.
// Runs the SAME build + deploy logic as the GitHub Action, but on Vercel's own compute, so there's no
// hosted-runner queue lag. Triggered by Vercel Cron (see ../vercel.json) and/or Shopify Flow -> HTTP.
import { buildIndex } from '../build-index.mjs';
import { deployIndex } from '../deploy-index.mjs';

export const maxDuration = 300; // Vercel Pro: allow up to 5 min (build + deploy is ~1-2 min).

// Never deploy an implausibly small index — guards a partial / timed-out build from overwriting a good one.
const FLOOR = 400;
// Freshness canary. Neu creates products daily, so the newest createdAt in a FRESHLY BUILT index should
// never be old. If it is, something upstream is wrong (query filter, token scope, catalog stall) even
// though the run "succeeded" — surface it instead of letting it go unnoticed for days, which is exactly
// how the Aug 2026 frozen-index outage stayed invisible.
const MAX_AGE_HOURS = 36;

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when a CRON_SECRET env var is set.
  // If it's set, require it — keeps the public endpoint from being triggered by anyone.
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const t0 = Date.now();
  try {
    const { items, stats } = await buildIndex();
    if (items.length < FLOOR) {
      return res.status(500).json({ ok: false, error: `index too small (${items.length} < ${FLOOR}); not deploying`, stats });
    }

    const newest = items.reduce((m, it) => (it.added > m ? it.added : m), 0);
    const ageHours = newest ? Math.round((Date.now() - newest) / 3600000) : null;
    const stale = ageHours == null || ageHours > MAX_AGE_HOURS;
    if (stale) {
      console.warn(`WARNING: newest product in the freshly built index is ${ageHours}h old (> ${MAX_AGE_HOURS}h) — check the build query / token scopes.`);
    }

    const deployed = await deployIndex(JSON.stringify(items));
    console.log(`indexed ${items.length} products | newest ${ageHours}h old | theme ${deployed.themeId}${deployed.isLive ? ' (LIVE)' : ' (NOT LIVE)'}`);
    return res.status(200).json({ ok: true, ms: Date.now() - t0, ...stats, newestAgeHours: ageHours, stale, deployed });
  } catch (e) {
    console.error('rebuild FAILED:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
