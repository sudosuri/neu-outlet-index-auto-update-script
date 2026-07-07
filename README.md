# Neu Outlet — filter index auto-update

Keeps the storefront collection filters in sync with Shopify product tags. When merchandisers change
tags in Shopify, the front-end filters/counts update automatically within ~15 minutes instead of
needing a manual rebuild.

## How it works

- **`build-index.mjs`** — queries the Shopify Admin API for all live, in-stock, published products,
  computes each product's facets (condition, category, brand, width, capacity, `liq`/warranty flag,
  "recently added" date, etc.) and writes `filter-index.json`. This is the server-side filter: the
  index can only contain in-stock, published, sitemap-visible products.
- **`deploy-index.mjs`** — uploads the fresh `filter-index.json` to the live Shopify theme via one
  Admin API asset call (no theme checkout needed).
- **`.github/workflows/rebuild-index.yml`** — runs both, every 15 minutes (and on demand).

The theme's collection/search pages read `filter-index.json` client-side, so a fresh index = fresh
front-end filters.

## One-time setup

1. **Create a Shopify Admin API token** with scopes **`read_products` AND `write_themes`**
   (Shopify Admin → Settings → Apps and sales channels → Develop apps → create app → configure Admin
   API scopes → install → reveal the Admin API access token).
2. **Add these repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   | Secret | Value |
   | --- | --- |
   | `NEU_SHOPIFY_STORE` | `neu-appliances-2021.myshopify.com` |
   | `NEU_SHOPIFY_ACCESS_TOKEN` | the token from step 1 |
   | `NEU_THEME_ID` | the **live** theme id (e.g. `156181364909`) |
3. **Enable Actions** on the repo (Actions tab).
4. **Run it once manually**: Actions → "Rebuild filter index" → Run workflow. Confirm it builds + deploys.

After that it runs automatically every 15 minutes. To verify: change a product tag in Shopify, wait
≤15 min, refresh a collection page — the filter/count reflects the change.

## Local run (optional)

```
cp .env.example .env      # then paste your real token + theme id into .env
node build-index.mjs      # writes filter-index.json
node deploy-index.mjs     # uploads it to NEU_THEME_ID
```

## Adjusting the schedule

Edit the `cron` in `.github/workflows/rebuild-index.yml` (default `*/15 * * * *`). For near-instant
updates, add a Shopify `products/update` webhook that triggers the workflow via `repository_dispatch`.
