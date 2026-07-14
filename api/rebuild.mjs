// Vercel Serverless Function — rebuilds the storefront filter index and deploys it to the live theme.
// Runs the SAME build + deploy logic as the GitHub Action, but on Vercel's own compute, so there's no
// hosted-runner queue lag. Triggered by Vercel Cron (see ../vercel.json) and/or Shopify Flow -> HTTP.
import { buildIndex } from '../build-index.mjs';
import { deployIndex } from '../deploy-index.mjs';

export const maxDuration = 300; // Vercel Pro: allow up to 5 min (build + deploy is ~1-2 min).

// Never deploy an implausibly small index — guards a partial / timed-out build from overwriting a good one.
const FLOOR = 400;

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
    const deployed = await deployIndex(JSON.stringify(items));
    return res.status(200).json({ ok: true, ms: Date.now() - t0, ...stats, deployed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
