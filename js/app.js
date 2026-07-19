// app.js — UI state, rendering, and persistence for the retirement calculator.
import {
  BUCKETS, BUCKET_META, DEFAULT_ASSUMPTIONS, project, parseRate,
} from './calc.js';
import { createChart, fmtMoneyCompact, fmtMoneyFull } from './chart.js';
import {
  looksLikeAccessUrl, splitAccessUrl, claimSetupToken, fetchSimplefinAccounts,
  mergeSimplefinAccounts,
} from './simplefin.js';
import { parseRepoPath, fetchGithubBalances } from './ghsync.js';

const STORE_KEY = 'm3ta-retirement-v1';
const ACCOUNT_TYPES = [
  ['roth', 'Roth (IRA/401k)'],
  ['trad', 'Traditional (pre-tax)'],
  ['taxable', 'Taxable brokerage'],
  ['cash', 'Cash / HYSA'],
  ['hsa', 'HSA'],
];
const BUCKET_COLOR_VAR = {
  roth: '--series-1', trad: '--series-2', taxable: '--series-3',
  cash: '--series-4', hsa: '--series-5',
};

const SAMPLE_STATE = {
  v: 1,
  sample: true,
  plan: 'amortize',
  dollars: 'real',
  simplefin: { accessUrl: '', lastSync: null },
  ghsync: { repo: '', pat: '' },
  accounts: [
    { id: 1, name: 'Roth 401(k)', type: 'roth', balance: 150000, annualContribution: 20000 },
    { id: 2, name: 'Roth IRA', type: 'roth', balance: 60000, annualContribution: 7000 },
    { id: 3, name: 'Old Traditional 401(k)', type: 'trad', balance: 40000, annualContribution: 0 },
    { id: 4, name: 'Brokerage', type: 'taxable', balance: 35000, annualContribution: 6000 },
    { id: 5, name: 'High-yield savings', type: 'cash', balance: 25000, annualContribution: 3000 },
  ],
  // Percent fields are stored in percent units, ages in years.
  assumptions: {
    currentAge: 35, retireAge: 65, endAge: 95,
    preRetReturn: 7, postRetReturn: 5, inflation: 2.5, contribGrowth: 2,
    withdrawalRate: 4, filingStatus: 'single', stateTaxRate: 0, effTaxOverride: '',
  },
};

let state = loadState();
let nextId = Math.max(0, ...state.accounts.map((a) => a.id)) + 1;
let projection = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1 && Array.isArray(parsed.accounts)) {
        return { ...structuredClone(SAMPLE_STATE), ...parsed, sample: !!parsed.sample };
      }
    }
  } catch { /* fall through to sample */ }
  return structuredClone(SAMPLE_STATE);
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function markEdited() {
  if (state.sample) {
    state.sample = false;
    document.getElementById('sample-note').hidden = true;
  }
}

function assumptionsForCalc() {
  const u = state.assumptions;
  const num = (v, fb) => { const n = parseFloat(v); return isFinite(n) ? n : fb; };
  const cur = Math.round(num(u.currentAge, 35));
  const ret = Math.max(cur, Math.round(num(u.retireAge, 65)));
  const end = Math.max(ret + 1, Math.round(num(u.endAge, 95)));
  const override = String(u.effTaxOverride).trim() === '' ? null : parseRate(u.effTaxOverride, 0);
  return {
    ...DEFAULT_ASSUMPTIONS,
    currentAge: cur, retireAge: ret, endAge: end,
    preRetReturn: parseRate(u.preRetReturn, 0.07),
    postRetReturn: parseRate(u.postRetReturn, 0.05),
    inflation: parseRate(u.inflation, 0.025),
    contribGrowth: parseRate(u.contribGrowth, 0),
    withdrawalRate: parseRate(u.withdrawalRate, 0.04),
    filingStatus: u.filingStatus === 'married' ? 'married' : 'single',
    stateTaxRate: parseRate(u.stateTaxRate, 0),
    effTaxOverride: override,
  };
}

