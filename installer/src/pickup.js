'use strict';
/**
 * @fileoverview 取件碼：授權完成後把 {refresh_token, client_id, client_secret, email} 放進 DATA_DIR/pickups.json（0600），
 * 給一組 XXXX-XXXX；agent 用 POST /pickup {code} 領走就刪，24 小時沒領也刪。OAuth state 只放記憶體（10 分鐘）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 0 O 1 I
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

function normalizeCode(code) {
  const c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : '';
}

class PickupStore {
  /**
   * @param {string} dataDir
   * @param {{now: (Function|undefined), ttlMs: (number|undefined)}=} opts
   */
  constructor(dataDir, opts) {
    opts = opts || {};
    this.file = path.join(dataDir, 'pickups.json');
    this.now = opts.now || (() => Date.now());
    this.ttlMs = opts.ttlMs || 24 * 3600 * 1000;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (err) { return {}; }
  }
  _write(all) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  _prune(all) {
    const now = this.now();
    Object.keys(all).forEach((k) => { if (!all[k] || all[k].expires <= now) delete all[k]; });
    return all;
  }
  /** @param {!Object} bundle @return {string} 取件碼 */
  create(bundle) {
    const all = this._prune(this._read());
    let code = randomCode();
    while (all[code]) code = randomCode();
    all[code] = { bundle, expires: this.now() + this.ttlMs };
    this._write(all);
    return code;
  }
  /** 領走即刪。@return {?Object} */
  redeem(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    const all = this._prune(this._read());
    const hit = all[c];
    if (!hit) { this._write(all); return null; }
    delete all[c];
    this._write(all);
    return hit.bundle;
  }
  /** @return {number} 待領件數 */
  count() { return Object.keys(this._prune(this._read())).length; }
}

/** OAuth state（記憶體、10 分鐘）。 */
class StateStore {
  constructor(opts) {
    opts = opts || {};
    this.now = opts.now || (() => Date.now());
    this.ttlMs = opts.ttlMs || 10 * 60 * 1000;
    this.map = new Map();
  }
  create(data) {
    const now = this.now();
    for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    this.map.set(state, { data, expires: now + this.ttlMs });
    return state;
  }
  take(state) {
    const hit = this.map.get(String(state || ''));
    if (!hit) return null;
    this.map.delete(state);
    return hit.expires > this.now() ? hit.data : null;
  }
}

/** 粗略每 IP 速率限制。 */
class RateLimit {
  constructor(limit, windowMs, now) { this.limit = limit; this.windowMs = windowMs; this.now = now || (() => Date.now()); this.map = new Map(); }
  hit(key) {
    const now = this.now();
    const e = this.map.get(key);
    if (!e || e.reset <= now) { this.map.set(key, { n: 1, reset: now + this.windowMs }); return true; }
    e.n += 1;
    return e.n <= this.limit;
  }
}

module.exports = { PickupStore, StateStore, RateLimit, randomCode, normalizeCode, CODE_RE };
