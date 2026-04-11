// VeloraPay IDFC Merchant Extension — Content Script v3.1
(function () {
  'use strict';

  let running = false;
  let sentIds = new Set();
  let stats = { synced: 0, amt: 0, cycles: 0, errors: 0 };
  let heartbeat = null;
  let reloadDeadline = 0;    // epoch ms when next scheduled reload fires (for countdown)
  const SYNC_INTERVAL = 40;  // seconds — page reload + sync cycle
  const PER_PAGE      = 10;  // items per page on IDFC portal
  const MAX_LOGIN_CYCLES = 5; // max consecutive login failures before giving up
  const LOGIN_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after max failures

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    await loadState();
    const url = location.href;

    if (url.includes('/login')) {
      await sleep(1800);
      await autoLogin();
    } else if (url.includes('/transactions')) {
      // Reached transactions successfully → reset login failure counter
      chrome.storage.local.remove(['loginFailCount', 'loginCooldownUntil']);
      await sleep(2500);
      showOverlay();
      startHeartbeat();
      await runCycle(); // immediate first run — reload triggers next ones
    } else {
      // Logged out or session expired — redirected to unknown page
      log('warn', `Landed on unexpected page: ${url} — likely logged out, redirecting to login...`);
      toast('⚠ Session expired — redirecting to login...');
      await sleep(2000);
      location.href = 'https://merchant.phi.idfcbank.com/upi-merchant/login';
    }
  }

  async function loadState() {
    return new Promise(r => chrome.storage.local.get(['sentIds', 'syncStats'], d => {
      if (d.sentIds) sentIds = new Set(d.sentIds);
      if (d.syncStats) stats = { ...stats, ...d.syncStats };
      r();
    }));
  }

  // ── Auto-login: credentials once, up to 5 in-page captcha retries, then 3 OTP attempts ─
  const MAX_OTP_ATTEMPTS = 3;
  const MAX_CAPTCHA_RETRIES = 5; // in-page captcha refresh attempts per login cycle

  async function autoLogin() {
    const cfg = await getConfig();
    if (!cfg) return log('warn', 'No account selected — open extension popup');

    // Loop guard: check cooldown + failure count
    const guard = await new Promise(r => chrome.storage.local.get(['loginFailCount', 'loginCooldownUntil'], r));
    const failCount = guard.loginFailCount || 0;
    const cooldownUntil = guard.loginCooldownUntil || 0;

    if (Date.now() < cooldownUntil) {
      const waitSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
      log('warn', `Login cooldown active — ${waitSec}s remaining. Skipping auto-login.`);
      toast(`⏸ Login paused — retry in ${Math.ceil(waitSec / 60)}min (manual intervention needed)`);
      return;
    }

    if (failCount >= MAX_LOGIN_CYCLES) {
      log('error', `Hit ${MAX_LOGIN_CYCLES} consecutive login failures — entering cooldown`);
      chrome.storage.local.set({
        loginCooldownUntil: Date.now() + LOGIN_COOLDOWN_MS,
        loginFailCount: 0,
      });
      toast(`❌ Too many login failures — paused for 5 min`);
      return;
    }

    log('info', `Logging in: ${cfg.account_name} (cycle ${failCount + 1}/${MAX_LOGIN_CYCLES})`);

    // Step 1: Fill credentials (once per login cycle)
    try {
      const u = await waitFor('input[formcontrolname="newusername"]', 5000);
      const p = await waitFor('input[formcontrolname="newpassword"]', 5000);
      ngSet(u, cfg.login_username);
      ngSet(p, cfg.login_password);
      log('ok', 'Credentials filled');
    } catch {
      log('warn', 'Login fields not found — aborting (not retryable)');
      return; // don't increment failCount — this is a structural issue
    }

    // Step 2: Captcha loop — retry in-page (refresh button) on failure, up to MAX_CAPTCHA_RETRIES
    let captchaOk = false;
    for (let cAttempt = 1; cAttempt <= MAX_CAPTCHA_RETRIES; cAttempt++) {
      log('info', `Captcha attempt ${cAttempt}/${MAX_CAPTCHA_RETRIES}`);

      // Re-fill credentials if they were cleared by captcha refresh (Angular sometimes resets the form)
      const u = document.querySelector('input[formcontrolname="newusername"]');
      const p = document.querySelector('input[formcontrolname="newpassword"]');
      if (u && !u.value) ngSet(u, cfg.login_username);
      if (p && !p.value) ngSet(p, cfg.login_password);

      // Solve captcha
      let solved;
      try {
        const img = await waitFor('img.captcha-image', 3000);
        solved = await new Promise(r =>
          chrome.runtime.sendMessage({ action: 'solveCaptcha', imageData: img.src }, res => r(res?.text || null))
        );
      } catch {
        log('warn', 'Captcha image not found');
        await refreshCaptcha();
        continue;
      }

      if (!solved) {
        toast('⚠ No API key — add Groq or Gemini key in settings');
        return;
      }

      // Fill + submit
      try {
        const ci = await waitFor('input[formcontrolname="captcha"]', 2000);
        ngSet(ci, solved);
        log('ok', `Captcha filled: "${solved}"`);
        await sleep(400);
        document.querySelector('button.auth-button')?.click();
        log('info', 'Login clicked — checking result...');
      } catch {
        log('warn', 'Captcha input not found');
        await refreshCaptcha();
        continue;
      }

      // Wait for result
      await sleep(3000);

      // Success indicator: OTP page appeared OR captcha input is gone AND no error
      const stillHasCaptcha = !!document.querySelector('input[formcontrolname="captcha"]');
      const errorEl = document.querySelector('.alert-danger, .error-message, .invalid-feedback[style*="block"], .alert-wrapper .alert');
      const errorText = errorEl ? errorEl.textContent.trim() : '';

      if (!stillHasCaptcha && !errorText) {
        log('ok', 'Captcha accepted — proceeding to OTP');
        captchaOk = true;
        break;
      }

      // Failed — identify why
      if (errorText && /credential|username|password|blocked|locked/i.test(errorText)) {
        log('error', `Credential error: "${errorText.slice(0, 80)}" — not retryable`);
        toast(`❌ ${errorText.slice(0, 60)}`);
        await bumpFailAndReload();
        return;
      }

      log('warn', `Captcha wrong (${errorText || 'still on login page'}) — refreshing captcha`);
      await refreshCaptcha();
      // loop again
    }

    if (!captchaOk) {
      log('error', `Captcha failed ${MAX_CAPTCHA_RETRIES} times — reloading page`);
      await bumpFailAndReload();
      return;
    }

    // Step 3: OTP — up to 3 attempts with resend
    const otpResult = await autoOtp();
    if (otpResult === 'success') {
      log('ok', 'Login+OTP succeeded');
      // boot() on /transactions will clear the fail counter
    } else {
      log('error', `OTP failed after ${MAX_OTP_ATTEMPTS} attempts — reloading to start over...`);
      toast('❌ OTP failed — reloading to retry login...');
      await bumpFailAndReload();
    }
  }

  // Click the captcha refresh button (reloads captcha image without full page reload)
  async function refreshCaptcha() {
    const refreshBtn = document.querySelector(
      '.refresh-button, .refresh-button-invalid, [mattooltip*="Refresh"], button[aria-label*="refresh"], img.refresh-icon, .captcha-refresh'
    );
    if (refreshBtn) {
      refreshBtn.click();
      log('info', 'Clicked captcha refresh');
      await sleep(1500); // wait for new captcha image to load
    } else {
      log('warn', 'Captcha refresh button not found — waiting briefly');
      await sleep(1500);
    }
  }

  // Increment login fail counter, then reload login page to retry fresh
  async function bumpFailAndReload() {
    const d = await new Promise(r => chrome.storage.local.get('loginFailCount', r));
    const next = (d.loginFailCount || 0) + 1;
    await new Promise(r => chrome.storage.local.set({ loginFailCount: next }, r));
    log('info', `Login fail count: ${next}/${MAX_LOGIN_CYCLES}`);
    await sleep(3000);
    location.reload();
  }

  // ── Auto-OTP: 3 attempts — attempt 1 waits for initial OTP, attempts 2+3 click resend ─
  async function autoOtp() {
    let otpInput;
    try {
      otpInput = await waitFor('input[formcontrolname="otp"], input[formcontrolname="otpValue"], .otp-wrapper input[type="text"], .otp-wrapper input[type="number"], .otp-wrapper input[type="password"]', 10000);
    } catch {
      log('info', 'No OTP page detected — may have logged in directly');
      return 'success';
    }

    log('ok', 'OTP page detected');

    // sinceTs = when OTP was (re)requested — only SMS received after this are valid
    // For attempt 1: OTP was sent when login button was clicked (a few seconds ago).
    //   Use a small backdated window to catch OTPs that arrived during page transition.
    let sinceTs = Date.now() - 15000;

    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
      log('info', `OTP attempt ${attempt}/${MAX_OTP_ATTEMPTS} — requesting from SMS Tracker...`);
      toast(`🔐 Fetching OTP (attempt ${attempt}/${MAX_OTP_ATTEMPTS})...`);

      // Attempts 2+3: click resend OTP before polling, reset sinceTs to "now"
      if (attempt > 1) {
        log('info', 'Waiting 10s before resending OTP...');
        await sleep(10000);
        const resendBtn = document.querySelector('button[class*="resend"], a[class*="resend"], .resend-otp, [mattooltip*="Resend"]');
        if (resendBtn) {
          resendBtn.click();
          log('ok', `Clicked Resend OTP (attempt ${attempt})`);
          sinceTs = Date.now(); // only accept OTPs that arrive AFTER the resend click
          await sleep(3000);
        } else {
          log('warn', 'Resend OTP button not found');
        }
      }

      const otpRes = await new Promise(r =>
        chrome.runtime.sendMessage({ action: 'fetchOtp', sinceTs }, res => r(res || {}))
      );

      if (otpRes.error === 'OTP_IN_FLIGHT') {
        log('warn', 'Another OTP request in progress — waiting...');
        await sleep(5000);
        continue;
      }

      if (!otpRes.otp) {
        log('warn', `OTP attempt ${attempt} — not received`);
        if (attempt === MAX_OTP_ATTEMPTS) {
          toast('⚠ OTP not found after 3 attempts — enter manually');
          return 'otp_fail';
        }
        continue;
      }

      // Re-find the OTP input (page may have refreshed)
      try {
        otpInput = document.querySelector('input[formcontrolname="otp"], input[formcontrolname="otpValue"], .otp-wrapper input[type="text"], .otp-wrapper input[type="number"], .otp-wrapper input[type="password"]');
      } catch {}

      if (!otpInput) {
        log('warn', 'OTP input disappeared');
        return 'otp_fail';
      }

      ngSet(otpInput, otpRes.otp);
      log('ok', `OTP filled: "${otpRes.otp}"`);
      await sleep(500);

      // Click submit
      const submitBtn = document.querySelector('.otp-wrapper button.auth-button, .otp-wrapper button[type="submit"], .otp-wrapper .btn-primary, button.auth-button');
      if (submitBtn) {
        submitBtn.click();
        log('ok', 'OTP submitted');
      } else {
        log('warn', 'OTP submit button not found — submit manually');
        toast('✅ OTP filled — click Submit manually');
      }

      // Check if OTP was accepted
      await sleep(3000);
      const stillOnOtp = document.querySelector('.otp-wrapper, app-otp-verification');
      const otpError = document.querySelector('.otp-wrapper .alert-danger, .otp-wrapper .error-message, .otp-wrapper .invalid-feedback');
      if (stillOnOtp && otpError && otpError.textContent.trim()) {
        log('warn', `OTP rejected: "${otpError.textContent.trim().slice(0, 80)}"`);
        if (attempt < MAX_OTP_ATTEMPTS) continue;
        return 'otp_fail';
      }

      return 'success';
    }

    return 'otp_fail';
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

    // Session-expired detection: if login form appears or session-expired banner shows, redirect to login
    if (isSessionExpired()) {
      log('warn', 'Session expired detected on /transactions — redirecting to login');
      toast('⚠ Session expired — redirecting to login...');
      running = false;
      await sleep(1500);
      location.href = 'https://merchant.phi.idfcbank.com/upi-merchant/login';
      return;
    }

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
          fresh.forEach(t => addSentId(t.txnId));
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
    reloadDeadline = Date.now() + SYNC_INTERVAL * 1000;
    setTimeout(() => {
      log('info', '🔄 Force-reloading page to keep session alive...');
      location.reload();
    }, SYNC_INTERVAL * 1000);
  }

  // ── Session expired detection ────────────────────────────────────────────
  // Angular may not change URL on session expiry — check DOM for login form or banners
  function isSessionExpired() {
    // Login form visible on /transactions = session expired
    if (document.querySelector('input[formcontrolname="newusername"]')) return true;
    if (document.querySelector('input[formcontrolname="captcha"]')) return true;
    // Session expired banners/dialogs
    const bodyText = document.body?.textContent || '';
    if (/session.{0,10}(expired|timeout|ended)/i.test(bodyText)) return true;
    if (/please.{0,10}login.{0,10}again/i.test(bodyText)) return true;
    return false;
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

  // ── Heartbeat every 1s — real countdown to next reload ───────────────────
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      const timerEl = document.querySelector('#vp-ov-timer');
      if (timerEl) {
        if (running) {
          timerEl.textContent = '⟳ running';
        } else if (reloadDeadline > 0) {
          const secs = Math.max(0, Math.ceil((reloadDeadline - Date.now()) / 1000));
          timerEl.textContent = `↺ ${secs}s`;
        } else {
          timerEl.textContent = '--s';
        }
      }
      chrome.storage.local.set({ heartbeat: { ts: Date.now(), cycles: stats.cycles } });
    }, 1000);
  }

  // ── State persistence ──────────────────────────────────────────────────────
  const MAX_SENT_IDS = 3000;
  function addSentId(id) {
    if (sentIds.has(id)) return;
    sentIds.add(id);
    // Evict oldest entries (Set preserves insertion order)
    while (sentIds.size > MAX_SENT_IDS) {
      const oldest = sentIds.values().next().value;
      sentIds.delete(oldest);
    }
  }
  function saveState()  { chrome.storage.local.set({ sentIds: [...sentIds] }); }
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