// ---------- accounts editor ----------

function renderAccounts() {
  const list = document.getElementById('accounts-list');
  list.textContent = '';
  const tpl = document.getElementById('account-row-tpl');
  for (const acct of state.accounts) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    const name = row.querySelector('.acct-name');
    const type = row.querySelector('.acct-type');
    const bal = row.querySelector('.acct-balance');
    const contrib = row.querySelector('.acct-contrib');
    for (const [value, label] of ACCOUNT_TYPES) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label;
      type.appendChild(opt);
    }
    name.value = acct.name;
    type.value = acct.type;
    bal.value = acct.balance;
    contrib.value = acct.annualContribution;
    row.querySelector('.acct-dot').style.background =
      getComputedStyle(document.body).getPropertyValue(BUCKET_COLOR_VAR[acct.type] || '--series-3');

    name.addEventListener('input', () => { acct.name = name.value; markEdited(); saveState(); });
    type.addEventListener('change', () => { acct.type = type.value; markEdited(); update(); renderAccounts(); });
    const numHandler = (input, key) => input.addEventListener('input', () => {
      const n = parseFloat(input.value);
      acct[key] = isFinite(n) && n >= 0 ? n : 0;
      markEdited(); update();
    });
    numHandler(bal, 'balance');
    numHandler(contrib, 'annualContribution');
    row.querySelector('.acct-remove').addEventListener('click', () => {
      state.accounts = state.accounts.filter((a) => a.id !== acct.id);
      markEdited(); update(); renderAccounts();
    });
    list.appendChild(row);
  }
}

// ---------- results ----------

const fmtPct = (f, digits = 0) => `${(f * 100).toFixed(digits)}%`;
const fmtStat = (v) => (Math.abs(v) >= 1e6 ? fmtMoneyCompact(v) : fmtMoneyFull(v));

function setText(id, text) { document.getElementById(id).textContent = text; }

function update() {
  saveState();
  const a = assumptionsForCalc();
  projection = project(state.accounts, a, state.plan);
  const { totals, spending } = projection;

  const spend = state.plan === 'percent' ? spending.percentSpendReal : spending.amortizeSpendReal;
  const gross = state.plan === 'percent' ? spending.percentGrossReal : spending.amortizeGrossReal;

  setText('hero-value', fmtStat(spend));
  setText('hero-sub', state.plan === 'percent'
    ? `per year after tax in today's dollars — first year of the ${fmtPct(a.withdrawalRate, 1)} rule, retiring at ${a.retireAge}`
    : `per year after tax in today's dollars — spending to zero from ${a.retireAge} through ${a.endAge}`);

  setText('stat-nominal', fmtStat(totals.atRetirementNominal));
  setText('stat-real', fmtStat(totals.atRetirementReal));
  setText('stat-aftertax', fmtStat(state.dollars === 'real' ? totals.afterTaxReal : totals.afterTaxNominal));
  document.getElementById('stat-aftertax-label').textContent =
    `After-tax value at ${a.retireAge} (${state.dollars === 'real' ? "today's $" : 'future $'})`;
  setText('stat-taxfree', fmtPct(totals.taxFreeShare));
  setText('stat-gross', `${fmtStat(gross)} gross · ${fmtPct(spending.effTaxRate, 1)} effective tax`);

  renderComposition();
  renderLegend();
  chart.render();
  renderTable();
}

function visibleSeries() {
  // Keep the validated stack order; drop buckets that never hold money.
  const shown = BUCKETS.filter((b) =>
    projection.series.some((y) => y[state.dollars][b] > 0.5));
  return shown.map((b) => ({
    key: b,
    label: BUCKET_META[b].label,
    colorVar: BUCKET_COLOR_VAR[b],
    values: projection.series.map((y) => y[state.dollars][b]),
  }));
}

