import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulate, annuityPayment, drawdown, project, realRate, yearlyTax,
  parseRate, DEFAULT_ASSUMPTIONS, BUCKETS,
} from '../js/calc.js';

const A = { ...DEFAULT_ASSUMPTIONS };

function approx(actual, expected, tol = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
    `expected ${actual} ≈ ${expected}`);
}

test('accumulate compounds a single balance with no contributions', () => {
  const a = { ...A, currentAge: 40, retireAge: 45, preRetReturn: 0.10, contribGrowth: 0 };
  const years = accumulate([{ type: 'roth', balance: 1000, annualContribution: 0 }], a);
  assert.equal(years.length, 6);
  approx(years[5].buckets.roth, 1000 * Math.pow(1.10, 5));
});

test('accumulate adds end-of-year contributions with growth', () => {
  const a = { ...A, currentAge: 40, retireAge: 42, preRetReturn: 0, contribGrowth: 0.10 };
  const years = accumulate([{ type: 'trad', balance: 0, annualContribution: 100 }], a);
  // year1: 100, year2: 100 + 110
  approx(years[2].buckets.trad, 210);
});

test('taxable basis tracks initial balance plus contributions', () => {
  const a = { ...A, currentAge: 40, retireAge: 41, preRetReturn: 0.5, contribGrowth: 0 };
  const years = accumulate([{ type: 'taxable', balance: 1000, annualContribution: 200 }], a);
  const atRet = years[years.length - 1];
  approx(atRet.buckets.taxable, 1000 * 1.5 + 200);
  approx(atRet.taxableBasis, 1200);
});

test('annuityPayment matches closed form and zero-rate case', () => {
  approx(annuityPayment(1000, 0, 10), 100);
  // 100k at 5% over 30y ≈ 6505.14
  approx(annuityPayment(100000, 0.05, 30), 6505.14, 1e-4);
});

test('amortize drawdown empties the portfolio by endAge', () => {
  const a = { ...A, currentAge: 64, retireAge: 65, endAge: 95 };
  const atRet = {
    buckets: { roth: 500000, trad: 300000, taxable: 100000, cash: 50000, hsa: 25000 },
    taxableBasis: 60000,
  };
  const dd = drawdown(atRet, a, 'amortize');
  assert.equal(dd.years.length, 30);
  const last = dd.years[dd.years.length - 1];
  const total = BUCKETS.reduce((s, b) => s + last.buckets[b], 0);
  approx(total, 0, 1e-6);
});

test('pro-rata drawdown keeps bucket weights constant', () => {
  const a = { ...A };
  const atRet = { buckets: { roth: 600000, trad: 300000, taxable: 100000, cash: 0, hsa: 0 }, taxableBasis: 50000 };
  const dd = drawdown(atRet, a, 'amortize');
  const mid = dd.years[10];
  const total = BUCKETS.reduce((s, b) => s + mid.buckets[b], 0);
  approx(mid.buckets.roth / total, 0.6);
  approx(mid.buckets.trad / total, 0.3);
});

test('yearlyTax: all-Roth withdrawal is untaxed', () => {
  const tax = yearlyTax({ trad: 0, taxableGross: 0, gainFrac: 0 }, A);
  assert.equal(tax, 0);
});

test('yearlyTax: ordinary brackets with standard deduction (single, 2026)', () => {
  // $40,000 traditional withdrawal → TI 23,900 → 10% * 12,400 + 12% * 11,500 = 2,620
  const tax = yearlyTax({ trad: 40000, taxableGross: 0, gainFrac: 0 }, { ...A, filingStatus: 'single' });
  approx(tax, 2620);
});

