#!/usr/bin/env python3
"""
Refresh data for the Landing Page Directory.

Writes two files:
  public/pages.json    — published Shopify pages (fast, Shopify-only)
  public/metrics.json  — GA4 BigQuery metrics keyed by URL path

The dashboard loads pages.json first (renders immediately), then layers
metrics.json on top — so the team sees the directory instantly even if
the BigQuery query is slow or hasn't been run yet.

Usage:
    python refresh.py                 # refresh both (last 30 days)
    python refresh.py pages           # Shopify pages only
    python refresh.py metrics         # GA4 metrics only
    python refresh.py --days 7
    python refresh.py pages --tag evergreen
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
PUBLIC_DIR = ROOT / "public"
CONFIG_PATH = ROOT / "config.json"


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit("config.json missing — copy config.example.json to config.json")
    with CONFIG_PATH.open() as f:
        return json.load(f)


# ─────────────────────────── Shopify ───────────────────────────


def fetch_shopify_pages(domain, token, api_version):
    pages = []
    url = f"https://{domain}/admin/api/{api_version}/pages.json"
    params = {"limit": 250, "published_status": "published"}
    headers = {"X-Shopify-Access-Token": token, "Accept": "application/json"}

    while url:
        r = requests.get(url, params=params, headers=headers, timeout=30)
        r.raise_for_status()
        pages.extend(r.json().get("pages", []))
        next_url = None
        for part in r.headers.get("Link", "").split(","):
            if 'rel="next"' in part:
                next_url = part.split(";")[0].strip().strip("<>")
                break
        url = next_url
        params = None
    return pages


def fetch_page_metafield_tags(domain, token, api_version, page_id):
    """Read tags from metafield (namespace=custom, key=tags). Returns list."""
    url = f"https://{domain}/admin/api/{api_version}/pages/{page_id}/metafields.json"
    headers = {"X-Shopify-Access-Token": token, "Accept": "application/json"}
    r = requests.get(url, headers=headers, timeout=30)
    if r.status_code != 200:
        return []
    for mf in r.json().get("metafields", []):
        if mf.get("namespace") == "custom" and mf.get("key") == "tags":
            value = mf.get("value", "")
            if isinstance(value, str):
                return [t.strip() for t in value.split(",") if t.strip()]
    return []


def normalize_path(url_or_path):
    path = urlparse(url_or_path).path if url_or_path.startswith("http") else url_or_path
    return path.rstrip("/") or "/"


def cmd_pages(cfg, tag_filter=None):
    token = require_env("SHOPIFY_ADMIN_TOKEN")
    storefront = require_env("STOREFRONT_BASE_URL")

    print(f"→ Fetching Shopify pages from {cfg['shopify_store_domain']}…")
    pages = fetch_shopify_pages(
        cfg["shopify_store_domain"], token, cfg["shopify_api_version"]
    )
    print(f"  {len(pages)} published pages")

    rows = []
    for p in pages:
        # Tags: prefer the inline `tags` field if present, else metafield
        raw_tags = p.get("tags") or ""
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()] if isinstance(raw_tags, str) else []
        if not tags:
            tags = fetch_page_metafield_tags(
                cfg["shopify_store_domain"], token, cfg["shopify_api_version"], p["id"]
            )

        if tag_filter and tag_filter.lower() not in [t.lower() for t in tags]:
            continue

        handle = p.get("handle", "")
        url = f"{storefront.rstrip('/')}/pages/{handle}"
        rows.append({
            "id": p.get("id"),
            "title": p.get("title", ""),
            "handle": handle,
            "url": url,
            "path": normalize_path(url),
            "tags": tags,
            "updated_at": p.get("updated_at"),
            "published_at": p.get("published_at"),
        })

    rows.sort(key=lambda r: (r["title"] or "").lower())

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "filter": {"tag": tag_filter},
        "store": cfg["shopify_store_domain"],
        "storefront": storefront,
        "rows": rows,
    }
    write_json(PUBLIC_DIR / "pages.json", output)
    print(f"✓ Wrote public/pages.json ({len(rows)} rows)")


# ─────────────────────────── GA4 / BigQuery ───────────────────────────


def query_ga4_metrics(client, project, property_id, start_date, end_date):
    sql = f"""
    WITH base AS (
      SELECT
        user_pseudo_id,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged,
        event_name,
        ecommerce.purchase_revenue AS purchase_revenue
      FROM `{project}.analytics_{property_id}.events_*`
      WHERE _TABLE_SUFFIX BETWEEN @start_date AND @end_date
    ),
    sessions AS (
      SELECT
        REGEXP_EXTRACT(page_location, r'^https?://[^/]+([^?#]*)') AS page_path,
        user_pseudo_id,
        session_id,
        MAX(IF(session_engaged = '1', 1, 0)) AS engaged,
        COUNTIF(event_name = 'purchase') AS purchases,
        SUM(IF(event_name = 'purchase', COALESCE(purchase_revenue, 0), 0)) AS revenue
      FROM base
      WHERE page_location IS NOT NULL AND session_id IS NOT NULL
      GROUP BY page_path, user_pseudo_id, session_id
    )
    SELECT
      page_path,
      COUNT(*) AS sessions,
      SUM(engaged) AS engaged_sessions,
      SUM(purchases) AS purchases,
      SUM(revenue) AS revenue
    FROM sessions
    WHERE page_path IS NOT NULL AND page_path != ''
    GROUP BY page_path
    """
    from google.cloud import bigquery
    job = client.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("start_date", "STRING", start_date),
                bigquery.ScalarQueryParameter("end_date", "STRING", end_date),
            ]
        ),
    )
    out = {}
    for row in job.result():
        path = (row["page_path"] or "").rstrip("/") or "/"
        sessions = int(row["sessions"] or 0)
        engaged = int(row["engaged_sessions"] or 0)
        purchases = int(row["purchases"] or 0)
        revenue = float(row["revenue"] or 0.0)
        out[path] = {
            "sessions": sessions,
            "engaged_sessions": engaged,
            "purchases": purchases,
            "revenue": round(revenue, 2),
            "cvr": round(purchases / sessions, 4) if sessions else 0.0,
            "bounce_rate": round(1 - engaged / sessions, 4) if sessions else 0.0,
            "revenue_per_session": round(revenue / sessions, 4) if sessions else 0.0,
            "aov": round(revenue / purchases, 2) if purchases else 0.0,
        }
    return out


def cmd_metrics(cfg, days):
    require_env("GOOGLE_APPLICATION_CREDENTIALS")
    from google.cloud import bigquery

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)

    print(f"→ Querying GA4 BigQuery export ({start:%Y-%m-%d} → {end:%Y-%m-%d}, {days}d)…")
    client = bigquery.Client(project=cfg["gcp_project"])
    by_path = query_ga4_metrics(
        client, cfg["gcp_project"], cfg["ga4_property_id"],
        start.strftime("%Y%m%d"), end.strftime("%Y%m%d"),
    )

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window": {"start": start.isoformat(), "end": end.isoformat(), "days": days},
        "by_path": by_path,
    }
    write_json(PUBLIC_DIR / "metrics.json", output)
    print(f"✓ Wrote public/metrics.json ({len(by_path)} paths)")


# ─────────────────────────── helpers ───────────────────────────


def require_env(name):
    val = os.environ.get(name)
    if not val:
        sys.exit(f"{name} must be set in .env")
    return val


def write_json(path, obj):
    PUBLIC_DIR.mkdir(exist_ok=True)
    with path.open("w") as f:
        json.dump(obj, f, indent=2)


# ─────────────────────────── entrypoint ───────────────────────────


def main():
    load_dotenv(ROOT / ".env")
    cfg = load_config()

    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", choices=["pages", "metrics", "all"], default="all")
    parser.add_argument("--days", type=int, default=cfg.get("default_days", 30))
    parser.add_argument("--tag", type=str, default=None,
                        help="Only include pages whose tags contain this value (case-insensitive)")
    args = parser.parse_args()

    if args.target in ("pages", "all"):
        cmd_pages(cfg, tag_filter=args.tag)
    if args.target in ("metrics", "all"):
        cmd_metrics(cfg, days=args.days)


if __name__ == "__main__":
    main()
