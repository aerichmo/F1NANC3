// simplefin.js — SimpleFIN Bridge sync (https://www.simplefin.org/protocol.html).
// Pure helpers are exported for node tests; network I/O is confined to
// claimSetupToken/fetchSimplefinAccounts. The access URL is a read-only
// credential: it lives in localStorage with the rest of the app state and is
// sent nowhere except beta-bridge.simplefin.org.

export function looksLikeAccessUrl(s) {
  return /^https?:\/\//i.test(s.trim());
}

export function decodeSetupToken(token) {
  let url;
  try { url = atob(token.trim()); } catch { throw new Error('That is not a valid setup token (base64).'); }
  if (!/^https:\/\//.test(url)) throw new Error('Setup token did not decode to an https claim URL.');
  return url;
}

export function splitAccessUrl(accessUrl) {
  const u = new URL(accessUrl.trim());
  const auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  if (auth === ':') throw new Error('Access URL is missing its embedded credentials.');
  u.username = ''; u.password = '';
  return { base: u.toString().replace(/\/$/, ''), auth };
}

// Best-effort bucket guess from the institution + account name; the user can
// always change the type afterward and it sticks (matching is by sfId).
export function guessType(name) {
  const n = String(name).toLowerCase();
  if (/\broth\b/.test(n)) return 'roth';
  if (/\bhsa\b|health sav/.test(n)) return 'hsa';
  if (/401|403|\bira\b|trad|sep\b|pension|retire/.test(n)) return 'trad';
  if (/check|saving|\bsav\b|cash|\bcd\b|money market|deposit|bank|cma/.test(n)) return 'cash';
  return 'taxable';
}

// Merge SimpleFIN accounts into the app's account list. Existing rows matched
// by sfId keep their name, type, and contribution — only the balance updates.
export function mergeSimplefinAccounts(existing, sfAccounts, nextIdFn) {
  const accounts = existing.map((a) => ({ ...a }));
  let added = 0, updated = 0;
  for (const sf of sfAccounts) {
    const balance = Math.max(0, parseFloat(sf.balance) || 0);
    const hit = accounts.find((a) => a.sfId === sf.id);
    if (hit) {
      hit.balance = balance;
      updated++;
    } else {
      const org = sf.org?.name || sf.org?.domain || '';
      const name = [org, sf.name].filter(Boolean).join(' — ') || 'Synced account';
      accounts.push({
        id: nextIdFn(), name, type: guessType(`${org} ${sf.name || ''}`),
        balance, annualContribution: 0, sfId: sf.id,
      });
      added++;
    }
  }
  return { accounts, added, updated };
}

export async function claimSetupToken(token) {
  const claimUrl = decodeSetupToken(token);
  let res;
  try {
    res = await fetch(claimUrl, { method: 'POST' });
  } catch {
    throw new Error('The claim request was blocked (likely CORS). Claim the token elsewhere ' +
      '(e.g. `curl -X POST <decoded url>`) and paste the resulting access URL here instead.');
  }
  if (!res.ok) {
    throw new Error(`Claim failed (HTTP ${res.status}). Setup tokens are single-use — ` +
      'generate a fresh one at beta-bridge.simplefin.org and try again.');
  }
  const accessUrl = (await res.text()).trim();
  splitAccessUrl(accessUrl); // throws if malformed
  return accessUrl;
}

export async function fetchSimplefinAccounts(accessUrl) {
  const { base, auth } = splitAccessUrl(accessUrl);
  const res = await fetch(`${base}/accounts?balances-only=1`, {
    headers: { Authorization: 'Basic ' + btoa(auth) },
  });
  if (!res.ok) throw new Error(`SimpleFIN returned HTTP ${res.status}.`);
  const data = await res.json();
  return { accounts: data.accounts || [], errors: data.errors || [] };
}