test('yearlyTax: LTCG inside the 0% bracket is untaxed, stacking works', () => {
  // No ordinary income; 40k of pure gain sits fully under the 49,450 0% floor.
  const t0 = yearlyTax({ trad: 0, taxableGross: 40000, gainFrac: 1 }, { ...A, filingStatus: 'single' });
  assert.equal(t0, 0);
  // 60k gain: first 49,450 at 0%, remaining 10,550 at 15% = 1,582.50
  const t1 = yearlyTax({ trad: 0, taxableGross: 60000, gainFrac: 1 }, { ...A, filingStatus: 'single' });
  approx(t1, 1582.5);
  // Ordinary income pushes gains up the stack: TI 49,450 → all 10k of gain at 15%.
  const t2 = yearlyTax({ trad: 49450 + 16100, taxableGross: 10000, gainFrac: 1 }, { ...A, filingStatus: 'single' });
  const ordOnly = yearlyTax({ trad: 49450 + 16100, taxableGross: 0, gainFrac: 0 }, { ...A, filingStatus: 'single' });
  approx(t2 - ordOnly, 1500);
});

test('yearlyTax: effective-rate override replaces bracket math on trad only', () => {
  const tax = yearlyTax({ trad: 50000, taxableGross: 0, gainFrac: 0 }, { ...A, effTaxOverride: 0.12 });
  approx(tax, 6000);
});

test('yearlyTax: state tax applies to trad and gains', () => {
  const tax = yearlyTax({ trad: 10000, taxableGross: 20000, gainFrac: 0.5 },
    { ...A, stateTaxRate: 0.05, effTaxOverride: 0 });
  approx(tax, 0.05 * (10000 + 10000));
});

test('project: real vs nominal agree at the retirement boundary', () => {
  const accounts = [{ type: 'roth', balance: 100000, annualContribution: 10000 }];
  const p = project(accounts, A);
  const retPoint = p.series.find((y) => y.age === A.retireAge);
  const deflator = Math.pow(1 + A.inflation, A.retireAge - A.currentAge);
  approx(retPoint.nominal.roth / deflator, retPoint.real.roth);
  approx(p.totals.atRetirementReal * deflator, p.totals.atRetirementNominal);
});

test('project: mostly-Roth portfolio has low effective tax rate', () => {
  const accounts = [
    { type: 'roth', balance: 400000, annualContribution: 20000 },
    { type: 'trad', balance: 40000, annualContribution: 0 },
  ];
  const p = project(accounts, A);
  assert.ok(p.spending.effTaxRate < 0.05, `effTaxRate ${p.spending.effTaxRate} should be small`);
  assert.ok(p.totals.afterTaxReal <= p.totals.atRetirementReal);
  assert.ok(p.spending.amortizeSpendReal > 0);
  // sanity: spending ≈ annuity on real balance minus tax
  const r = realRate(A.postRetReturn, A.inflation);
  const g = annuityPayment(p.totals.atRetirementReal, r, 30);
  approx(p.spending.amortizeGrossReal, g, 1e-6);
});

test('project: percent plan first-year gross is rate × balance', () => {
  const accounts = [{ type: 'roth', balance: 250000, annualContribution: 0 }];
  const p = project(accounts, A, 'percent');
  approx(p.spending.percentGrossReal, p.totals.atRetirementReal * A.withdrawalRate);
});

test('project: empty accounts produce zeros, not NaN', () => {
  const p = project([], A);
  assert.equal(p.totals.atRetirementNominal, 0);
  assert.equal(p.spending.amortizeSpendReal, 0);
  for (const y of p.series) for (const b of BUCKETS) {
    assert.ok(Number.isFinite(y.nominal[b]) && Number.isFinite(y.real[b]));
  }
});

test('project: already-retired (retireAge ≤ currentAge) still works', () => {
  const a = { ...A, currentAge: 70, retireAge: 70, endAge: 90 };
  const p = project([{ type: 'roth', balance: 500000, annualContribution: 0 }], a);
  approx(p.totals.atRetirementNominal, 500000);
  assert.equal(p.spending.retirementYears, 20);
});

test('parseRate treats input as percent units', () => {
  assert.equal(parseRate('7'), 0.07);
  assert.equal(parseRate('7%'), 0.07);
  assert.equal(parseRate('0.5'), 0.005);
  assert.equal(parseRate('garbage', 0.03), 0.03);
});
