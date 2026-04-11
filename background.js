// VeloraPay IDFC Merchant Extension — Background
const IDFC_URL = 'https://merchant.phi.idfcbank.com/upi-merchant/main/transactions';
const ALARM = 'vp-sync';
const TAG = '[VeloraPay BG]';
let otpInFlight = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.667 }); // 40s
  console.log(TAG, '✅ Extension installed — alarm created (40s interval)');
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  console.log(TAG, '⏰ Alarm tick — pinging IDFC tabs');
  chrome.tabs.query({ url: 'https://merchant.phi.idfcbank.com/*' }, tabs => {
    console.log(TAG, `Found ${tabs.length} IDFC tab(s)`);
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { action: 'alarmTick' }).catch(() => {}));
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const from = sender.tab ? `tab:${sender.tab.id}` : 'popup';
  console.log(TAG, `📩 Message: "${msg.action}" from ${from}`);

  if (msg.action === 'openIDFC') {
    chrome.tabs.query({ url: 'https://merchant.phi.idfcbank.com/*' }, tabs => {
      if (tabs.length) {
        console.log(TAG, 'Focusing existing IDFC tab');
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        console.log(TAG, 'Opening new IDFC tab');
        chrome.tabs.create({ url: IDFC_URL });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'postAPI') {
    console.log(TAG, `📤 POST /${msg.endpoint} — ${msg.payload?.transactions?.length || 0} txns`);
    callAPI(msg.endpoint, msg.payload)
      .then(r => {
        console.log(TAG, `📥 API response: ${r.status} ${r.ok ? '✓' : '✗'}`, r.data);
        sendResponse(r);
      })
      .catch(e => {
        console.error(TAG, '❌ API error:', e.message);
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }

  if (msg.action === 'solveCaptcha') {
    console.log(TAG, '🔐 Captcha solve requested — calling Groq...');
    const t0 = Date.now();
    solveCaptchaAI(msg.imageData)
      .then(t => {
        console.log(TAG, `🔐 Captcha solved: "${t}" (${Date.now() - t0}ms)`);
        sendResponse({ text: t });
      })
      .catch(e => {
        console.error(TAG, `❌ Captcha failed: ${e.message} (${Date.now() - t0}ms)`);
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (msg.action === 'fetchOtp') {
    // Guard: reject if an OTP request is already in-flight
    if (otpInFlight) {
      console.log(TAG, '📱 OTP request already in-flight — rejecting duplicate');
      sendResponse({ error: 'OTP_IN_FLIGHT' });
      return true;
    }
    otpInFlight = true;
    // Content script passes sinceTs — only OTPs received AFTER this time are valid.
    // Fallback: if not provided, use "now" (strictest).
    const sinceTs = msg.sinceTs || Date.now();
    console.log(TAG, `📱 OTP fetch requested — polling SMS Tracker (accepting OTPs newer than ${new Date(sinceTs).toLocaleTimeString()})`);
    const t0 = Date.now();
    fetchOtpFromSmsTracker(sinceTs)
      .then(otp => {
        console.log(TAG, `📱 OTP received: "${otp}" (${Date.now() - t0}ms)`);
        sendResponse({ otp });
      })
      .catch(e => {
        console.error(TAG, `❌ OTP fetch failed: ${e.message} (${Date.now() - t0}ms)`);
        sendResponse({ error: e.message });
      })
      .finally(() => { otpInFlight = false; });
    return true;
  }

  if (msg.action === 'fetchConfigDetail') {
    console.log(TAG, `📋 Fetching config detail: ${msg.id}`);
    fetch(`https://api.velorapay.in/api/v1/admin/bank-sync/configs/${msg.id}`)
      .then(r => r.json())
      .then(d => {
        console.log(TAG, `📋 Config loaded: ${d.data?.account_name || 'unknown'}`);
        sendResponse({ data: d.data });
      })
      .catch(e => {
        console.error(TAG, '❌ Config fetch error:', e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }
});

async function callAPI(endpoint, payload) {
  const url = `https://api.velorapay.in/api/v1/admin/bank-sync/${endpoint}`;
  console.log(TAG, `→ POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  console.log(TAG, `← ${res.status} ${res.ok ? 'OK' : 'FAIL'}`, JSON.stringify(data).slice(0, 200));
  return { ok: res.ok, status: res.status, data, url, ts: new Date().toISOString() };
}

// ── CAPTCHA solver using Groq (FREE — Llama 4 Scout vision, ~34ms) ───────────
// Get free API key at: https://console.groq.com/keys
// Set it in the extension popup as "Groq API Key"
async function solveCaptchaAI(imageData) {
  const key = await getKey('groqKey');
  if (!key) {
    console.error(TAG, '🔐 No Groq API key set — get one free at console.groq.com/keys');
    throw new Error('NO_KEY');
  }
  console.log(TAG, '🔐 Sending captcha to Groq Llama 4 Scout...');
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  console.log(TAG, `🔐 Image size: ${Math.round(base64Data.length * 0.75 / 1024)}KB`);

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
        { type: 'text', text: 'This is an IDFC bank CAPTCHA. It contains EXACTLY 8 alphanumeric characters (lowercase letters a-z and digits 0-9). Read the characters left to right. Return ONLY those 8 characters — no spaces, no quotes, no explanation, no prefix. If unsure of a character, make your best guess. The output MUST be exactly 8 characters long.' }
      ]}],
      max_tokens: 20,
      temperature: 0
    })
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(TAG, `🔐 Groq API error: ${res.status}`, err.slice(0, 200));
    throw new Error(`Groq ${res.status}: ${err.slice(0, 100)}`);
  }

  const d = await res.json();
  const raw = d.choices?.[0]?.message?.content?.trim() || '';
  let cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  // Enforce 8-char length: trim if too long, log warning if too short
  if (cleaned.length > 8) {
    console.warn(TAG, `🔐 Groq returned ${cleaned.length} chars, trimming to 8: "${cleaned}" → "${cleaned.slice(0, 8)}"`);
    cleaned = cleaned.slice(0, 8);
  } else if (cleaned.length < 8) {
    console.warn(TAG, `🔐 Groq returned only ${cleaned.length} chars (expected 8): "${cleaned}"`);
  }

  console.log(TAG, `🔐 Groq raw: "${raw}" → cleaned: "${cleaned}"`);
  return cleaned;
}

function getKey(k) {
  return new Promise(r => chrome.storage.local.get(k, d => r(d[k] || '')));
}

// ── OTP from BharatEleven SMS Tracker ────────────────────────────────────────
const OTP_PATTERNS = [
  /\botp\b/i, /one.?time.?(password|code|pin)/i, /verification.?code/i,
  /\b\d{4,8}\b.{0,30}(otp|code|pin|password|passcode)/i,
  /(otp|code|pin|password|passcode).{0,30}\b\d{4,8}\b/i,
  /\b\d{4,8}\b.{0,20}(is your|as your)/i,
  /\d{4,8}.{0,10}(expire|valid|expires)/i,
];

async function fetchOtpFromSmsTracker(sinceTs) {
  const cfg = await new Promise(r => chrome.storage.local.get('smsTracker', d => r(d.smsTracker || {})));
  if (!cfg.url || !cfg.email || !cfg.password) {
    throw new Error('SMS Tracker not configured — go to Settings');
  }

  console.log(TAG, `📱 Logging into SMS Tracker: ${cfg.url}`);

  // Step 1: Login to get auth token
  const loginRes = await fetch(`${cfg.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.password })
  });
  if (!loginRes.ok) throw new Error(`SMS Tracker login failed: ${loginRes.status}`);

  // Extract token from set-cookie or response body
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const tokenMatch = setCookie.match(/sms_tracker_token=([^;]+)/);
  let authToken = tokenMatch ? tokenMatch[1] : '';
  if (!authToken) {
    const body = await loginRes.json().catch(() => ({}));
    authToken = body.token || '';
  }
  console.log(TAG, `📱 SMS Tracker authenticated, polling for OTP...`);

  // Step 2: Poll for OTP
  // Strategy: track which OTP message IDs we've already returned (persisted across sessions).
  // Return the first IDFC OTP from the inbox whose ID is NOT in returnedOtpIds.
  // This is clock-skew-proof AND handles the race where OTP arrives before first poll.
  // Staleness is prevented because each message is returned at most once — a previous
  // login attempt's OTP will be in returnedOtpIds and skipped.
  const deadline = Date.now() + 45000;
  let pollCount = 0;

  // Load the set of already-returned OTP IDs (max 200)
  const store = await new Promise(r => chrome.storage.local.get('returnedOtpIds', r));
  const returnedIds = new Set(store.returnedOtpIds || []);
  console.log(TAG, `📱 OTP poll started — ${returnedIds.size} IDs in returned cache`);

  while (Date.now() < deadline) {
    pollCount++;
    try {
      const smsUrl = new URL('/api/sms', cfg.url);
      smsUrl.searchParams.set('limit', '10');
      smsUrl.searchParams.set('direction', 'incoming');
      if (authToken) smsUrl.searchParams.set('token', authToken);

      const fetchHeaders = {};
      if (authToken && tokenMatch) fetchHeaders['Cookie'] = `sms_tracker_token=${authToken}`;

      const res = await fetch(smsUrl.toString(), { headers: fetchHeaders });
      if (!res.ok) throw new Error(`SMS API ${res.status}`);

      const data = await res.json();
      const messages = data.data || data.messages || (Array.isArray(data) ? data : []);

      console.log(TAG, `📱 Poll #${pollCount}: ${messages.length} messages`);

      // Diagnostic: on the first poll, log every message's id/sender/timestamp
      if (pollCount === 1) {
        messages.forEach((m, i) => {
          const id = m.id || m._id || m.uuid || '?';
          const ts = m.received_at || m.created_at || '?';
          const sender = m.sender || '?';
          const bodyPreview = (m.body || '').slice(0, 40).replace(/\n/g, ' ');
          console.log(TAG, `📱   [${i}] id=${id} sender="${sender}" ts=${ts} body="${bodyPreview}"`);
        });
      }

      for (const msg of messages) {
        const id = msg.id || msg._id || msg.uuid;
        if (!id) continue; // can't dedup without an ID
        if (returnedIds.has(id)) continue; // already returned in a previous attempt

        const body = msg.body || '';
        const msgSender = (msg.sender || '').toUpperCase();

        // Filter 1: sender must contain "IDFC"
        if (!msgSender.includes('IDFC')) {
          if (pollCount <= 2) console.log(TAG, `📱 Skip — not IDFC sender: "${msg.sender}"`);
          continue;
        }

        // Filter 2: SIM phone number must match (if configured)
        if (cfg.otpNumber) {
          const filterLast10 = cfg.otpNumber.replace(/\D/g, '').slice(-10);
          const simPhone = (
            msg.sim_numbers?.phone_number ||
            msg.sim_number?.phone_number ||
            msg.phone_number ||
            msg.to || ''
          ).replace(/\D/g, '');
          if (simPhone && filterLast10 && !simPhone.includes(filterLast10)) {
            if (pollCount <= 2) console.log(TAG, `📱 Skip — wrong SIM: ${simPhone} (want *${filterLast10})`);
            continue;
          }
        }

        // Filter 3: must look like an OTP message
        const isOtp = OTP_PATTERNS.some(p => p.test(body));
        if (!isOtp) {
          if (pollCount <= 2) console.log(TAG, `📱 Skip — not OTP: "${body.slice(0, 50)}..."`);
          continue;
        }

        // Extract OTP code
        const codeMatch = body.match(/\b(\d{4,8})\b/);
        if (!codeMatch) continue;

        // Mark as returned (persist so resend attempts + future logins don't re-return it)
        returnedIds.add(id);
        const trimmed = [...returnedIds].slice(-200); // keep last 200
        await new Promise(r => chrome.storage.local.set({ returnedOtpIds: trimmed }, r));

        console.log(TAG, `📱 ✓ Found OTP: ${codeMatch[1]} from "${msg.sender}" (id=${id})`);
        console.log(TAG, `📱 Message: "${body.slice(0, 100)}"`);
        return codeMatch[1];
      }
    } catch (e) {
      console.log(TAG, `📱 Poll #${pollCount} error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 3000)); // poll every 3s
  }

  throw new Error(`OTP timeout — no OTP received within 45s (${pollCount} polls)`);
}
