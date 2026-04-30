const state = {
  rows: [],            // pages, enriched with metrics when available
  filtered: [],
  metricsByPath: null, // null = not loaded yet, {} = loaded
  sortKey: 'title',    // initial sort: alphabetical, since metrics may not be in yet
  sortDir: 'asc',
  search: '',
  tag: '',
  hideZero: false,
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

// ─── Stage 1: load pages and render immediately ───
async function loadPages() {
  try {
    const res = await fetch('pages.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.rows = (data.rows || []).map((r) => ({ ...r })); // metrics merged in stage 2

    document.getElementById('count').textContent = state.rows.length;
    document.getElementById('pagesGen').textContent =
      data.generated_at ? new Date(data.generated_at).toLocaleString() : 'never — run python refresh.py pages';

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

    for (const r of state.rows) {
      const m = state.metricsByPath[r.path];
      if (m) Object.assign(r, m);
    }

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

function apply() {
  const q = state.search.trim().toLowerCase();
  state.filtered = state.rows.filter((r) => {
    if (state.hideZero && (r.sessions || 0) === 0) return false;
    if (state.tag && !(r.tags || []).map((t) => t.toLowerCase()).includes(state.tag.toLowerCase())) return false;
    if (!q) return true;
    const hay = [r.title, r.url, r.handle, ...(r.tags || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });

  state.filtered.sort((a, b) => {
    const k = state.sortKey;
    let av = a[k], bv = b[k];
    if (k === 'tags') { av = (a.tags || []).join(','); bv = (b.tags || []).join(','); }
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string' && typeof bv === 'string') {
      return state.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return state.sortDir === 'asc' ? av - bv : bv - av;
  });

  render();
  updateSortIndicators();
}

function render() {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  if (state.filtered.length === 0) {
    tbody.innerHTML = '';
    if (state.rows.length > 0) empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const metricsLoaded = state.metricsByPath !== null;

  tbody.innerHTML = state.filtered.map((r) => {
    const hasMetrics = metricsLoaded && r.sessions != null;
    const cell = (val) => hasMetrics ? val : '<span class="skeleton">—</span>';
    return `
    <tr>
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
    </tr>
  `;
  }).join('');
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
  const headers = ['title', 'url', 'tags', 'updated_at', 'sessions', 'cvr', 'bounce_rate', 'revenue_per_session', 'aov', 'revenue', 'purchases'];
  const lines = [headers.join(',')];
  for (const r of state.filtered) {
    const row = [
      r.title, r.url, (r.tags || []).join('|'),
      r.updated_at, r.sessions, r.cvr, r.bounce_rate,
      r.revenue_per_session, r.aov, r.revenue, r.purchases,
    ].map(csvCell).join(',');
    lines.push(row);
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
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
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
