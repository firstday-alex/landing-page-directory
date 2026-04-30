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

PAGES_GRAPHQL = """
query Pages($cursor: String) {
  pages(first: 100, after: $cursor) {
    edges {
      node {
        id
        title
        handle
        updatedAt
        publishedAt
        isPublished
        templateSuffix
        metafield(namespace: "custom", key: "tags") {
          value
          type
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""


def fetch_shopify_pages(domain, token, api_version, debug=False):
    """Fetch all pages + custom.tags metafield via Admin GraphQL (one query, paginated)."""
    url = f"https://{domain}/admin/api/{api_version}/graphql.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    pages, cursor = [], None
    while True:
        r = requests.post(
            url,
            json={"query": PAGES_GRAPHQL, "variables": {"cursor": cursor}},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if "errors" in data:
            sys.exit(f"GraphQL errors: {json.dumps(data['errors'], indent=2)}")
        conn = data["data"]["pages"]
        for edge in conn["edges"]:
            pages.append(edge["node"])
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]

    if debug:
        with_meta = [p for p in pages if p.get("metafield")]
        print(f"  [debug] {len(with_meta)}/{len(pages)} pages have a custom.tags metafield")
        for p in with_meta[:3]:
            print(f"  [debug] sample: {p['handle']} → type={p['metafield'].get('type')} value={p['metafield'].get('value')!r}")
    return pages


def parse_metafield_tags(metafield):
    """Handle both list.* (JSON array) and single_line_text_field (comma-separated)."""
    if not metafield:
        return []
    value = metafield.get("value", "")
    if not isinstance(value, str):
        return []
    value = value.strip()
    if not value:
        return []
    if value.startswith("["):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(t).strip() for t in parsed if str(t).strip()]
        except json.JSONDecodeError:
            pass
    return [t.strip() for t in value.split(",") if t.strip()]


def numeric_page_id(gid):
    """gid://shopify/Page/123456 → 123456 (string for safe JSON serialization)."""
    if not gid:
        return None
    return gid.rsplit("/", 1)[-1]


def normalize_path(url_or_path):
    path = urlparse(url_or_path).path if url_or_path.startswith("http") else url_or_path
    return path.rstrip("/") or "/"


def cmd_pages(cfg, tag_filter=None, debug=False):
    token = require_env("SHOPIFY_ADMIN_TOKEN")
    storefront = require_env("STOREFRONT_BASE_URL")

    print(f"→ Fetching Shopify pages from {cfg['shopify_store_domain']} (GraphQL)…")
    pages = fetch_shopify_pages(
        cfg["shopify_store_domain"], token, cfg["shopify_api_version"], debug=debug
    )
    pages = [p for p in pages if p.get("isPublished") or p.get("publishedAt")]
    print(f"  {len(pages)} published pages")

    rows = []
    for p in pages:
        tags = parse_metafield_tags(p.get("metafield"))

        if tag_filter and tag_filter.lower() not in [t.lower() for t in tags]:
            continue

        handle = p.get("handle", "")
        url = f"{storefront.rstrip('/')}/pages/{handle}"
        rows.append({
            "id": numeric_page_id(p.get("id")),
            "title": p.get("title", ""),
            "handle": handle,
            "url": url,
            "path": normalize_path(url),
            "tags": tags,
            "updated_at": p.get("updatedAt"),
            "published_at": p.get("publishedAt"),
        })

    rows.sort(key=lambda r: (r["title"] or "").lower())

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "filter": {"tag": tag_filter},
        "store": cfg["shopify_store_domain"],
        "storefront": storefront,
        "default_filter_tag": cfg.get("default_filter_tag", ""),
        "rows": rows,
    }
    write_json(PUBLIC_DIR / "pages.json", output)
    print(f"✓ Wrote public/pages.json ({len(rows)} rows)")


# ─────────────────────────── GA4 / BigQuery ───────────────────────────


def query_ga4_metrics(client, project, property_id, start_date, end_date):
    # Landing-page semantics: each session is attributed to its FIRST page_view URL.
    # Purchases/revenue from that session credit the landing page, not /thank_you.
    # Restricted to /pages/* (Shopify content pages) to keep the join surface small.
    sql = f"""
    WITH events AS (
      SELECT
        user_pseudo_id,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS session_id,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged,
        event_name,
        event_timestamp,
        ecommerce.purchase_revenue AS purchase_revenue
      FROM `{project}.analytics_{property_id}.events_*`
      WHERE _TABLE_SUFFIX BETWEEN @start_date AND @end_date
    ),
    landing AS (
      SELECT
        user_pseudo_id,
        session_id,
        REGEXP_EXTRACT(page_location, r'^https?://[^/]+([^?#]*)') AS page_path
      FROM events
      WHERE event_name = 'page_view'
        AND page_location IS NOT NULL
        AND session_id IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY user_pseudo_id, session_id
        ORDER BY event_timestamp ASC
      ) = 1
    ),
    session_metrics AS (
      SELECT
        user_pseudo_id,
        session_id,
        MAX(IF(session_engaged = '1', 1, 0)) AS engaged,
        COUNTIF(event_name = 'purchase') AS purchases,
        SUM(IF(event_name = 'purchase', COALESCE(purchase_revenue, 0), 0)) AS revenue
      FROM events
      WHERE session_id IS NOT NULL
      GROUP BY user_pseudo_id, session_id
    )
    SELECT
      l.page_path,
      COUNT(*) AS sessions,
      SUM(s.engaged) AS engaged_sessions,
      SUM(s.purchases) AS purchases,
      SUM(s.revenue) AS revenue
    FROM landing l
    JOIN session_metrics s USING (user_pseudo_id, session_id)
    WHERE l.page_path IS NOT NULL
      AND l.page_path != ''
      AND l.page_path LIKE '/pages/%'
    GROUP BY l.page_path
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
    parser.add_argument("--debug", action="store_true",
                        help="Print sample of metafields found, for diagnosing tag issues")
    args = parser.parse_args()

    if args.target in ("pages", "all"):
        cmd_pages(cfg, tag_filter=args.tag, debug=args.debug)
    if args.target in ("metrics", "all"):
        cmd_metrics(cfg, days=args.days)


if __name__ == "__main__":
    main()
