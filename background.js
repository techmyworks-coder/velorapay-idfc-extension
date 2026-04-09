// VeloraPay IDFC Merchant Extension — Background
const IDFC_URL = 'https://merchant.phi.idfcbank.com/upi-merchant/main/transactions';
const ALARM = 'vp-sync';
const TAG = '[VeloraPay BG]';

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
    console.log(TAG, '🔐 Captcha solve requested — calling Haiku...');
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

// ── CAPTCHA solver using Claude Haiku (~$0.0002 per call) ────────────────────
async function solveCaptchaAI(imageData) {
  const key = await getKey('anthropicKey');
  if (!key) {
    console.error(TAG, '🔐 No Anthropic API key set — cannot solve captcha');
    throw new Error('NO_KEY');
  }
  console.log(TAG, '🔐 Sending captcha to Claude Haiku...');
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  console.log(TAG, `🔐 Image size: ${Math.round(base64Data.length * 0.75 / 1024)}KB`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Data } },
        { type: 'text', text: 'Read this CAPTCHA image. The characters are alphanumeric (lowercase letters and digits) placed at varying vertical positions with different colors. Return ONLY the exact characters left to right, no spaces, no punctuation, no explanation.' }
      ]}]
    })
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(TAG, `🔐 Haiku API error: ${res.status}`, err.slice(0, 200));
    throw new Error(`AI ${res.status}: ${err.slice(0, 100)}`);
  }

  const d = await res.json();
  const raw = d.content[0].text.trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  console.log(TAG, `🔐 Haiku raw: "${raw}" → cleaned: "${cleaned}"`);
  return cleaned;
}

function getKey(k) {
  return new Promise(r => chrome.storage.local.get(k, d => r(d[k] || '')));
}
