#!/usr/bin/env node
/**
 * 本機跑 Tests.gs 裡標 'pure' 的測試：把 src/*.gs 串起來丟進 vm，stub 掉 GAS 全域物件。
 * 不碰網路、不碰 Google 服務；'db' 類測試請在編輯器 / 管理頁 Doctor 跑 runSmokeTests()。
 *
 *   node scripts/local-tests.js            # 跑全部 pure 測試
 *   node scripts/local-tests.js registry   # 只跑名稱含 "registry" 的
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const srcDir = path.join(__dirname, '..', 'src');
const code = fs.readdirSync(srcDir).filter((f) => f.endsWith('.gs')).sort()
  .map((f) => `// ==== ${f}\n` + fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');

const props = {};
const sandbox = {
  console,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: (k) => { delete props[k]; },
  }) },
  Session: {
    getScriptTimeZone: () => 'Asia/Taipei',
    getActiveUser: () => ({ getEmail: () => 'owner@example.com' }),
    getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }),
  },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, tz, pattern) => {
      // 只模擬程式用到的兩種樣式：yyyy-MM-dd（本地日期）與其餘回 ISO。
      if (pattern === 'yyyy-MM-dd') { const p = (n) => (n < 10 ? '0' + n : String(n)); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
      return d.toISOString();
    },
    newBlob: (s) => {
      const buf = Array.isArray(s) ? Buffer.from(s) : Buffer.from(String(s));
      return { getBytes: () => Array.from(buf), getDataAsString: () => buf.toString('utf8') };
    },
    base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  },
  MimeType: { PLAIN_TEXT: 'text/plain', FOLDER: 'application/vnd.google-apps.folder', PDF: 'application/pdf', GOOGLE_DOCS: 'application/vnd.google-apps.document', GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet', GOOGLE_SLIDES: 'application/vnd.google-apps.presentation' },
  Charts: { ChartType: {} },
  SlidesApp: { PredefinedLayout: {}, PlaceholderType: {}, ListPreset: {}, PageElementType: {} },
  DocumentApp: { ParagraphHeading: {}, GlyphType: {}, ElementType: {} },
  SpreadsheetApp: {}, DriveApp: {}, GmailApp: {}, CalendarApp: {}, UrlFetchApp: {}, ScriptApp: {}, HtmlService: {}, LockService: {}, CacheService: {},
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'gas-agent.gs' });

const filter = process.argv[2] || '';
const table = sandbox.smokeTestTable_().filter(([name, , kind]) => kind === 'pure' && name.indexOf(filter) !== -1);
const origLog = console.log;
console.log = () => {};
const r = sandbox.runTestTable_(table);
console.log = origLog;
r.results.forEach((t) => console.log(`${t.ok ? '✓' : '✗'} ${t.name}${t.ok ? '' : '\n    ' + t.error.split('\n').join('\n    ')}`));
console.log(`\n${r.passed} 通過 / ${r.failed} 失敗（${r.ms} ms；僅 pure 測試）`);
process.exit(r.failed ? 1 : 0);
