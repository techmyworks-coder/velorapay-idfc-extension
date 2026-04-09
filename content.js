// VeloraPay IDFC Merchant Extension — Content Script v3.1
(function () {
  'use strict';

  let running = false;
  let sentIds = new Set();
  let stats = { synced: 0, amt: 0, cycles: 0, errors: 0 };
  let heartbeat = null;
  const SYNC_INTERVAL = 40;  // seconds — page reload + sync cycle
  const PER_PAGE      = 10;  // items per page on IDFC portal

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    await loadState();
    const url = location.href;

    if (url.includes('/login')) {
      await sleep(1800);
      await autoLogin();
    } else if (url.includes('/transactions')) {
      await sleep(2500);
      showOverlay();
      startHeartbeat();
      await runCycle(); // immediate first run — reload triggers next ones
    }
  }

  async function loadState() {
    return new Promise(r => chrome.storage.local.get(['sentIds', 'syncStats'], d => {
      if (d.sentIds) sentIds = new Set(d.sentIds);
      if (d.syncStats) stats = { ...stats, ...d.syncStats };
      r();
    }));
  }

  // ── Auto-login ─────────────────────────────────────────────────────────────
  async function autoLogin() {
    const cfg = await getConfig();
    if (!cfg) return log('warn', 'No account selected — open extension popup');

    log('info', `Auto-fill: ${cfg.account_name}`);
    try {
      const u = await waitFor('input[formcontrolname="newusername"]', 5000);
      const p = await waitFor('input[formcontrolname="newpassword"]', 5000);
      ngSet(u, cfg.login_username);
      ngSet(p, cfg.login_password);
      log('ok', 'Credentials filled');
    } catch { log('warn', 'Login fields not found'); return; }

    // Captcha
    try {
      const img = await waitFor('img.captcha-image', 3000);
      const solved = await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'solveCaptcha', imageData: img.src }, res => r(res?.text || null))
      );
      if (solved) {
        const ci = await waitFor('input[formcontrolname="captcha"]', 2000);
        ngSet(ci, solved);
        log('ok', `Captcha: "${solved}"`);
        await sleep(400);
        document.querySelector('button.auth-button')?.click();
      } else {
        log('warn', 'No AI key — fill captcha manually');
        toast('⚠ Enter captcha manually then click Continue');
      }
    } catch { log('warn', 'Captcha element not found'); }
  }

  // ── Main cycle ────────────────────────────────────────────────────────────
  // Strategy: run once → sync data → wait SYNC_INTERVAL → hard-reload page
  // Hard reload avoids logout and resets Angular state cleanly.
  async function runCycle() {
    if (running) return;
    running = true;
    const cycleStart = Date.now();
    stats.cycles++;
    log('info', `▶ Cycle #${stats.cycles} started`);
    updateOverlay('syncing');

    try {
      const cfg = await getConfig();
      if (!cfg) {
        log('warn', 'No config — select account in popup');
        running = false;
        scheduleReload();
        return;
      }

      // Step 1: ensure 10 items per page
      await setItemsPerPage(PER_PAGE);
      await sleep(800);

      // Step 2: collect first page (10 rows = last 10 txns)
      // We stay on page 1 only — newest transactions always appear first
      await waitForRows(5000);
      const all = scrapeRows(); // only SUCCESS rows returned
      log('info', `Page 1: ${all.length} SUCCESS transactions found`);

      // Step 3: filter last 30 minutes by txn timestamp
      const cutoff = Date.now() - 30 * 60 * 1000;
      const recent = all.filter(t => {
        const ts = new Date(t.dateTime).getTime();
        return isNaN(ts) || ts >= cutoff;
      });
      log('info', `${recent.length} within last 30 min`);

      // Step 4: deduplicate against already-sent IDs
      const fresh = recent.filter(t => !sentIds.has(t.txnId));
      log('info', `${fresh.length} new (not yet sent)`);

      // Step 5: POST to API
      if (fresh.length > 0) {
        const result = await postBatch(fresh, cfg);
        pushAPILog(result, fresh);

        if (result.ok) {
          fresh.forEach(t => sentIds.add(t.txnId));
          saveState();
          const amt = fresh.reduce((s, t) => s + parseAmt(t.amount), 0);
          stats.synced += fresh.length;
          stats.amt    += amt;
          stats.lastSync = new Date().toLocaleTimeString();
          log('ok', `✓ Sent ${fresh.length} txns | ₹${fmt(amt)} | HTTP ${result.status}`);
          updateOverlay('ok', `${fresh.length} synced`);
        } else {
          stats.errors++;
          log('error', `✗ API ${result.status}: ${JSON.stringify(result.data).slice(0, 150)}`);
          updateOverlay('error', `API ${result.status}`);
        }
      } else {
        log('ok', `Nothing new (${all.length} found, ${recent.length} recent, all already sent)`);
        updateOverlay('idle', 'Up to date');
      }
      saveStats();
    } catch (e) {
      stats.errors++;
      log('error', 'Cycle error: ' + e.message);
      updateOverlay('error', e.message);
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    log('info', `◀ Cycle #${stats.cycles} done in ${elapsed}s — reloading in ${SYNC_INTERVAL}s`);
    running = false;

    // Schedule hard reload after SYNC_INTERVAL to keep session alive
    scheduleReload();
  }

  // ── Force page reload after SYNC_INTERVAL ────────────────────────────────
  // This prevents IDFC session timeout AND ensures we always get fresh data
  function scheduleReload() {
    log('info', `⏱ Page reload scheduled in ${SYNC_INTERVAL}s`);
    setTimeout(() => {
      log('info', '🔄 Force-reloading page to keep session alive...');
      location.reload();
    }, SYNC_INTERVAL * 1000);
  }

  // ── Set items per page ────────────────────────────────────────────────────
  async function setItemsPerPage(n) {
    try {
      // Try the mat-paginator select
      const trigger = document.querySelector('mat-select');
      if (!trigger) return;
      const cur = trigger.querySelector('.mat-mdc-select-value-text, .mat-select-value-text')?.textContent?.trim();
      if (cur === String(n)) return; // already correct
      trigger.click();
      await sleep(500);
      const opts = [...document.querySelectorAll('mat-option')];
      for (const opt of opts) {
        if (opt.textContent.trim() === String(n)) {
          opt.click();
          await sleep(700);
          log('info', `Items per page set to ${n}`);
          return;
        }
      }
    } catch { /* ignore */ }
  }

  // ── Wait for rows ──────────────────────────────────────────────────────────
  async function waitForRows(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (document.querySelectorAll('table tbody tr[mat-row]').length > 0) return;
      await sleep(200);
    }
    log('warn', 'waitForRows timeout — no rows appeared');
  }

  // ── Scrape rows — ONLY SUCCESS / Completed ────────────────────────────────
  function scrapeRows() {
    const rows = document.querySelectorAll('table tbody tr[mat-row]');
    const out = [];
    rows.forEach(row => {
      const c = row.querySelectorAll('td[mat-cell]');
      if (c.length < 8) return;
      const g = i => c[i]?.textContent?.trim() || '';

      const status = g(5);   // e.g. "Completed"
      const result = g(24);  // e.g. "SUCCESS"
      const respCode = g(6); // e.g. "00"

      // STRICT: only include if BOTH status=Completed AND result=SUCCESS
      const isSuccess =
        status.toLowerCase().includes('completed') &&
        result.toLowerCase() === 'success';

      if (!isSuccess) return; // skip Rejected / FAILURE / Pending

      out.push({
        txnId:    g(0),
        rrn:      g(1),   // custRef — RRN / UTR
        orderId:  g(2),   // refId
        txnType:  g(3),
        amount:   g(4),
        status,
        respCode,
        dateTime: g(7),
        payerName:g(10),
        payerVpa: g(11),
        payerAcct:g(12),
        payerIFSC:g(13),
        payeeName:g(14),
        payeeVpa: g(15),
        payeeAcct:g(16),
        payeeIFSC:g(17),
        remarks:  g(22),  // note field — TXNxxx ID
        result,
      });
    });
    return out;
  }

  // ── POST to VeloraPay API ─────────────────────────────────────────────────
  async function postBatch(txns, cfg) {
    const payload = {
      transactions: txns.map(t => ({
        bank_config_id:   cfg.id,
        bank_name:        cfg.bank_name,
        account_number:   cfg.account_number,
        uid:              t.rrn || t.orderId || t.txnId,  // RRN preferred
        transaction_id:   t.remarks || t.txnId,           // TXNxxx note field
        amount:           parseAmt(t.amount),
        transaction_date: toISO(t.dateTime),
        currency:         'INR',
        flow:             'Credit',
        payer_name:       t.payerName,
        payer_vpa:        t.payerVpa,
        payer_account:    t.payerAcct,
        payer_ifsc:       t.payerIFSC,
        payee_vpa:        t.payeeVpa,
        response_code:    t.respCode,
        result:           t.result,
        status:           t.status,
      }))
    };
    return new Promise(r =>
      chrome.runtime.sendMessage({ action: 'postAPI', endpoint: 'phonepe-ingest', payload }, res => r(res || { ok: false }))
    );
  }

  // ── Config fetch ──────────────────────────────────────────────────────────
  async function getConfig() {
    return new Promise(r => {
      chrome.storage.local.get(['selectedId', 'cachedCfg', 'cachedCfgId'], d => {
        if (!d.selectedId) return r(null);
        if (d.cachedCfgId === d.selectedId && d.cachedCfg) return r(d.cachedCfg);
        chrome.runtime.sendMessage({ action: 'fetchConfigDetail', id: d.selectedId }, res => {
          if (res?.data) {
            chrome.storage.local.set({ cachedCfg: res.data, cachedCfgId: d.selectedId });
            r(res.data);
          } else r(null);
        });
      });
    });
  }

  // ── In-page floating overlay ──────────────────────────────────────────────
  function showOverlay() {
    if (document.getElementById('vp-overlay')) return;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes vp-pulse{0%{box-shadow:0 0 0 0 rgba(76,175,80,0.5)}70%{box-shadow:0 0 0 10px rgba(76,175,80,0)}100%{box-shadow:0 0 0 0 rgba(76,175,80,0)}}
      @keyframes vp-scan{0%{background-position:200% center}100%{background-position:-200% center}}
      #vp-overlay *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
      #vp-ov-bar{height:2px;background:linear-gradient(90deg,transparent,#9d1d27,#ff6b7a,#9d1d27,transparent);background-size:200% 100%;animation:vp-scan 2s linear infinite;border-radius:2px 2px 0 0;}
      #vp-ov-logo{font-weight:800;font-size:13px;color:#ff6b7a;letter-spacing:-0.3px;}
      #vp-ov-status{font-size:11px;color:rgba(255,255,255,0.7);margin-top:3px;min-height:16px;}
      #vp-ov-footer{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);}
      #vp-ov-cycles{font-size:10px;color:rgba(255,255,255,0.35);font-family:monospace;}
      #vp-ov-timer{font-size:10px;color:#ff9800;font-family:monospace;font-weight:700;}
      #vp-ov-pulse{width:8px;height:8px;background:#4caf50;border-radius:50%;animation:vp-pulse 2s infinite;flex-shrink:0;}
    `;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'vp-overlay';
    el.innerHTML = `
      <div id="vp-ov-bar"></div>
      <div style="padding:8px 12px 10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div id="vp-ov-logo">⚡ VeloraPay</div>
          <div id="vp-ov-pulse"></div>
        </div>
        <div id="vp-ov-status">Initializing...</div>
        <div id="vp-ov-footer">
          <div id="vp-ov-cycles">Cycle #0</div>
          <div id="vp-ov-timer">--s</div>
        </div>
      </div>`;
    el.style.cssText = `
      position:fixed;bottom:20px;left:20px;z-index:999999;
      background:linear-gradient(145deg,#150a0c,#220f12);
      border:1px solid rgba(157,29,39,0.6);border-radius:10px;
      overflow:hidden;min-width:190px;
      box-shadow:0 8px 32px rgba(0,0,0,0.6),0 0 0 1px rgba(157,29,39,0.15);
      backdrop-filter:blur(12px);cursor:default;user-select:none;`;
    document.body.appendChild(el);
  }

  function updateOverlay(state, msg) {
    const stEl = document.querySelector('#vp-ov-status');
    const dot  = document.querySelector('#vp-ov-pulse');
    const cyEl = document.querySelector('#vp-ov-cycles');
    if (!stEl) return;

    const map = {
      ok:      ['#22c55e', `✓ ${msg || 'Synced'}`],
      error:   ['#ef4444', `✗ ${msg}`],
      syncing: ['#f59e0b', '⟳ Syncing...'],
      idle:    ['#22c55e', `● ${msg || 'Monitoring'}`],
    };
    const [color, text] = map[state] || ['#aaa', msg || ''];
    stEl.textContent = text;
    if (dot)  dot.style.background = color;
    if (cyEl) cyEl.textContent = `Cycle #${stats.cycles}`;
    pushStatus(state, text);
  }

  // ── Heartbeat every 5s — updates overlay timer ────────────────────────────
  function startHeartbeat() {
    if (heartbeat) return;
    let reloadIn = SYNC_INTERVAL; // counts down after runCycle sets scheduleReload
    heartbeat = setInterval(() => {
      const timerEl = document.querySelector('#vp-ov-timer');
      if (timerEl) timerEl.textContent = running ? '⟳ running' : `↺ ${SYNC_INTERVAL}s`;
      chrome.storage.local.set({ heartbeat: { ts: Date.now(), cycles: stats.cycles } });
    }, 5000);
  }

  // ── State persistence ──────────────────────────────────────────────────────
  function saveState()  { chrome.storage.local.set({ sentIds: [...sentIds].slice(-3000) }); }
  function saveStats()  { chrome.storage.local.set({ syncStats: stats }); }
  function pushStatus(type, msg) { chrome.storage.local.set({ syncStatus: { type, msg, ts: Date.now() } }); }

  function pushAPILog(result, txns) {
    chrome.storage.local.get('apiLogs', d => {
      const logs = d.apiLogs || [];
      logs.unshift({
        ts:       new Date().toLocaleTimeString(),
        status:   result.status,
        ok:       result.ok,
        count:    txns.length,
        amt:      txns.reduce((s, t) => s + parseAmt(t.amount), 0),
        request:  {
          endpoint: 'phonepe-ingest',
          txnCount: txns.length,
          utrs:     txns.map(t => t.rrn),
          txnIds:   txns.map(t => t.txnId),
          remarks:  txns.map(t => t.remarks),
        },
        response: result.data,
      });
      chrome.storage.local.set({ apiLogs: logs.slice(0, 100) });
    });
  }

  function log(level, msg) {
    console.log(`[VeloraPay][${level}] ${msg}`);
    chrome.storage.local.get('syncLog', d => {
      const logs = d.syncLog || [];
      logs.unshift({ ts: new Date().toLocaleTimeString(), level, msg });
      chrome.storage.local.set({ syncLog: logs.slice(0, 300) });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function ngSet(el, val) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }
  function waitFor(sel, ms = 5000) {
    return new Promise((res, rej) => {
      const el = document.querySelector(sel);
      if (el) return res(el);
      const obs = new MutationObserver(() => {
        const f = document.querySelector(sel);
        if (f) { obs.disconnect(); res(f); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); rej(new Error('timeout:' + sel)); }, ms);
    });
  }
  function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
  function parseAmt(s)  { return parseFloat((s || '0').replace(/[₹,\s]/g, '')) || 0; }
  function fmt(n)       { return (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toISO(s)     { try { return new Date(s).toISOString(); } catch { return new Date().toISOString(); } }
  function toast(msg) {
    let t = document.getElementById('vp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'vp-toast'; document.body.appendChild(t); }
    t.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999999;background:#9d1d27;color:#fff;padding:12px 18px;border-radius:8px;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.3);max-width:300px;';
    t.textContent = msg; t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 6000);
  }

  // ── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, res) => {
    if (msg.action === 'alarmTick' && location.href.includes('/transactions')) {
      // Alarm is backup — page reload is primary trigger
      if (!running) runCycle();
      res({ ok: true });
    }
    if (msg.action === 'forceSync') {
      runCycle();
      res({ ok: true });
    }
  });

  boot();
})();
