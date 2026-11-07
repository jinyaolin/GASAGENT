'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PickupStore, StateStore, RateLimit, normalizeCode, CODE_RE } = require('../src/pickup');

test('取件碼：產生、領一次就沒、過期清掉、檔案 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-'));
  let t = 1000;
  const store = new PickupStore(dir, { now: () => t, ttlMs: 100 });
  const code = store.create({ refresh_token: 'R', email: 'a@b' });
  assert.match(code, CODE_RE);
  assert.equal(store.count(), 1);
  assert.equal((fs.statSync(path.join(dir, 'pickups.json')).mode & 0o777), 0o600);
  assert.equal(store.redeem('nope'), null);
  assert.deepEqual(store.redeem(code.toLowerCase().replace('-', ' ')), { refresh_token: 'R', email: 'a@b' });
  assert.equal(store.redeem(code), null, '一次性');
  const c2 = store.create({ x: 1 });
  t += 101;
  assert.equal(store.redeem(c2), null, '過期');
  assert.equal(store.count(), 0);
});

test('normalizeCode', () => {
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCD-EFGH');
  assert.equal(normalizeCode('abcdefgh'), 'ABCD-EFGH');
  assert.equal(normalizeCode('abc'), '');
});

test('state：一次性、過期', () => {
  let t = 0;
  const s = new StateStore({ now: () => t, ttlMs: 10 });
  const st = s.create({ mode: 'install' });
  assert.deepEqual(s.take(st), { mode: 'install' });
  assert.equal(s.take(st), null);
  const st2 = s.create({ mode: 'login' });
  t = 11;
  assert.equal(s.take(st2), null);
});

test('rate limit', () => {
  let t = 0;
  const r = new RateLimit(2, 100, () => t);
  assert.equal(r.hit('a'), true); assert.equal(r.hit('a'), true); assert.equal(r.hit('a'), false);
  assert.equal(r.hit('b'), true);
  t = 101;
  assert.equal(r.hit('a'), true);
});
