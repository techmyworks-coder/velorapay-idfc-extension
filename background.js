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
    console.log(TAG, `⏰ Found ${tabs.length} IDFC tab(s)${tabs.length ? ': ' + tabs.map(t => `[id:${t.id} url:${t.url.split('/').pop()}]`).join(' ') : ''}`);
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, { action: 'alarmTick' })
        .then(() => console.log(TAG, `⏰ Tab ${t.id} responded OK`))
        .catch(e => console.log(TAG, `⏰ Tab ${t.id} unreachable: ${e.message}`));
    });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const from = sender.tab ? `tab:${sender.tab.id}` : 'popup';

  // Forward content script logs to service worker console
  if (msg.action === 'log') {
    const icon = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' }[msg.level] || '📋';
    console.log(TAG, `${icon} [Content][${msg.level}] ${msg.msg}`);
    return; // no response needed
  }

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
    const txnCount = msg.payload?.transactions?.length || 0;
    const totalAmt = msg.payload?.transactions?.reduce((s, t) => s + (t.amount || 0), 0) || 0;
    console.log(TAG, `📤 POST /${msg.endpoint} — ${txnCount} txns, ₹${totalAmt.toFixed(2)}`);
    if (txnCount > 0) {
      msg.payload.transactions.forEach((t, i) => {
        console.log(TAG, `📤   [${i}] uid=${t.uid} txn_id=${t.transaction_id} ₹${t.amount} ${t.payer_vpa || ''}`);
      });
    }
    callAPI(msg.endpoint, msg.payload)
      .then(r => {
        console.log(TAG, `📥 API response: ${r.status} ${r.ok ? '✓' : '✗'}`, JSON.stringify(r.data).slice(0, 300));
        sendResponse(r);
      })
      .catch(e => {
        console.error(TAG, '❌ API error:', e.message);
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }

  if (msg.action === 'solveCaptcha') {
    console.log(TAG, '🔐 Captcha solve requested — trying Groq → Gemini...');
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
      console.warn(TAG, '📱 OTP request already in-flight — rejecting duplicate');
      sendResponse({ error: 'OTP_IN_FLIGHT' });
      return true;
    }
    otpInFlight = true;
    const sinceTs = msg.sinceTs || Date.now();
    console.log(TAG, `📱 ── OTP FETCH START ──`);
    console.log(TAG, `📱 sinceTs: ${new Date(sinceTs).toLocaleTimeString()} (${sinceTs})`);
    console.log(TAG, `📱 Deadline: 45s from now`);
    const t0 = Date.now();
    fetchOtpFromSmsTracker(sinceTs)
      .then(otp => {
        console.log(TAG, `📱 ── OTP FETCH SUCCESS ── "${otp}" (${Date.now() - t0}ms)`);
        sendResponse({ otp });
      })
      .catch(e => {
        console.error(TAG, `📱 ── OTP FETCH FAILED ── ${e.message} (${Date.now() - t0}ms)`);
        sendResponse({ error: e.message });
      })
      .finally(() => {
        otpInFlight = false;
        console.log(TAG, `📱 otpInFlight reset to false`);
      });
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

// ── CAPTCHA solver: Groq primary (raw image, fast) → Gemini fallback ──
// Groq: free at console.groq.com — Llama 4 Scout vision model
// Gemini: free at aistudio.google.com/apikey — Gemini 2.5 Flash
//
// Strategy:
// - Try Groq first (faster, no preprocessing needed on raw images)
// - 3x sampling with majority vote on each provider
// - If Groq fails or has no key, fall back to Gemini
// - Only accept samples that return exactly 8 alnum chars

const CAPTCHA_PROMPT = 'This is an 8-character alphanumeric CAPTCHA from an IDFC bank login page. It contains ONLY lowercase letters (a-z) and digits (0-9). Read the characters from left to right. Return ONLY the 8 characters. No spaces, no quotes, no explanation, no prefixes or suffixes. The output must be EXACTLY 8 characters — not 7, not 9. If unsure about a character, use your best guess. Common confusions to avoid: 9 vs g, 1 vs l vs i, 0 vs o, 5 vs s.';
const CAPTCHA_MAX_SAMPLES = 3;

// Provider configs
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const GEMINI_MODEL = 'gemini-2.5-flash';

async function solveCaptchaAI(imageData) {
  const groqKey = await getKey('groqKey');
  const geminiKey = await getKey('geminiKey');

  if (!groqKey && !geminiKey) {
    console.error(TAG, '🔐 No API keys set — add Groq or Gemini key in settings');
    throw new Error('NO_KEY');
  }

  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  console.log(TAG, `🔐 Captcha: ${Math.round(base64Data.length * 0.75 / 1024)}KB`);

  // Try Groq first (raw image — no preprocessing)
  if (groqKey) {
    console.log(TAG, '🔐 Trying Groq (Llama 4 Scout)...');
    try {
      const result = await sampleWithMajorityVote(
        () => callGroqVision(base64Data, groqKey), 'Groq'
      );
      if (result) return result;
    } catch (e) {
      console.warn(TAG, `🔐 Groq failed: ${e.message}`);
    }
  }

  // Fallback to Gemini
  if (geminiKey) {
    console.log(TAG, '🔐 Falling back to Gemini 2.5 Flash...');
    try {
      const result = await sampleWithMajorityVote(
        () => callGeminiVision(base64Data, geminiKey), 'Gemini'
      );
      if (result) return result;
    } catch (e) {
      console.warn(TAG, `🔐 Gemini failed: ${e.message}`);
    }
  }

  throw new Error('All captcha providers failed');
}

// Sample a provider up to CAPTCHA_MAX_SAMPLES times, return majority or first valid
async function sampleWithMajorityVote(callFn, providerName) {
  const samples = [];
  let firstValid = null;

  for (let i = 1; i <= CAPTCHA_MAX_SAMPLES; i++) {
    try {
      const raw = await callFn();
      const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const valid = cleaned.length === 8;
      console.log(TAG, `🔐 [${providerName}] Sample ${i}/${CAPTCHA_MAX_SAMPLES}: raw="${raw}" clean="${cleaned}" ${valid ? '✓' : `✗ (${cleaned.length} chars)`}`);

      if (!valid) continue;

      samples.push(cleaned);
      if (!firstValid) firstValid = cleaned;

      // Majority vote: 2+ agreeing → return immediately
      const counts = {};
      for (const s of samples) counts[s] = (counts[s] || 0) + 1;
      const winner = Object.entries(counts).find(([, c]) => c >= 2);
      if (winner) {
        console.log(TAG, `🔐 [${providerName}] ✓ Majority vote (${winner[1]}/${samples.length}): "${winner[0]}"`);
        return winner[0];
      }
    } catch (e) {
      console.error(TAG, `🔐 [${providerName}] Sample ${i} error: ${e.message}`);
    }
  }

  if (firstValid) {
    console.log(TAG, `🔐 [${providerName}] No majority — using first valid: "${firstValid}"`);
    return firstValid;
  }

  console.warn(TAG, `🔐 [${providerName}] All ${CAPTCHA_MAX_SAMPLES} samples failed`);
  return null;
}

// ── Groq vision API (OpenAI-compatible) ──
async function callGroqVision(base64Data, key) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
          { type: 'text', text: CAPTCHA_PROMPT }
        ]
      }],
      temperature: 0.2,
      max_tokens: 20,
    })
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${err.slice(0, 120)}`);
  }

  const d = await res.json();
  return (d.choices?.[0]?.message?.content || '').trim();
}

// ── Gemini vision API ──
async function callGeminiVision(base64Data, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/png', data: base64Data } },
          { text: CAPTCHA_PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 20,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 120)}`);
  }

  const d = await res.json();
  const parts = d.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
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

  console.log(TAG, `📱 SMS Tracker config: url=${cfg.url} email=${cfg.email} otpNumber=${cfg.otpNumber || 'any'}`);
  console.log(TAG, `📱 Logging into SMS Tracker...`);

  // Step 1: Login to get auth token
  const loginRes = await fetch(`${cfg.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.password })
  });
  if (!loginRes.ok) {
    const errBody = await loginRes.text().catch(() => '');
    console.error(TAG, `📱 SMS Tracker login failed: ${loginRes.status} — ${errBody.slice(0, 150)}`);
    throw new Error(`SMS Tracker login failed: ${loginRes.status}`);
  }

  // Extract token from set-cookie or response body
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const tokenMatch = setCookie.match(/sms_tracker_token=([^;]+)/);
  let authToken = tokenMatch ? tokenMatch[1] : '';
  if (!authToken) {
    const body = await loginRes.json().catch(() => ({}));
    authToken = body.token || '';
  }
  console.log(TAG, `📱 SMS Tracker authenticated (token: ${authToken ? authToken.slice(0, 8) + '...' : 'none'}), polling for OTP...`);

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

      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      console.log(TAG, `📱 Poll #${pollCount}: ${messages.length} messages (${remaining}s remaining)`);

      // Log every message on first 3 polls for visibility
      if (pollCount <= 3) {
        messages.forEach((m, i) => {
          const id = m.id || m._id || m.uuid || '?';
          const ts = m.received_at || m.created_at || '?';
          const sender = m.sender || '?';
          const bodyPreview = (m.body || '').slice(0, 60).replace(/\n/g, ' ');
          const alreadyReturned = returnedIds.has(id) ? ' [ALREADY RETURNED]' : '';
          console.log(TAG, `📱   [${i}] id=${id} sender="${sender}" ts=${ts}${alreadyReturned} body="${bodyPreview}"`);
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
          if (pollCount <= 3) console.log(TAG, `📱   Skip id=${id} — not IDFC sender: "${msg.sender}"`);
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
            console.log(TAG, `📱   Skip id=${id} — wrong SIM: ${simPhone} (want *${filterLast10})`);
            continue;
          }
        }

        // Filter 3: must look like an OTP message
        const isOtp = OTP_PATTERNS.some(p => p.test(body));
        if (!isOtp) {
          if (pollCount <= 3) console.log(TAG, `📱   Skip id=${id} — not OTP pattern: "${body.slice(0, 60)}..."`);
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