function renderLegend() {
  const legend = document.getElementById('chart-legend');
  legend.textContent = '';
  for (const sr of visibleSeries()) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = getComputedStyle(document.body).getPropertyValue(sr.colorVar);
    const label = document.createElement('span');
    label.textContent = sr.label;
    item.append(swatch, label);
    legend.appendChild(item);
  }
}

function renderComposition() {
  const a = assumptionsForCalc();
  const now = projection.series[0];
  const ret = projection.series.find((y) => y.age === a.retireAge) || now;
  for (const [suffix, snap] of [['now', now], ['ret', ret]]) {
    const bar = document.getElementById(`comp-${suffix}`);
    const labels = document.getElementById(`comp-${suffix}-labels`);
    bar.textContent = ''; labels.textContent = '';
    const total = BUCKETS.reduce((s, b) => s + snap.real[b], 0);
    if (total <= 0) continue;
    for (const b of BUCKETS) {
      const share = snap.real[b] / total;
      if (share < 0.001) continue;
      const seg = document.createElement('span');
      seg.className = 'comp-seg';
      seg.style.flexGrow = String(share * 1000);
      seg.style.background = getComputedStyle(document.body).getPropertyValue(BUCKET_COLOR_VAR[b]);
      seg.title = `${BUCKET_META[b].label}: ${fmtPct(share)}`;
      bar.appendChild(seg);
      const chip = document.createElement('span');
      chip.className = 'comp-chip';
      const dot = document.createElement('span');
      dot.className = 'comp-dot';
      dot.style.background = getComputedStyle(document.body).getPropertyValue(BUCKET_COLOR_VAR[b]);
      const txt = document.createElement('span');
      txt.textContent = `${BUCKET_META[b].label} ${fmtPct(share)}`;
      chip.append(dot, txt);
      labels.appendChild(chip);
    }
  }
}

