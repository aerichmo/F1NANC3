// chart.js — dependency-free stacked-area SVG chart with crosshair tooltip,
// keyboard navigation, and a retirement marker. Colors come from CSS custom
// properties so light/dark swap without re-theming the chart code.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function cssVar(container, name) {
  return getComputedStyle(container).getPropertyValue(name).trim();
}

// Round the axis ceiling up to a clean 1/2/2.5/5 × 10^k step grid.
function niceScale(maxValue, tickCount = 4) {
  if (maxValue <= 0) return { max: 1, ticks: [0, 0.5, 1] };
  const rough = maxValue / tickCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
  const max = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(v);
  return { max, ticks };
}

export function fmtMoneyCompact(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${trim3(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trim3(abs / 1e3)}K`;
  return `${sign}$${Math.round(abs)}`;
}
function trim3(n) {
  return String(Number(n.toPrecision(3)));
}

export function fmtMoneyFull(v) {
  return (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
}

// data: { ages: number[], series: [{key, label, colorVar, values: number[]}],
//         retireAge, extraRows?: (i) => [{label, value}], yearForAge?: (age)=>year }
export function createChart(container, getData) {
  container.classList.add('chart-root');
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.setAttribute('role', 'status');
  tooltip.hidden = true;

  let state = { hoverIndex: -1, width: 0 };
  let current = null;

  function render() {
    const data = getData();
    current = data;
    const width = container.clientWidth || 640;
    state.width = width;
    const height = Math.max(240, Math.min(360, Math.round(width * 0.48)));
    const pad = { top: 34, right: 14, bottom: 26, left: 8 };

    container.textContent = '';
    container.appendChild(tooltip);

    const surface = cssVar(container, '--surface-1') || '#fcfcfb';
    const grid = cssVar(container, '--grid') || '#e1e0d9';
    const axis = cssVar(container, '--axis') || '#c3c2b7';
    const muted = cssVar(container, '--text-muted') || '#898781';
    const ink = cssVar(container, '--text-primary') || '#0b0b0b';

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%', height,
      role: 'img',
      'aria-label': data.ariaLabel || 'Projected balance by tax bucket over time',
    }, container);
    svg.tabIndex = 0;
    svg.classList.add('chart-svg');

    const { ages, series } = data;
    const n = ages.length;
    if (!n || !series.length) {
      const t = el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: muted, 'font-size': 13 }, svg);
      t.textContent = 'Add an account to see your projection';
      return;
    }

    // Stack: cumulative sums per index, in series order (bottom → top).
    const totals = ages.map((_, i) => series.reduce((s, sr) => s + sr.values[i], 0));
    const { max: yMax, ticks } = niceScale(Math.max(...totals));

    // Measure the widest tick label so the left pad fits real text.
    const tickLabels = ticks.map(fmtMoneyCompact);
    const approxCh = Math.max(...tickLabels.map((t) => t.length));
    pad.left = 10 + approxCh * 7.2;

    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = (i) => pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => pad.top + plotH - (v / yMax) * plotH;

    // Gridlines (hairline, solid) + y tick labels.
    for (let t = 0; t < ticks.length; t++) {
      const gy = y(ticks[t]);
      el('line', { x1: pad.left, x2: width - pad.right, y1: gy, y2: gy, stroke: t === 0 ? axis : grid, 'stroke-width': 1 }, svg);
      if (ticks[t] > 0) {
        const label = el('text', {
          x: pad.left - 6, y: gy + 3.5, 'text-anchor': 'end',
          fill: muted, 'font-size': 11, class: 'tnum',
        }, svg);
        label.textContent = tickLabels[t];
      }
    }

    // X ticks: multiples of 5 within the age range.
    const first = ages[0], last = ages[n - 1];
    for (let age = Math.ceil(first / 5) * 5; age <= last; age += 5) {
      const i = age - first;
      const label = el('text', {
        x: x(i), y: height - 8, 'text-anchor': 'middle',
        fill: muted, 'font-size': 11, class: 'tnum',
      }, svg);
      label.textContent = age;
    }

    // Stacked bands (solid fills, like stacked-bar segments).
    const cum = ages.map(() => 0);
    const boundaries = [];
    for (const sr of series) {
      const lower = cum.slice();
      for (let i = 0; i < n; i++) cum[i] += sr.values[i];
      let d = `M ${x(0)} ${y(cum[0])}`;
      for (let i = 1; i < n; i++) d += ` L ${x(i)} ${y(cum[i])}`;
      for (let i = n - 1; i >= 0; i--) d += ` L ${x(i)} ${y(lower[i])}`;
      d += ' Z';
      el('path', { d, fill: cssVar(container, sr.colorVar) || '#888', stroke: 'none' }, svg);
      boundaries.push(cum.slice());
    }
    // 2px surface-color gap between adjacent bands (not on the outer top edge).
    for (let bIdx = 0; bIdx < boundaries.length - 1; bIdx++) {
      const cumB = boundaries[bIdx];
      let d = `M ${x(0)} ${y(cumB[0])}`;
      for (let i = 1; i < n; i++) d += ` L ${x(i)} ${y(cumB[i])}`;
      el('path', { d, fill: 'none', stroke: surface, 'stroke-width': 2 }, svg);
    }

    // Retirement marker: solid hairline + label + selective direct label of the peak.
    const ri = data.retireAge - first;
    if (ri > 0 && ri < n - 1) {
      const rx = x(ri);
      el('line', { x1: rx, x2: rx, y1: pad.top - 4, y2: pad.top + plotH, stroke: axis, 'stroke-width': 1 }, svg);
      const cap = el('text', {
        x: rx, y: pad.top - 22, 'text-anchor': 'middle', fill: muted, 'font-size': 11,
      }, svg);
      cap.textContent = `Retire at ${data.retireAge}`;
      const peak = el('text', {
        x: rx, y: pad.top - 8, 'text-anchor': 'middle', fill: ink,
        'font-size': 12.5, 'font-weight': 600,
      }, svg);
      peak.textContent = fmtMoneyCompact(totals[ri]);
    }

    // Crosshair + hover layer over the whole plot.
    const cross = el('line', {
      x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH,
      stroke: axis, 'stroke-width': 1, visibility: 'hidden',
    }, svg);
    const hit = el('rect', {
      x: pad.left, y: pad.top, width: plotW, height: plotH,
      fill: 'transparent',
    }, svg);
    hit.style.cursor = 'crosshair';

    function showIndex(i) {
      state.hoverIndex = i;
      if (i < 0) { cross.setAttribute('visibility', 'hidden'); tooltip.hidden = true; return; }
      const cx = x(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      fillTooltip(i);
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth;
      const flip = cx + 12 + tw > width;
      tooltip.style.left = `${flip ? cx - tw - 12 : cx + 12}px`;
      tooltip.style.top = `${pad.top + 2}px`;
    }

    function fillTooltip(i) {
      tooltip.textContent = '';
      const head = document.createElement('div');
      head.className = 'tt-head';
      const yr = data.yearForAge ? ` · ${data.yearForAge(ages[i])}` : '';
      head.textContent = `Age ${ages[i]}${yr}`;
      tooltip.appendChild(head);

      const addRow = (label, value, colorVar, strong) => {
        const row = document.createElement('div');
        row.className = 'tt-row' + (strong ? ' tt-strong' : '');
        const key = document.createElement('span');
        key.className = 'tt-key';
        if (colorVar) key.style.background = cssVar(container, colorVar);
        else key.style.visibility = 'hidden';
        const val = document.createElement('span');
        val.className = 'tt-val';
        val.textContent = value;
        const lab = document.createElement('span');
        lab.className = 'tt-label';
        lab.textContent = label;
        row.append(key, val, lab);
        tooltip.appendChild(row);
      };

      addRow('Total', fmtMoneyFull(totals[i]), null, true);
      for (let s = series.length - 1; s >= 0; s--) {
        addRow(series[s].label, fmtMoneyFull(series[s].values[i]), series[s].colorVar, false);
      }
      if (data.extraRows) {
        for (const r of data.extraRows(i)) addRow(r.label, r.value, null, false);
      }
    }

    hit.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * width;
      const i = Math.round(((px - pad.left) / plotW) * (n - 1));
      showIndex(Math.max(0, Math.min(n - 1, i)));
    });
    hit.addEventListener('pointerleave', () => showIndex(-1));

    svg.addEventListener('keydown', (ev) => {
      const cur = state.hoverIndex < 0 ? (ri > 0 ? ri : 0) : state.hoverIndex;
      if (ev.key === 'ArrowRight') { showIndex(Math.min(n - 1, cur + 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { showIndex(Math.max(0, cur - 1)); ev.preventDefault(); }
      else if (ev.key === 'Home') { showIndex(0); ev.preventDefault(); }
      else if (ev.key === 'End') { showIndex(n - 1); ev.preventDefault(); }
      else if (ev.key === 'Escape') showIndex(-1);
    });
    svg.addEventListener('focus', () => { if (state.hoverIndex < 0) showIndex(ri > 0 ? ri : 0); });
    svg.addEventListener('blur', () => showIndex(-1));
  }

  const ro = new ResizeObserver(() => {
    if (container.clientWidth && Math.abs(container.clientWidth - state.width) > 1) render();
  });
  ro.observe(container);

  // Re-render when the theme flips so CSS-var colors are re-read.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', render);
  new MutationObserver(render).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });

  return { render };
}
