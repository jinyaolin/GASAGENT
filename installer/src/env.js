'use strict';
/** @fileoverview .env 讀取與設定物件（零依賴）。 */
const fs = require('node:fs');
const path = require('node:path');

/** 把 WorkingDirectory/.env 讀進 process.env（已有的不覆寫）。 */
function loadEnvFile(file) {
  const p = file || path.join(process.cwd(), '.env');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (err) { return false; }
  text.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
  return true;
}

function buildConfig(env) {
  const e = env || process.env;
  const baseUrl = String(e.BASE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  return {
    host: e.HOST || '127.0.0.1',
    port: Number(e.PORT || 8790),
    baseUrl,
    dataDir: path.resolve(e.DATA_DIR || './data'),
    googleClientId: String(e.GOOGLE_CLIENT_ID || ''),
    googleClientSecret: String(e.GOOGLE_CLIENT_SECRET || ''),
    releaseRepo: String(e.RELEASE_REPO || 'jinyaolin/GASAGENT'),
    releaseRef: String(e.RELEASE_REF || 'main'),
    pickupTtlHours: Math.max(1, Math.min(168, Number(e.PICKUP_TTL_HOURS || 24))),
  };
}

module.exports = { loadEnvFile, buildConfig };
