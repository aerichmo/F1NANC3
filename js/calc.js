// calc.js — pure retirement math. No DOM, no I/O; runs in browser and Node.
// All tax math is computed in today's dollars (federal brackets are inflation-
// indexed, so applying today's brackets to real amounts is the consistent choice).

export const BUCKETS = ['roth', 'trad', 'taxable', 'cash', 'hsa'];

export const BUCKET_META = {
  roth:    { label: 'Roth (tax-free)' },
  trad:    { label: 'Pre-tax (Traditional)' },
  taxable: { label: 'Taxable brokerage' },
  cash:    { label: 'Cash / savings' },
  hsa:     { label: 'HSA (tax-free)' },
};

// 2026 federal parameters (Rev. Proc. 2025-32). Brackets are [floor, rate];
// LTCG floors stack on top of ordinary taxable income.
export const FED_TAX = {
  single: {
    std: 16100,
    brackets: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24],
               [201775, 0.32], [256225, 0.35], [640600, 0.37]],
    ltcg: [[0, 0], [49450, 0.15], [545500, 0.20]],
  },
  married: {
    std: 32200,
    brackets: [[0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24],
               [403550, 0.32], [512450, 0.35], [768700, 0.37]],
    ltcg: [[0, 0], [98900, 0.15], [613700, 0.20]],
  },
};

export const DEFAULT_ASSUMPTIONS = {
  currentAge: 35,
  retireAge: 65,
  endAge: 95,            // plan money to last through this age
  preRetReturn: 0.07,    // nominal annual return while accumulating
  postRetReturn: 0.05,   // nominal annual return in retirement
  inflation: 0.025,
  contribGrowth: 0.02,   // annual growth of contributions (nominal)
  withdrawalRate: 0.04,  // for the percent-of-balance plan
  filingStatus: 'single',
  stateTaxRate: 0,       // flat rate on ordinary income + realized gains
  effTaxOverride: null,  // if set (0..1), replaces bracket math on pre-tax withdrawals
};

function progressiveTax(taxableIncome, brackets) {
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [floor, rate] = brackets[i];
    const ceil = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (taxableIncome <= floor) break;
    tax += (Math.min(taxableIncome, ceil) - floor) * rate;
  }
  return tax;
}

// Long-term gains occupy [ordTI, ordTI + gains] on the stacking axis.
function ltcgTax(gains, ordTI, ltcgBrackets) {
  let tax = 0;
  const lo = ordTI, hi = ordTI + gains;
  for (let i = 0; i < ltcgBrackets.length; i++) {
    const [floor, rate] = ltcgBrackets[i];
    const ceil = i + 1 < ltcgBrackets.length ? ltcgBrackets[i + 1][0] : Infinity;
    const overlap = Math.min(hi, ceil) - Math.max(lo, floor);
    if (overlap > 0) tax += overlap * rate;
  }
  return tax;
}

// Tax on one retirement year's withdrawals, all in today's dollars.
// slices: {trad, taxableGross}; gainFrac: share of the taxable slice that is gain.
export function yearlyTax({ trad, taxableGross, gainFrac }, a) {
  const fed = FED_TAX[a.filingStatus] || FED_TAX.single;
  const ordTI = Math.max(0, trad - fed.std);
  const fedOrd = a.effTaxOverride != null
    ? trad * a.effTaxOverride
    : progressiveTax(ordTI, fed.brackets);
  const gains = taxableGross * gainFrac;
  const fedGains = ltcgTax(gains, ordTI, fed.ltcg);
  const state = (a.stateTaxRate || 0) * (trad + gains);
  return fedOrd + fedGains + state;
}

// --- Accumulation: nominal year-by-year sim from currentAge to retireAge. ---
// Contribution timing: balance grows for the year, then the contribution lands.
export function accumulate(accounts, a) {
  const bal = { roth: 0, trad: 0, taxable: 0, cash: 0, hsa: 0 };
  const contrib = { roth: 0, trad: 0, taxable: 0, cash: 0, hsa: 0 };
  let taxableBasis = 0;
  for (const acct of accounts) {
    const b = BUCKETS.includes(acct.type) ? acct.type : 'taxable';
    bal[b] += acct.balance || 0;
    contrib[b] += acct.annualContribution || 0;
  }
  taxableBasis = bal.taxable; // assume today's taxable balance is all basis

  const years = [{ age: a.currentAge, buckets: { ...bal }, taxableBasis }];
  const nYears = Math.max(0, a.retireAge - a.currentAge);
  for (let k = 0; k < nYears; k++) {
    const growth = Math.pow(1 + a.contribGrowth, k);
    for (const b of BUCKETS) {
      bal[b] = bal[b] * (1 + a.preRetReturn) + contrib[b] * growth;
    }
    taxableBasis += contrib.taxable * growth;
    years.push({ age: a.currentAge + k + 1, buckets: { ...bal }, taxableBasis });
  }
  return years;
}

export function realRate(nominal, inflation) {
  return (1 + nominal) / (1 + inflation) - 1;
}

// Level end-of-period payment that empties balance B over n periods at rate r.
export function annuityPayment(B, r, n) {
  if (n <= 0) return B;
  if (Math.abs(r) < 1e-9) return B / n;
  return B * r / (1 - Math.pow(1 + r, -n));
}

