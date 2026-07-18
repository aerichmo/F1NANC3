import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeAccessUrl, decodeSetupToken, splitAccessUrl, guessType,
  mergeSimplefinAccounts,
} from '../js/simplefin.js';

test('looksLikeAccessUrl distinguishes URLs from tokens', () => {
  assert.ok(looksLikeAccessUrl('https://user:pass@bridge.example/simplefin'));
  assert.ok(!looksLikeAccessUrl('aHR0cHM6Ly9leGFtcGxl'));
});

test('decodeSetupToken decodes base64 claim URLs and rejects junk', () => {
  const url = 'https://beta-bridge.simplefin.org/simplefin/claim/ABC123';
  assert.equal(decodeSetupToken(btoa(url)), url);
  assert.throws(() => decodeSetupToken('!!!not-base64!!!'));
  assert.throws(() => decodeSetupToken(btoa('http://insecure.example/claim/x')));
});

test('splitAccessUrl separates credentials from the base URL', () => {
  const { base, auth } = splitAccessUrl('https://alice:s3cret@bridge.example/simplefin');
  assert.equal(base, 'https://bridge.example/simplefin');
  assert.equal(auth, 'alice:s3cret');
  assert.throws(() => splitAccessUrl('https://bridge.example/simplefin'));
});

test('guessType maps account names to tax buckets', () => {
  assert.equal(guessType('Roth 401(k)'), 'roth');
  assert.equal(guessType('Merrill Roth IRA'), 'roth');
  assert.equal(guessType('Traditional IRA'), 'trad');
  assert.equal(guessType('Acme 401k Plan'), 'trad');
  assert.equal(guessType('Health Savings Account HSA'), 'hsa');
  assert.equal(guessType('Advantage Banking Checking'), 'cash');
  assert.equal(guessType('Merrill CMA'), 'cash');
  assert.equal(guessType('Individual Brokerage'), 'taxable');
});

test('mergeSimplefinAccounts updates by sfId and preserves user edits', () => {
  const existing = [
    { id: 1, name: 'My Roth (renamed)', type: 'roth', balance: 100, annualContribution: 7000, sfId: 'sf-1' },
    { id: 2, name: 'Manual account', type: 'cash', balance: 50, annualContribution: 0 },
  ];
  const sf = [
    { id: 'sf-1', name: 'ROTH IRA', org: { name: 'Merrill' }, balance: '123.45' },
    { id: 'sf-2', name: 'Checking', org: { name: 'Bank of America' }, balance: '900.00' },
  ];
  let next = 10;
  const { accounts, added, updated } = mergeSimplefinAccounts(existing, sf, () => next++);
  assert.equal(updated, 1);
  assert.equal(added, 1);
  const roth = accounts.find((a) => a.sfId === 'sf-1');
  assert.equal(roth.balance, 123.45);
  assert.equal(roth.name, 'My Roth (renamed)');       // user's rename survives
  assert.equal(roth.annualContribution, 7000);         // user's contribution survives
  const checking = accounts.find((a) => a.sfId === 'sf-2');
  assert.equal(checking.name, 'Bank of America — Checking');
  assert.equal(checking.type, 'cash');
  assert.equal(checking.balance, 900);
  assert.equal(accounts.length, 3);                    // manual account untouched
});

test('mergeSimplefinAccounts tolerates negative and malformed balances', () => {
  const { accounts } = mergeSimplefinAccounts([], [
    { id: 'x', name: 'Card', org: { name: 'B' }, balance: '-250.00' },
    { id: 'y', name: 'Weird', org: {}, balance: 'not-a-number' },
  ], (() => { let n = 1; return () => n++; })());
  assert.equal(accounts[0].balance, 0);
  assert.equal(accounts[1].balance, 0);
});
