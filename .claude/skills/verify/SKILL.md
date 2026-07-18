---
name: verify
description: Verify the retirement calculator web app end-to-end (serve statically, drive with Playwright)
---

# Verify: retirement calculator

Pure static ES-module app — no build step.

## Launch

From the repo root:

```bash
python3 -m http.server 8420 --bind 127.0.0.1 &
```

## Unit tests (engine only)

```bash
node --test test/calc.test.mjs
```

## Drive the surface

Playwright with the pre-installed browser (do NOT `playwright install`):

```js
import { chromium } from 'playwright';  // npm i playwright in scratchpad
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
```

Flows worth driving: initial sample render (hero + 4 stat tiles non-empty,
legend has ≥4 items), chart hover → `.chart-tooltip` visible, both segmented
toggles (`#toggle-dollars`, `#toggle-plan`), edit a balance → `#sample-note`
hides and value persists across reload (localStorage key `m3ta-retirement-v1`),
add/remove account rows, open the year-by-year `<details>` (61 rows for ages
35–95), `#reset-data` (accept the confirm dialog), export download event,
`#theme-toggle` for a dark screenshot.

Gotchas: check `page.on('console'|'pageerror')` for errors — the app must log
none. The last table row should be ~$0 total under the spend-to-zero plan.
