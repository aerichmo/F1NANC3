# Retirement Wealth Calculator

A dependency-free web app that takes your current accounts, projects them to
retirement, splits the result by tax treatment (Roth vs pre-tax vs taxable),
and shows what you can spend per year after taxes.

Everything runs in the browser. Your data lives in `localStorage` — nothing is
uploaded anywhere.

## Run it

Any static file server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Or just open `index.html` directly — no build step, no dependencies.)

## What it shows

- **Spend per year (hero number)** — after-tax spending in today's dollars,
  under two plans: a level real annuity that spends the portfolio to zero by
  your plan-through age, or a classic percent-of-balance ("4% rule") plan.
- **Total at retirement** — in future dollars and today's dollars.
- **After-tax value** — what the portfolio is really worth once pre-tax money
  is discounted at your projected retirement tax rate. If most of your money
  is Roth, this stays close to the gross number — that's the point of seeing it.
- **Tax-free share** — how much of your retirement balance is Roth/HSA.
- **Projection chart + year-by-year table** — balances by tax bucket from now
  through end of plan, with the drawdown path included.

## How the math works

- Accounts compound yearly at the pre-retirement return; contributions land at
  year-end and can grow annually. Contributions stop at retirement.
- Retirement withdrawals are pro-rata across buckets, so each year's tax mix
  matches your mix at retirement.
- Taxes use **2026 federal brackets and standard deductions** (Rev. Proc.
  2025-32), applied in today's dollars (brackets are inflation-indexed, so this
  is the consistent frame). Pre-tax withdrawals are ordinary income;
  taxable-account gains are taxed as long-term capital gains **stacked on top
  of ordinary income** (so the 0% LTCG bracket is modeled); Roth and HSA
  withdrawals are tax-free. Optional flat state tax, and an optional override
  for the effective rate on pre-tax withdrawals.
- Not modeled: Social Security, RMDs, IRMAA, dividend drag, state brackets,
  market volatility. Single deterministic path. Educational estimate — not
  financial or tax advice.

The engine is pure functions in [`js/calc.js`](js/calc.js), tested with
`node --test`:

```bash
node --test test/calc.test.mjs
```

## Connecting real account data

**Bank of America does not offer a public API for personal accounts.** Their
developer platform (CashPro) is for corporate/treasury clients only. Consumer
apps that show BofA / Merrill balances get them through **aggregators**:

| Option | What it is | Fit |
|---|---|---|
| [Plaid](https://plaid.com) | The standard aggregator; BofA and Merrill connect via OAuth. Investment-account support included. | Best docs; requires a (paid) developer account and a small backend to hold API secrets. |
| MX / Finicity (Mastercard) | Plaid competitors used by many banks. | Similar model, enterprise-leaning. |
| [SimpleFIN Bridge](https://beta-bridge.simplefin.org) | A ~$1.50/mo consumer-friendly bridge over an aggregator, designed for personal projects. | Easiest way for an individual to pull their own balances programmatically. |
| Manual + JSON import | What this app does today. | Zero cost, zero credentials shared. |

The app is already structured for a feed: an importer just needs to produce the
same JSON the **Export** button writes —

```json
{
  "v": 1,
  "accounts": [
    { "id": 1, "name": "Roth 401(k)", "type": "roth", "balance": 150000, "annualContribution": 20000 }
  ],
  "assumptions": { "currentAge": 35, "retireAge": 65 }
}
```

`type` is one of `roth` · `trad` · `taxable` · `cash` · `hsa`. A small script
that reads SimpleFIN/Plaid balances, maps each account to a bucket, and writes
this file gives you one-click refresh via **Import** — no changes to the app
needed.
