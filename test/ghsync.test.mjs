import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoPath, balancesUrl, normalizeBalancesFile } from '../js/ghsync.js';

test('parseRepoPath accepts owner/name in common spellings', () => {
  assert.deepEqual(parseRepoPath('alice/f1nanc3-data'), { owner: 'alice', name: 'f1nanc3-data' });
  assert.deepEqual(parseRepoPath(' https://github.com/alice/f1nanc3-data '), { owner: 'alice', name: 'f1nanc3-data' });
  assert.deepEqual(parseRepoPath('alice/f1nanc3-data.git'), { owner: 'alice', name: 'f1nanc3-data' });
  assert.throws(() => parseRepoPath('just-a-name'));
  assert.throws(() => parseRepoPath('too/many/parts'));
});

test('balancesUrl targets the contents API', () => {
  assert.equal(balancesUrl('alice/f1nanc3-data'),
    'https://api.github.com/repos/alice/f1nanc3-data/contents/balances.json');
});

test('normalizeBalancesFile accepts workflow output and raw SimpleFIN shapes', () => {
  const wf = normalizeBalancesFile({
    fetched_at: '2026-07-20T11:23:00Z',
    accounts: [{ id: 'ACT-1', name: 'Roth IRA', balance: '5.00' }],
    errors: [],
  });
  assert.equal(wf.accounts.length, 1);
  assert.equal(wf.fetchedAt, '2026-07-20T11:23:00Z');

  const raw = normalizeBalancesFile({ accounts: [], errors: ['x'] });
  assert.equal(raw.fetchedAt, null);
  assert.deepEqual(raw.errors, ['x']);

  assert.throws(() => normalizeBalancesFile({ nope: true }));
  assert.throws(() => normalizeBalancesFile(null));
});
