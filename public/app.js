const LS_KEY = 'lpd.filterTag.v1';

const state = {
  rows: [],            // pages, enriched with metrics when available
  filtered: [],
  metricsByPath: null, // null = not loaded yet, {} = loaded
  sortKey: 'title',    // initial sort: alphabetical, since metrics may not be in yet
  sortDir: 'asc',
  search: '',
  tag: '',
  hideZero: false,
  filterTag: '',       // when set, only pages tagged with this; grouped by other tags
  collapsed: new Set(),
};

const fmt = {
  int: (n) => (n == null ? '—' : Number(n).toLocaleString('en-US')),
  pct: (n) => (n == null ? '—' : (n * 100).toFixed(2) + '%'),
  money: (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
  money4: (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })),
  date: (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  },
};

// Merge metrics into rows by path. Idempotent — safe to call repeatedly.
// Both loadPages() and loadMetrics() call this so the order of arrival doesn't matter.
function mergeMetricsIntoRows() {
  if (state.metricsByPath === null) return;
  let matched = 0;
  for (const r of state.rows) {
    const m = state.metricsByPath[r.path];
    if (m) {
      Object.assign(r, m);
      matched += 1;
    }
  }
  if (state.rows.length && state.metricsByPath) {
    console.debug(`[lp-directory] merged metrics: ${matched}/${state.rows.length} pages matched`);
  }
}

