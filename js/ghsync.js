// ghsync.js — cloud sync via a private GitHub repo. A scheduled Action in that
// repo (see the f1nanc3-data repo) pulls SimpleFIN daily and commits
// balances.json; this module fetches it through the GitHub contents API. The
// browser then holds only a fine-grained PAT (contents:read on that one repo) —
// the SimpleFIN credential itself stays in GitHub Actions secrets.

export function parseRepoPath(s) {
  const m = String(s).trim().replace(/^https:\/\/github\.com\//i, '').match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) throw new Error('Repo must look like "owner/name" (e.g. alice/f1nanc3-data).');
  return { owner: m[1], name: m[2] };
}

export function balancesUrl(repoPath) {
  const { owner, name } = parseRepoPath(repoPath);
  return `https://api.github.com/repos/${owner}/${name}/contents/balances.json`;
}

// Normalize the committed file into what the app merges. Accepts the shape the
// sync workflow writes ({fetched_at, accounts, errors}) or a raw SimpleFIN
// response ({accounts, errors}).
export function normalizeBalancesFile(data) {
  if (!data || !Array.isArray(data.accounts)) {
    throw new Error('balances.json has an unexpected format — re-run the Sync workflow.');
  }
  return {
    accounts: data.accounts,
    errors: Array.isArray(data.errors) ? data.errors : [],
    fetchedAt: data.fetched_at || null,
  };
}

export async function fetchGithubBalances(repoPath, pat) {
  const res = await fetch(balancesUrl(repoPath), {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 401) throw new Error('GitHub rejected the token (401). Generate a new fine-grained PAT with read access to the data repo.');
  if (res.status === 403) throw new Error('GitHub refused access (403). Check the PAT has Contents: Read on the data repo.');
  if (res.status === 404) {
    const err = new Error('No balances.json in the repo yet — run the "Sync balances" workflow there once (Actions tab), then refresh.');
    err.missingFile = true;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
  return normalizeBalancesFile(await res.json());
}
