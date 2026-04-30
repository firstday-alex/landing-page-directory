# Landing Page Directory

A directory of First Day's published Shopify landing pages, joined with GA4 performance metrics, for the media buying team.

Store: `first-day-inc.myshopify.com`
GA4 property: `506029217` (BigQuery export in `data-stack-478719`)

## What it shows

| Column | Source |
| --- | --- |
| Title | Shopify page |
| URL | Storefront URL (`{STOREFRONT_BASE_URL}/pages/{handle}`) |
| Tags | Shopify metafield `custom.tags` (or page handle tokens — see `refresh.py`) |
| Last Updated | Shopify `updated_at` |
| Sessions | GA4 (BigQuery export) |
| CVR | purchases / sessions |
| Bounce Rate | 1 − engaged sessions / sessions |
| Rev / Session | purchase revenue / sessions |
| AOV | purchase revenue / purchases |

Date window is configurable (default: last 30 days).

## Local setup (one time)

```bash
cd "/Users/owner/Desktop/Landing Page Directory"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json config.json
cp .env.example .env
```

Fill in `.env`:

- `SHOPIFY_ADMIN_TOKEN` — Shopify Admin API access token with `read_content` scope (Settings → Apps → Develop apps → create custom app)
- `GOOGLE_APPLICATION_CREDENTIALS` — absolute path to a GCP service account JSON with **BigQuery Data Viewer** + **BigQuery Job User** on project `data-stack-478719`
- `STOREFRONT_BASE_URL` — `https://www.firstday.com` (or wherever pages render)

## Refresh data

The dashboard renders the page list as soon as it loads, then layers metrics on top — so pages and metrics live in two separate files. You can refresh them independently.

```bash
source .venv/bin/activate
python refresh.py                  # both: pages + 30-day metrics
python refresh.py pages            # Shopify pages only (no GCP creds needed)
python refresh.py metrics          # GA4 metrics only
python refresh.py --days 7         # 7-day metrics window
python refresh.py pages --tag evergreen   # only pages tagged "evergreen"
```

Writes `public/pages.json` and/or `public/metrics.json`.

## View locally

```bash
python -m http.server 8000 --directory public
# visit http://localhost:8000
```

## Deploy to Vercel

The site is static — `public/` is the deploy output.

**First-time:**

```bash
npm i -g vercel
vercel link        # link this folder to a Vercel project
vercel --prod      # deploy
```

`vercel.json` is already configured to serve `public/` as the site root with no build step.

**Updating data after deploy:**

1. Run `python refresh.py` locally
2. `git add public/pages.json public/metrics.json && git commit -m "refresh data" && git push` (if Git-connected)
   — or — `vercel --prod` to redeploy directly

**Auto-refresh (optional):**

`.github/workflows/refresh.yml` runs `refresh.py` on a daily cron and commits `public/pages.json` + `public/metrics.json`. Set repo secrets:

- `SHOPIFY_ADMIN_TOKEN`
- `STOREFRONT_BASE_URL`
- `GCP_SA_KEY` (full service account JSON, pasted as a secret)

If the repo is connected to Vercel, each commit auto-deploys.