function renderTable() {
  const a = assumptionsForCalc();
  const body = document.getElementById('table-body');
  body.textContent = '';
  const nowYear = new Date().getFullYear();
  const defl = (age) => Math.pow(1 + a.inflation, age - a.currentAge);
  for (const y of projection.series) {
    const tr = document.createElement('tr');
    const cells = [y.age, nowYear + (y.age - a.currentAge)];
    for (const b of BUCKETS) cells.push(fmtMoneyFull(y[state.dollars][b]));
    const total = BUCKETS.reduce((s, b) => s + y[state.dollars][b], 0);
    cells.push(fmtMoneyFull(total));
    if (y.phase === 'drawdown') {
      const m = state.dollars === 'real' ? 1 : defl(y.age);
      cells.push(fmtMoneyFull(y.grossReal * m), fmtMoneyFull(y.taxReal * m), fmtMoneyFull(y.spendReal * m));
    } else {
      cells.push('—', '—', '—');
    }
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ---------- SimpleFIN sync ----------

function setSyncStatus(msg, isError = false) {
  const el = document.getElementById('sync-status');
  el.textContent = msg;
  el.classList.toggle('sync-error', isError);
}

function syncSource() {
  if (state.ghsync.repo && state.ghsync.pat) return 'github';
  if (state.simplefin.accessUrl) return 'simplefin';
  return null;
}

function renderSync() {
  const source = syncSource();
  document.getElementById('sync-disconnected').hidden = !!source;
  document.getElementById('gh-setup').hidden = !!source;
  document.getElementById('sync-connected').hidden = !source;
  if (source && state.simplefin.lastSync) {
    setSyncStatus(`Connected via ${source === 'github' ? 'GitHub' : 'SimpleFIN'} · last synced ${new Date(state.simplefin.lastSync).toLocaleString()}`);
  } else if (source) {
    setSyncStatus(`Connected via ${source === 'github' ? 'GitHub' : 'SimpleFIN'} — refresh to pull balances.`);
  }
}

async function refreshBalances() {
  const btn = document.getElementById('sync-refresh');
  btn.disabled = true;
  setSyncStatus('Syncing…');
  try {
    const viaGithub = syncSource() === 'github';
    const result = viaGithub
      ? await fetchGithubBalances(state.ghsync.repo, state.ghsync.pat)
      : await fetchSimplefinAccounts(state.simplefin.accessUrl);
    const sfAccounts = result.accounts;
    const errors = result.errors;
    const { accounts, added, updated } = mergeSimplefinAccounts(state.accounts, sfAccounts, () => nextId++);
    state.accounts = accounts;
    state.simplefin.lastSync = Date.now();
    markEdited(); update(); renderAccounts();
    let msg = `Synced ${sfAccounts.length} account${sfAccounts.length === 1 ? '' : 's'} — ${updated} updated, ${added} added.`;
    if (viaGithub && result.fetchedAt) {
      msg += ` Bank data as of ${new Date(result.fetchedAt).toLocaleString()}.`;
    }
    if (sfAccounts.length === 0) {
      msg += viaGithub
        ? ' The data repo synced zero accounts — check the bridge connection, then re-run the Sync workflow.'
        : ' No banks are linked yet — add them under "Connect to your bank" at beta-bridge.simplefin.org, then refresh.';
    }
    if (errors.length) msg += ` Bridge says: ${errors.join(' ')}`;
    setSyncStatus(msg, sfAccounts.length === 0 || errors.length > 0);
  } catch (err) {
    setSyncStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

async function connectGithub() {
  const repoInput = document.getElementById('gh-repo');
  const patInput = document.getElementById('gh-pat');
  const repo = repoInput.value.trim();
  const pat = patInput.value.trim();
  if (!repo || !pat) { setSyncStatus('Enter the data repo (owner/name) and a fine-grained PAT first.', true); return; }
  const btn = document.getElementById('gh-connect');
  btn.disabled = true;
  setSyncStatus('Connecting to GitHub…');
  try {
    parseRepoPath(repo); // throws on bad format
    try {
      await fetchGithubBalances(repo, pat);
    } catch (err) {
      if (!err.missingFile) throw err; // bad PAT/repo → don't save
      // Repo reachable but no balances.json yet: save and guide.
    }
    state.ghsync = { repo, pat };
    state.simplefin.lastSync = null;
    repoInput.value = ''; patInput.value = '';
    markEdited(); saveState(); renderSync();
    await refreshBalances();
  } catch (err) {
    setSyncStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

async function connectSimplefin() {
  const input = document.getElementById('sync-token');
  const value = input.value.trim();
  if (!value) { setSyncStatus('Paste a SimpleFIN setup token or access URL first.', true); return; }
  const btn = document.getElementById('sync-connect');
  btn.disabled = true;
  setSyncStatus('Connecting…');
  try {
    let accessUrl;
    if (looksLikeAccessUrl(value)) {
      splitAccessUrl(value); // validate
      accessUrl = value;
    } else {
      accessUrl = await claimSetupToken(value);
    }
    state.simplefin.accessUrl = accessUrl;
    state.simplefin.lastSync = null;
    input.value = '';
    markEdited(); saveState(); renderSync();
    await refreshBalances();
  } catch (err) {
    setSyncStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- chart ----------

const chart = createChart(document.getElementById('chart'), () => {
  const a = assumptionsForCalc();
  const nowYear = new Date().getFullYear();
  return {
    ages: projection.series.map((y) => y.age),
    series: visibleSeries(),
    retireAge: a.retireAge,
    yearForAge: (age) => nowYear + (age - a.currentAge),
    ariaLabel: 'Stacked area chart of projected balances by tax bucket from now through retirement',
    extraRows: (i) => {
      const y = projection.series[i];
      if (y.phase !== 'drawdown') return [];
      const m = state.dollars === 'real' ? 1 : Math.pow(1 + a.inflation, y.age - a.currentAge);
      return [{ label: 'Spend (after tax)', value: fmtMoneyFull(y.spendReal * m) }];
    },
  };
});

// ---------- wiring ----------

function bindAssumption(id, key) {
  const input = document.getElementById(id);
  input.value = state.assumptions[key];
  input.addEventListener('input', () => {
    state.assumptions[key] = input.value;
    markEdited(); update();
  });
}

function bindSegmented(groupId, key, onChange) {
  const group = document.getElementById(groupId);
  const buttons = group.querySelectorAll('button');
  const apply = () => buttons.forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === state[key])));
  buttons.forEach((b) => b.addEventListener('click', () => {
    state[key] = b.dataset.value; apply(); onChange();
  }));
  apply();
}

function init() {
  document.getElementById('sample-note').hidden = !state.sample;

  for (const [id, key] of [
    ['in-current-age', 'currentAge'], ['in-retire-age', 'retireAge'], ['in-end-age', 'endAge'],
    ['in-pre-return', 'preRetReturn'], ['in-post-return', 'postRetReturn'],
    ['in-inflation', 'inflation'], ['in-contrib-growth', 'contribGrowth'],
    ['in-withdrawal', 'withdrawalRate'], ['in-state-tax', 'stateTaxRate'],
    ['in-tax-override', 'effTaxOverride'],
  ]) bindAssumption(id, key);

  const filing = document.getElementById('in-filing');
  filing.value = state.assumptions.filingStatus;
  filing.addEventListener('change', () => {
    state.assumptions.filingStatus = filing.value; markEdited(); update();
  });

  bindSegmented('toggle-dollars', 'dollars', update);
  bindSegmented('toggle-plan', 'plan', update);

  document.getElementById('add-account').addEventListener('click', () => {
    state.accounts.push({ id: nextId++, name: 'New account', type: 'roth', balance: 0, annualContribution: 0 });
    markEdited(); update(); renderAccounts();
    const rows = document.querySelectorAll('#accounts-list .acct-name');
    rows[rows.length - 1]?.focus();
  });

  document.getElementById('export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: 'retirement-data.json' });
    link.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('import-json').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    file.text().then((text) => {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.accounts)) throw new Error('bad format');
      state = { ...structuredClone(SAMPLE_STATE), ...parsed, sample: false };
      nextId = Math.max(0, ...state.accounts.map((x) => x.id)) + 1;
      saveState();
      location.reload();
    }).catch(() => alert('That file is not a retirement-data.json export from this app.'));
  });

  document.getElementById('reset-data').addEventListener('click', () => {
    if (!confirm('Clear all saved data and restore the sample?')) return;
    localStorage.removeItem(STORE_KEY);
    location.reload();
  });

  document.getElementById('sync-connect').addEventListener('click', connectSimplefin);
  document.getElementById('sync-token').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connectSimplefin();
  });
  document.getElementById('gh-connect').addEventListener('click', connectGithub);
  document.getElementById('gh-pat').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connectGithub();
  });
  document.getElementById('sync-refresh').addEventListener('click', refreshBalances);
  document.getElementById('sync-disconnect').addEventListener('click', () => {
    if (!confirm('Remove the sync connection from this browser? Synced accounts stay; balances just stop updating.')) return;
    state.simplefin = { accessUrl: '', lastSync: null };
    state.ghsync = { repo: '', pat: '' };
    saveState(); renderSync();
    setSyncStatus('Disconnected.');
  });
  renderSync();
  // When connected, balances refresh themselves on open (throttled to hourly —
  // the bank data itself updates about daily); the button stays for on-demand.
  if (syncSource() &&
      (!state.simplefin.lastSync || Date.now() - state.simplefin.lastSync > 3600e3)) {
    refreshBalances();
  }

  const themeBtn = document.getElementById('theme-toggle');
  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'light' : 'dark';
  });

  renderAccounts();
  update();
}

init();
