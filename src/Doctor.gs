/**
 * @fileoverview 自我健檢：Properties、DB 每個 tab 與表頭、trigger、授權 scopes、時區。
 *
 * 回傳純 JSON，管理頁 Doctor 分頁以綠 / 紅 / 黃清單顯示。
 * status：'ok' 通過、'fail' 失敗（整體 ok=false）、'warn' 提醒（不影響整體）。
 */

/**
 * @typedef {{id: string, label: string, status: ('ok'|'fail'|'warn'), detail: string}} DoctorCheck
 */

/**
 * 跑全部健檢。可直接在編輯器執行（即使尚未安裝也能看哪裡紅）。
 * 管理頁請走 adminRunDoctor()（有 assertOwner）。
 * @return {{ok: boolean, version: string, ts: string, checks: !Array<DoctorCheck>}}
 */
function runDoctor() {
  /** @type {!Array<DoctorCheck>} */
  const checks = [];
  const push = (id, label, status, detail) => checks.push({ id, label, status, detail: detail || '' });

  // 1. Properties
  const owner = getOwnerEmail_();
  const me = Session.getEffectiveUser().getEmail();
  if (!owner) {
    push('prop_owner', 'OWNER_EMAIL 已設定', 'fail', '尚未安裝，請執行 installAgent()。');
  } else if (normalizeEmail_(owner) !== normalizeEmail_(me)) {
    push('prop_owner', 'OWNER_EMAIL 與目前使用者相符', 'fail', `OWNER_EMAIL=${owner}，目前=${me || '(空)'}`);
  } else {
    push('prop_owner', 'OWNER_EMAIL 與目前使用者相符', 'ok', owner);
  }

  const dbId = getDbSpreadsheetId_();
  push('prop_db', 'DB_SPREADSHEET_ID 已設定', dbId ? 'ok' : 'fail', dbId || '尚未安裝，請執行 installAgent()。');

  // 2. DB 可開啟 + schema
  let ss = null;
  if (dbId) {
    try {
      ss = SpreadsheetApp.openById(dbId);
      const trashed = DriveApp.getFileById(dbId).isTrashed();
      push('db_open', 'DB spreadsheet 可開啟', trashed ? 'fail' : 'ok',
        trashed ? `「${ss.getName()}」在垃圾桶內` : `${ss.getName()} — ${ss.getUrl()}`);
    } catch (err) {
      push('db_open', 'DB spreadsheet 可開啟', 'fail', String(err && err.message || err));
      ss = null;
    }
  }
  if (ss) {
    inspectDbSchema_(ss).forEach((t) => {
      if (!t.exists) {
        push(`tab_${t.tab}`, `tab「${t.tab}」存在且表頭完整`, 'fail', '缺少此 tab，請執行 installAgent() 補齊。');
      } else if (t.missingColumns.length) {
        push(`tab_${t.tab}`, `tab「${t.tab}」存在且表頭完整`, 'fail', `缺欄位：${t.missingColumns.join(', ')}`);
      } else {
        push(`tab_${t.tab}`, `tab「${t.tab}」存在且表頭完整`, 'ok',
          t.extraColumns.length ? `多出非 schema 欄位：${t.extraColumns.join(', ')}` : `${DB_SCHEMA[t.tab].length} 欄`);
      }
    });
  } else {
    DB_TABS.forEach((tab) => push(`tab_${tab}`, `tab「${tab}」存在且表頭完整`, 'fail', 'DB 無法開啟。'));
  }

  // 3. Trigger
  try {
    const n = listQueueTriggers_().length;
    push('trigger', `每分鐘 trigger → ${QUEUE_TICK_HANDLER}()`, n === 1 ? 'ok' : 'fail',
      n === 0 ? '未安裝，請執行 installAgent()。' : n === 1 ? '1 支' : `${n} 支（應為 1，installAgent() 會清掉多的）`);
  } catch (err) {
    push('trigger', `每分鐘 trigger → ${QUEUE_TICK_HANDLER}()`, 'fail', String(err && err.message || err));
  }

  // 4. 授權 scopes
  const scopes = getGrantedScopes_();
  if (scopes.error) {
    push('scopes', '已授權的 OAuth scopes 涵蓋 appsscript.json', 'fail', scopes.error);
  } else {
    const missing = REQUIRED_SCOPES.filter((s) => scopes.granted.indexOf(s) === -1);
    push('scopes', '已授權的 OAuth scopes 涵蓋 appsscript.json', missing.length ? 'fail' : 'ok',
      missing.length ? `缺少：\n${missing.join('\n')}\n請在編輯器重新執行 installAgent() 以重新授權。` : `${REQUIRED_SCOPES.length} 個 scopes 皆已授權`);
  }

  // 5. 時區
  const tz = Session.getScriptTimeZone();
  push('timezone', `Script 時區為 ${EXPECTED_TIME_ZONE}`, tz === EXPECTED_TIME_ZONE ? 'ok' : 'warn',
    tz === EXPECTED_TIME_ZONE ? tz : `目前 ${tz}，請確認 appsscript.json 的 timeZone 已 push。`);

  // 6. Web App 部署（僅提醒：程式無法得知部署的存取等級）
  let webAppUrl = '';
  try { webAppUrl = ScriptApp.getService().getUrl() || ''; } catch (err) { webAppUrl = ''; }
  push('webapp', 'Web App 已部署', webAppUrl ? 'ok' : 'warn',
    webAppUrl ? `${webAppUrl}\n請確認部署為「以我執行 / 只限我」。` : '尚未部署，或此次不是從 Web App 執行。');

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, version: APP_VERSION, ts: new Date().toISOString(), checks };
}

/**
 * 以目前 OAuth token 查 tokeninfo，取得實際授權的 scopes。
 * @return {{granted: !Array<string>, error: string}}
 */
function getGrantedScopes_() {
  try {
    const token = ScriptApp.getOAuthToken();
    const res = UrlFetchApp.fetch(
      'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return { granted: [], error: `tokeninfo 回應 ${res.getResponseCode()}：${res.getContentText().slice(0, 200)}` };
    }
    const info = JSON.parse(res.getContentText());
    return { granted: String(info.scope || '').split(/\s+/).filter(Boolean), error: '' };
  } catch (err) {
    return { granted: [], error: `無法查詢 tokeninfo：${err && err.message || err}` };
  }
}