// --- Drawdown: simulated in real (today's) dollars with pro-rata withdrawals,
// so bucket weights — and therefore the tax character of each withdrawal —
// stay constant. plan: 'amortize' (spend to zero by endAge) or 'percent'
// (withdraw withdrawalRate of the balance each year).
export function drawdown(atRet, a, plan) {
  const totalStart = BUCKETS.reduce((s, b) => s + atRet.buckets[b], 0);
  const weights = {};
  for (const b of BUCKETS) weights[b] = totalStart > 0 ? atRet.buckets[b] / totalStart : 0;
  const gainFrac = atRet.buckets.taxable > 0
    ? Math.max(0, (atRet.buckets.taxable - atRet.taxableBasis) / atRet.buckets.taxable)
    : 0;

  const r = realRate(a.postRetReturn, a.inflation);
  const n = Math.max(1, a.endAge - a.retireAge);
  const years = [];
  let total = totalStart;
  const amortizeGross = annuityPayment(totalStart, r, n);

  for (let k = 1; k <= n; k++) {
    const gross = plan === 'percent' ? total * a.withdrawalRate
                                     : Math.min(amortizeGross, total * (1 + r));
    const tax = yearlyTax({
      trad: gross * weights.trad,
      taxableGross: gross * weights.taxable,
      gainFrac,
    }, a);
    total = Math.max(0, total * (1 + r) - gross);
    const buckets = {};
    for (const b of BUCKETS) buckets[b] = total * weights[b];
    years.push({
      age: a.retireAge + k, buckets, gross, tax,
      spend: gross - tax,
    });
  }
  return { years, weights, gainFrac, grossAnnual: years[0]?.gross ?? 0 };
}

// --- Full projection: everything the UI needs. ---
export function project(accounts, a, plan = 'amortize') {
  const accYears = accumulate(accounts, a);
  const atRet = accYears[accYears.length - 1];

  const deflate = (age) => Math.pow(1 + a.inflation, age - a.currentAge);
  // drawdown() works in today's dollars, so hand it the deflated balances.
  // gainFrac is a ratio, so deflating balance and basis together preserves it.
  const deflRet = deflate(a.retireAge);
  const atRetReal = {
    buckets: mapBuckets(atRet.buckets, (v) => v / deflRet),
    taxableBasis: atRet.taxableBasis / deflRet,
  };
  const dd = drawdown(atRetReal, a, plan);
  // Accumulation is simulated nominal; drawdown is simulated real. Emit both.
  const series = accYears.map((y) => ({
    age: y.age, phase: 'accumulate',
    nominal: { ...y.buckets },
    real: mapBuckets(y.buckets, (v) => v / deflate(y.age)),
  })).concat(dd.years.map((y) => ({
    age: y.age, phase: 'drawdown',
    nominal: mapBuckets(y.buckets, (v) => v * deflate(y.age)),
    real: { ...y.buckets },
    grossReal: y.gross, taxReal: y.tax, spendReal: y.spend,
  })));

  const totalAtRetNominal = BUCKETS.reduce((s, b) => s + atRet.buckets[b], 0);
  const totalAtRetReal = totalAtRetNominal / deflate(a.retireAge);

  // Effective tax rate under the amortize plan is constant across years
  // (constant weights + constant real withdrawal), so it doubles as the
  // discount for the "after-tax value" headline.
  const amort = plan === 'amortize' ? dd : drawdown(atRetReal, a, 'amortize');
  const y1 = amort.years[0] || { gross: 0, tax: 0, spend: 0 };
  const effTaxRate = y1.gross > 0 ? y1.tax / y1.gross : 0;

  const pct = plan === 'percent' ? dd : drawdown(atRetReal, a, 'percent');
  const p1 = pct.years[0] || { gross: 0, tax: 0, spend: 0 };

  const realBuckets = mapBuckets(atRet.buckets, (v) => v / deflate(a.retireAge));
  const taxFreeReal = realBuckets.roth + realBuckets.hsa;

  return {
    series, atRet, weights: dd.weights, gainFrac: dd.gainFrac,
    totals: {
      atRetirementNominal: totalAtRetNominal,
      atRetirementReal: totalAtRetReal,
      afterTaxReal: totalAtRetReal * (1 - effTaxRate),
      afterTaxNominal: totalAtRetNominal * (1 - effTaxRate),
      taxFreeShare: totalAtRetReal > 0 ? taxFreeReal / totalAtRetReal : 0,
    },
    spending: {
      // spend-to-zero plan, constant in today's dollars
      amortizeGrossReal: y1.gross, amortizeTaxReal: y1.tax, amortizeSpendReal: y1.spend,
      // percent-of-balance plan, first-year figures in today's dollars
      percentGrossReal: p1.gross, percentTaxReal: p1.tax, percentSpendReal: p1.spend,
      effTaxRate,
      retirementYears: Math.max(1, a.endAge - a.retireAge),
    },
  };
}

function mapBuckets(buckets, fn) {
  const out = {};
  for (const b of BUCKETS) out[b] = fn(buckets[b] || 0);
  return out;
}

// Parse a percent-unit string ("7", "7%", "0.5") into a rate fraction (0.07, 0.005).
export function parseRate(value, fallback = 0) {
  const n = parseFloat(String(value).replace(/[%,\s]/g, ''));
  if (!isFinite(n)) return fallback;
  return n / 100;
}
