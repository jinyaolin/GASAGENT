/**
 * @fileoverview 自我健檢：Properties、DB 每個 tab 與表頭、trigger、授權 scopes、時區、provider（M1）、工具 registry 與 RBAC（M2）、記憶容量 / session / fast provider（M3）、Queue 與排程（M4）、技能資料夾與 SKILL.md（M5）、Telegram / Email 通道（M6）。
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
    const missing = missingScopes_(scopes.granted);
    push('scopes', '已授權的 OAuth scopes 涵蓋 appsscript.json', missing.length ? 'fail' : 'ok',
      missing.length ? `缺少：\n${missing.join('\n')}\n請在編輯器執行 reauthorize()（或 installAgent()）重新授權。` : `${REQUIRED_SCOPES.length} 個 scopes 皆已授權（含母 scope 涵蓋）`);
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

  // 7. Provider（M1）：至少一個啟用的 main provider，且它們的 key 存在
  if (ss) {
    try {
      const mains = providerChain_('main', listProviders_());
      if (!mains.length) {
        push('provider_main', '至少一個啟用的 main provider', 'fail', '請到管理頁「模型」新增 provider（role=main）並啟用。');
        push('provider_main_key', 'main provider 的 API key 已設定', 'fail', '尚無 main provider。');
      } else {
        push('provider_main', '至少一個啟用的 main provider', 'ok',
          `備援鏈：${mains.map((p) => `${p.id}（${p.protocol} / ${p.model}）`).join(' → ')}`);
        const missing = mains.filter((p) => !getProviderKey_(p.id)).map((p) => p.id);
        push('provider_main_key', 'main provider 的 API key 已設定',
          missing.length === mains.length ? 'fail' : missing.length ? 'warn' : 'ok',
          missing.length ? `缺 key：${missing.join(', ')}（Script Property PROVIDER_KEY_<id>），請到管理頁「模型」填入。` : `${mains.length} 個皆已設定`);
      }
    } catch (err) {
      push('provider_main', '至少一個啟用的 main provider', 'fail', String(err && err.message || err));
    }
  } else {
    push('provider_main', '至少一個啟用的 main provider', 'fail', 'DB 無法開啟。');
  }

  // 8. 工具與 RBAC（M2）
  let registry = null;
  try {
    registry = buildToolRegistry_(allToolDeclarations_());
    push('tools_registry', '工具 registry 載入成功且無重名', 'ok',
      `${registry.list.length} 個工具 / ${registry.toolsets.length} 個 toolset：${registry.toolsets.join(', ')}`);
  } catch (err) {
    push('tools_registry', '工具 registry 載入成功且無重名', 'fail', String(err && err.message || err));
  }
  if (ss && registry) {
    try {
      const config = getToolConfig_();
      const missing = registry.toolsets.filter((t) => !config.rbac[t]);
      push('tools_rbac', '每個 toolset 都有 RBAC 設定（Config rbac.<toolset>）', missing.length ? 'fail' : 'ok',
        missing.length ? `缺：${missing.join(', ')}（這些 toolset 會被一律拒絕）。按「重新安裝」或到「工具」分頁儲存即可補預設值。`
          : `${registry.toolsets.length} 個 toolset；審批策略 ${config.approvalPolicy}、spill ${config.spillThreshold}、步數上限 ${config.maxToolSteps}`);
      const readable = registry.toolsets.filter((t) => config.rbac[t] && config.rbac[t].read);
      push('tools_read', '至少一個 toolset 開啟 read', readable.length ? 'ok' : 'fail',
        readable.length ? `read 開啟：${readable.join(', ')}` : '全部 toolset 的 read 都關閉，agent 什麼都查不到。');
    } catch (err) {
      push('tools_rbac', '每個 toolset 都有 RBAC 設定（Config rbac.<toolset>）', 'fail', String(err && err.message || err));
    }
  } else if (registry) {
    push('tools_rbac', '每個 toolset 都有 RBAC 設定（Config rbac.<toolset>）', 'fail', 'DB 無法開啟。');
  }

  // 9. 記憶與 session（M3）
  if (ss) {
    try {
      const cfg = getAgentConfig_();
      const store = sheetMemoryStore_();
      Object.keys(MEMORY_TARGETS).forEach((target) => {
        const used = memoryUsedChars_(store.list(target));
        const limit = memoryLimit_(target, cfg);
        const pct = Math.round((used / limit) * 100);
        push(`memory_${target}`, `${MEMORY_TARGETS[target].label} 容量在上限內`, used > limit ? 'fail' : pct > 85 ? 'warn' : 'ok',
          `${used} / ${limit} 字元（${pct}%）${used > limit ? '，超過上限：請到「記憶」分頁整併' : pct > 85 ? '，快滿了' : ''}`);
      });
      const sessions = sheetSessionStore_().listRecent(10000);
      const active = sessions.filter((x) => x.status === 'active').length;
      push('sessions', 'Sessions / Messages 可讀', 'ok', `${sessions.length} 個 session（${active} 個 active）；壓縮門檻 ${cfg.contextMaxTokens} tokens、curation 每 ${cfg.curationEveryTurns || '（關）'} 輪`);
      const providers = listProviders_();
      const fast = providerChain_('fast', providers);
      push('provider_fast', '有 fast provider（壓縮 / curation 用）', fast.length ? 'ok' : 'warn',
        fast.length ? fast.map((p) => p.id).join(' → ') : '沒有 role=fast 的 provider，壓縮與 curation 會改用 main 模型（較貴、較慢）。');
      if (cfg.sessionEmbeddings) {
        const embed = providerChain_('embed', providers);
        push('provider_embed', 'session 向量搜尋已開且有 embed provider', embed.length ? 'ok' : 'fail',
          embed.length ? embed.map((p) => p.id).join(' → ') : '設定開了 session_embeddings 但沒有 role=embed 的 provider。');
      }
    } catch (err) {
      push('memory', '記憶 / session 健檢', 'fail', String(err && err.message || err));
    }
  }

  // 10. Queue 與排程（M4）
  if (ss) {
    try {
      const jobs = sheetQueueStore_().list();
      const nowMs = Date.now();
      const stuck = jobs.filter((j) => j.state === 'running' && j.started && nowMs - j.started.getTime() > QUEUE_STUCK_RUNNING_MS);
      const queued = jobs.filter((j) => j.state === 'queued').length;
      const failed = jobs.filter((j) => j.state === 'failed').length;
      const dirty = getProp_(PROP.QUEUE_DIRTY) === '1';
      push('queue_stuck', `Queue 沒有卡在 running 超過 ${QUEUE_STUCK_RUNNING_MS / 60000} 分鐘的 job`, stuck.length ? 'fail' : 'ok',
        stuck.length ? `卡住：${stuck.map((j) => j.id).join(', ')}（下次 tick 會重排或判失敗）` : `${jobs.length} 個 job：${queued} queued、${failed} failed；QUEUE_DIRTY=${dirty ? '1' : '（空）'}`);
      if (queued && !dirty) push('queue_dirty', 'QUEUE_DIRTY 旗標與 Queue tab 一致', 'warn', `有 ${queued} 個 queued job 但旗標未設，trigger 不會處理；按一次「處理一個 job」或重新 enqueue 即可。`);
      const crons = sheetCronStore_().list();
      const bad = crons.filter((c) => { try { parseCronSchedule_(c.schedule); return false; } catch (err) { return true; } });
      const enabledCrons = crons.filter((c) => c.enabled);
      const next = earliestCronNextRun_(crons);
      push('cron_schedules', 'Cron 的 schedule 都能解析', bad.length ? 'fail' : 'ok',
        bad.length ? `無法解析：${bad.map((c) => `${c.name}「${c.schedule}」`).join('、')}` : `${crons.length} 個排程（${enabledCrons.length} 啟用）${next ? `，最早下次 ${fmtDate_(next)}` : ''}`);
      const prop = getProp_(PROP.CRON_NEXT_RUN);
      const expected = next ? next.toISOString() : '';
      if (prop !== expected) push('cron_next_prop', 'CRON_NEXT_RUN 旗標與 Cron tab 一致', 'warn', `旗標 ${prop || '（空）'}，應為 ${expected || '（空）'}；開「排程」分頁或重新安裝會對齊。`);
    } catch (err) {
      push('queue', 'Queue / 排程健檢', 'fail', String(err && err.message || err));
    }
  }

  // 11. 技能（M5）：Config skills_folder_id 有效、資料夾可讀、每個 SKILL.md 可解析
  if (ss) {
    try {
      const folderId = getToolConfig_().skillsFolderId;
      let folder = null;
      if (folderId) {
        try {
          folder = DriveApp.getFolderById(parseDriveId_(folderId));
          push('skills_folder_cfg', 'Config skills_folder_id 指向有效的 Drive 資料夾', 'ok', `${folder.getName()} — ${folder.getUrl()}`);
        } catch (err) {
          push('skills_folder_cfg', 'Config skills_folder_id 指向有效的 Drive 資料夾', 'fail', `skills_folder_id=${folderId} 無法開啟：${err && err.message || err}。到「技能」分頁清空或改成正確的資料夾。`);
        }
      } else {
        folder = skillsFolder_('');
        push('skills_folder_cfg', 'Config skills_folder_id 指向有效的 Drive 資料夾', 'ok', `未設定，使用預設 ${SKILLS_FOLDER_PATH.join('/')} — ${folder.getUrl()}`);
      }
      if (folder) {
        const index = driveSkillStore_(folder).list();
        const bad = index.filter((x) => x.error);
        const enabled = index.filter((x) => x.enabled && !x.error).length;
        push('skills_folder', '技能資料夾可讀', 'ok', `${index.length} 個技能（${enabled} 啟用）${index.length ? '：' + index.map((x) => x.name).join(', ') : '；開「技能」分頁會寫入內建範例'}`);
        push('skills_parse', `每個 ${SKILL_FILE_NAME} 可解析（frontmatter name / description）`, bad.length ? 'fail' : 'ok',
          bad.length ? bad.map((x) => `${x.name}：${x.error}`).join('\n') : index.length ? `${index.length} 個皆可解析` : '（尚無技能）');
      }
    } catch (err) {
      push('skills', '技能健檢', 'fail', String(err && err.message || err));
    }
  }

  // 12. 通道（M6）：只在啟用時檢查
  if (ss) {
    try {
      const ccfg = getChannelConfig_();
      if (ccfg.telegramEnabled) {
        const token = getTelegramToken_();
        push('tg_token', 'Telegram bot token 已設定', token ? 'ok' : 'fail', token ? keyHint_(token) : '到「通道」分頁貼上 BotFather 給的 token。');
        push('tg_allow', 'Telegram 白名單至少一個 user id', ccfg.telegramAllowedUserIds.length ? 'ok' : 'fail', ccfg.telegramAllowedUserIds.join(', ') || '沒有白名單，所有訊息都會被丟掉。');
        if (token) {
          try {
            const info = telegramGetWebhookInfo_();
            const expected = ccfg.telegramWebhookUrl ? telegramWebhookUrl_(ccfg.telegramWebhookUrl, getTelegramSecret_()) : '';
            const url = String(info.url || '');
            push('tg_webhook', 'Telegram webhook 已登記且指向部署 B', !url ? 'fail' : url === expected ? 'ok' : 'warn',
              !url ? '尚未登記：到「通道」分頁填部署 B 網址後按「設定 webhook」。' : (url === expected ? '' : '登記的 URL 與設定不同（secret 或網址變了？按「設定 webhook」重登）。') +
              `${url.replace(/key=[^&]+/, 'key=…')}；待處理 ${info.pending_update_count || 0}${info.last_error_message ? `；最後錯誤 ${info.last_error_date ? fmtDate_(new Date(info.last_error_date * 1000)) : ''} ${info.last_error_message}` : ''}`);
          } catch (err) {
            push('tg_webhook', 'Telegram webhook 已登記且指向部署 B', 'fail', String(err && err.message || err));
          }
        }
      }
      if (ccfg.emailEnabled) {
        const label = GmailApp.getUserLabelByName(ccfg.emailInboxLabel);
        push('email_label', `Gmail 標籤「${ccfg.emailInboxLabel}」存在`, label ? 'ok' : 'warn', label ? '把寄給自己的指令信貼上這個標籤即可' : '第一次掃描或「通道」分頁「建立標籤」會自動建立。');
        const next = getProp_(PROP.EMAIL_NEXT_SCAN);
        push('email_scan', 'Email 指令信掃描旗標已設', next ? 'ok' : 'warn', next ? `下次掃描 ${fmtDate_(new Date(next))}（每 ${ccfg.emailScanEveryMinutes} 分鐘）` : '旗標空：到「通道」分頁再儲存一次。');
      }
      if (!ccfg.telegramEnabled && !ccfg.emailEnabled) push('channels', 'Telegram / Email 通道', 'ok', '兩者皆未啟用（只用管理頁聊天台）。');
    } catch (err) {
      push('channels', '通道健檢', 'fail', String(err && err.message || err));
    }
  }

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