// ─── Stage 1: load pages and render immediately ───
async function loadPages() {
  try {
    const res = await fetch('pages.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.rows = (data.rows || []).map((r) => ({ ...r }));

    document.getElementById('count').textContent = state.rows.length;
    document.getElementById('pagesGen').textContent =
      data.generated_at ? new Date(data.generated_at).toLocaleString() : 'never — run python refresh.py pages';

    // Filter tag: localStorage override > config default > empty
    const stored = localStorage.getItem(LS_KEY);
    const initial = stored != null ? stored : (data.default_filter_tag || '');
    state.filterTag = initial;
    document.getElementById('filterTag').value = initial;

    // If metrics already arrived first, merge them into the rows we just loaded.
    mergeMetricsIntoRows();

    populateTags();
    apply();
  } catch (err) {
    showError(`Could not load pages.json — run \`python refresh.py pages\` first. (${err.message})`);
  }
}

// ─── Stage 2: load metrics and merge ───
async function loadMetrics() {
  const statusEl = document.getElementById('metricsStatus');
  try {
    const res = await fetch('metrics.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.metricsByPath = data.by_path || {};

    // If pages already arrived first, this fills in their metric fields.
    // If pages arrive later, loadPages() will call mergeMetricsIntoRows() too.
    mergeMetricsIntoRows();

    const hasData = data.generated_at && data.window?.start && data.window?.end;
    statusEl.classList.remove('loading');
    if (hasData) {
      statusEl.textContent = `${data.window.start} → ${data.window.end} (${data.window.days}d)`;
      statusEl.classList.add('ready');
    } else {
      statusEl.textContent = 'no data yet — run python refresh.py metrics';
      statusEl.classList.add('warn');
    }

    // Default to ranking by sessions once we have them
    if (state.sortKey === 'title') {
      state.sortKey = 'sessions';
      state.sortDir = 'desc';
    }
    apply();
  } catch (err) {
    statusEl.textContent = 'unavailable';
    statusEl.classList.remove('loading');
    statusEl.classList.add('warn');
    statusEl.title = err.message;
    state.metricsByPath = {};
    apply();
  }
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function populateTags() {
  const sel = document.getElementById('tagFilter');
  const all = new Set();
  for (const r of state.rows) for (const t of r.tags || []) all.add(t);
  const tags = [...all].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">All tags</option>' +
    tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

// ─── Filtering + sorting ───
function applyFilters(rows) {
  const q = state.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (state.hideZero && (r.sessions || 0) === 0) return false;
    if (state.tag && !(r.tags || []).map((t) => t.toLowerCase()).includes(state.tag.toLowerCase())) return false;
    if (!q) return true;
    const hay = [r.title, r.url, r.handle, ...(r.tags || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function sortRows(rows) {
  const k = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === 'tags') { av = (a.tags || []).join(','); bv = (b.tags || []).join(','); }

    // NULLS LAST — pages missing this value always sort to the bottom,
    // regardless of asc/desc. Otherwise no-data rows interleave with real data.
    const aMissing = av == null || av === '';
    const bMissing = bv == null || bv === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;

    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

function apply() {
  state.filtered = applyFilters(state.rows);
  render();
  updateSortIndicators();
}

// ─── Grouping ───
// Pages must include `filterTag` (case-insensitive). Then group by every OTHER tag.
// A page with N other tags appears in N groups. Pages with no other tags go to "(no other tags)".
function buildGroups(rows, filterTag) {
  const norm = filterTag.toLowerCase();
  const groups = new Map();
  const ungrouped = [];
  for (const r of rows) {
    const lowered = (r.tags || []).map((t) => t.toLowerCase());
    if (!lowered.includes(norm)) continue;

    const others = (r.tags || []).filter((t) => t.toLowerCase() !== norm);
    if (others.length === 0) {
      ungrouped.push(r);
      continue;
    }
    for (const t of others) {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(r);
    }
  }
  if (ungrouped.length > 0) groups.set('(no other tags)', ungrouped);
  return groups;
}

function aggregate(rows) {
  const sessions = rows.reduce((s, r) => s + (r.sessions || 0), 0);
  const engaged = rows.reduce((s, r) => s + (r.engaged_sessions || 0), 0);
  const purchases = rows.reduce((s, r) => s + (r.purchases || 0), 0);
  const revenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
  return {
    pages: rows.length,
    sessions,
    engaged_sessions: engaged,
    purchases,
    revenue,
    cvr: sessions ? purchases / sessions : 0,
    bounce_rate: sessions ? 1 - engaged / sessions : 0,
    revenue_per_session: sessions ? revenue / sessions : 0,
    aov: purchases ? revenue / purchases : 0,
  };
}

function groupSortKey(g) {
  // Sort groups by the same metric the user picked, derived from aggregates.
  // Title sort = sort group keys alphabetically.
  if (state.sortKey === 'title' || state.sortKey === 'tags') return g.key.toLowerCase();
  if (state.sortKey === 'updated_at') return g.latest;
  return g.agg[state.sortKey] ?? 0;
}

// ─── Render ───
function render() {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  empty.classList.add('hidden');

  if (state.filtered.length === 0 && state.rows.length > 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  const metricsLoaded = state.metricsByPath !== null;
  // Skeleton (animated) only while the metrics file is in flight.
  // Once loaded, pages without GA4 data render plain '—' via fmt helpers.
  const cell = metricsLoaded ? (val) => val : () => '<span class="skeleton">—</span>';

  if (state.filterTag) {
    tbody.innerHTML = renderGrouped(state.filtered, metricsLoaded, cell);
  } else {
    const sorted = sortRows(state.filtered);
    tbody.innerHTML = sorted.map((r) => renderRow(r, metricsLoaded, cell)).join('');
  }
}

function renderGrouped(rows, metricsLoaded, cell) {
  const groups = buildGroups(rows, state.filterTag);

  if (groups.size === 0) {
    document.getElementById('empty').classList.remove('hidden');
    return '';
  }

  const groupArr = [...groups.entries()].map(([key, grows]) => ({
    key,
    rows: sortRows(grows),
    agg: aggregate(grows),
    latest: grows.reduce((acc, r) => (r.updated_at && r.updated_at > acc ? r.updated_at : acc), ''),
  }));

  const dir = state.sortDir === 'asc' ? 1 : -1;
  groupArr.sort((a, b) => {
    const av = groupSortKey(a), bv = groupSortKey(b);
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  return groupArr.map((g) => {
    const isCollapsed = state.collapsed.has(g.key);
    const triangle = isCollapsed ? '▸' : '▾';
    const a = g.agg;

    const headerCells = `
      <td class="num">${cell(fmt.int(a.sessions))}</td>
      <td class="num">${cell(fmt.pct(a.cvr))}</td>
      <td class="num">${cell(fmt.pct(a.bounce_rate))}</td>
      <td class="num">${cell(fmt.money4(a.revenue_per_session))}</td>
      <td class="num">${cell(fmt.money(a.aov))}</td>
      <td class="num">${cell(fmt.money(a.revenue))}</td>
      <td></td>`;

    const header = `
      <tr class="group-header" data-group-key="${escapeHtml(g.key)}">
        <td colspan="3">
          <span class="triangle">${triangle}</span>
          <strong class="group-name">${escapeHtml(g.key)}</strong>
          <span class="group-meta">${g.rows.length} page${g.rows.length === 1 ? '' : 's'} · tag <code>${escapeHtml(g.key)}</code></span>
        </td>
        ${headerCells}
      </tr>`;

    const body = isCollapsed
      ? ''
      : g.rows.map((r) => renderRow(r, metricsLoaded, cell, true)).join('');

    return header + body;
  }).join('');
}

function renderRow(r, metricsLoaded, cell, indent = false) {
  return `
    <tr${indent ? ' class="grouped"' : ''}>
      <td>
        <div class="page-title">${escapeHtml(r.title || '(untitled)')}</div>
        <div class="page-url"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a></div>
      </td>
      <td>${(r.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') || '<span class="tag" style="opacity:.4">—</span>'}</td>
      <td>${fmt.date(r.updated_at)}</td>
      <td class="num">${cell(fmt.int(r.sessions))}</td>
      <td class="num">${cell(fmt.pct(r.cvr))}</td>
      <td class="num">${cell(fmt.pct(r.bounce_rate))}</td>
      <td class="num">${cell(fmt.money4(r.revenue_per_session))}</td>
      <td class="num">${cell(fmt.money(r.aov))}</td>
      <td class="num">${cell(fmt.money(r.revenue))}</td>
      <td class="num"><button class="copy-btn" data-url="${escapeHtml(r.url)}">Copy URL</button></td>
    </tr>`;
}

function updateSortIndicators() {
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    let arrow = th.querySelector('.arrow');
    if (!arrow) {
      arrow = document.createElement('span');
      arrow.className = 'arrow';
      th.appendChild(arrow);
    }
    arrow.textContent = th.dataset.sort === state.sortKey
      ? (state.sortDir === 'asc' ? '▲' : '▼')
      : '';
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function exportCsv() {
  const headers = ['group', 'title', 'url', 'tags', 'updated_at', 'sessions', 'cvr', 'bounce_rate', 'revenue_per_session', 'aov', 'revenue', 'purchases'];
  const lines = [headers.join(',')];

  const buildLine = (r, group) => [
    group, r.title, r.url, (r.tags || []).join('|'),
    r.updated_at, r.sessions, r.cvr, r.bounce_rate,
    r.revenue_per_session, r.aov, r.revenue, r.purchases,
  ].map(csvCell).join(',');

  if (state.filterTag) {
    const groups = buildGroups(state.filtered, state.filterTag);
    for (const [key, rows] of groups) {
      for (const r of sortRows(rows)) lines.push(buildLine(r, key));
    }
  } else {
    for (const r of sortRows(state.filtered)) lines.push(buildLine(r, ''));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `landing-pages-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─── Event handlers ───
document.getElementById('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  apply();
});

document.getElementById('tagFilter').addEventListener('change', (e) => {
  state.tag = e.target.value;
  apply();
});

document.getElementById('hideZero').addEventListener('change', (e) => {
  state.hideZero = e.target.checked;
  apply();
});

let filterTagDebounce;
document.getElementById('filterTag').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  state.filterTag = v;
  state.collapsed.clear();
  clearTimeout(filterTagDebounce);
  filterTagDebounce = setTimeout(() => localStorage.setItem(LS_KEY, v), 250);
  apply();
});

document.getElementById('exportCsv').addEventListener('click', exportCsv);

document.querySelectorAll('thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = k;
      state.sortDir = ['title', 'tags', 'updated_at'].includes(k) ? 'asc' : 'desc';
    }
    apply();
  });
});

document.addEventListener('click', async (e) => {
  // Toggle group collapse
  const groupHeader = e.target.closest('.group-header');
  if (groupHeader) {
    const key = groupHeader.dataset.groupKey;
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    apply();
    return;
  }

  // Copy URL
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText(btn.dataset.url);
    const original = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1200);
  } catch {}
});

// Stage 1 first, stage 2 in parallel — pages render as soon as they arrive,
// metrics layer in when ready.
loadPages();
loadMetrics();
