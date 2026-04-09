// VeloraPay IDFC Merchant Extension — Background
const IDFC_URL = 'https://merchant.phi.idfcbank.com/upi-merchant/main/transactions';
const ALARM = 'vp-sync';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.667 }); // 40s
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  chrome.tabs.query({ url: 'https://merchant.phi.idfcbank.com/*' }, tabs => {
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { action: 'alarmTick' }).catch(() => {}));
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openIDFC') {
    chrome.tabs.query({ url: 'https://merchant.phi.idfcbank.com/*' }, tabs => {
      if (tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
      else chrome.tabs.create({ url: IDFC_URL });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.action === 'postAPI') {
    callAPI(msg.endpoint, msg.payload)
      .then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'solveCaptcha') {
    solveCaptchaAI(msg.imageData).then(t => sendResponse({ text: t })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.action === 'fetchConfigDetail') {
    fetch(`https://api.velorapay.in/api/v1/admin/bank-sync/configs/${msg.id}`)
      .then(r => r.json()).then(d => sendResponse({ data: d.data })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

async function callAPI(endpoint, payload) {
  const url = `https://api.velorapay.in/api/v1/admin/bank-sync/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, url, ts: new Date().toISOString() };
}

// ── CAPTCHA solver using Claude Haiku (~$0.0002 per call) ────────────────────
async function solveCaptchaAI(imageData) {
  const key = await getKey('anthropicKey');
  if (!key) throw new Error('NO_KEY');
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
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
    throw new Error(`AI ${res.status}: ${err.slice(0, 100)}`);
  }
  const d = await res.json();
  const raw = d.content[0].text.trim();
  // Clean: keep only alphanumeric, lowercase
  return raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function getKey(k) {
  return new Promise(r => chrome.storage.local.get(k, d => r(d[k] || '')));
}
