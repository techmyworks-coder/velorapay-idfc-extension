// VeloraPay IDFC Merchant Extension — Popup v3

const API = 'https://api.velorapay.in/api/v1/admin/bank-sync';
let configs = [];
let countdown = 40;
let logFilter = 'all';
let activityMessages = [];
let activityIdx = 0;

// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupButtons();
  await loadConfigs();
  loadSettings();
  restoreStats();
  pollAll();
  startCountdown();
  startActivityTicker();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab,.panel').forEach(e => e.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('tab-' + t.dataset.tab)?.classList.add('active');
      if (t.dataset.tab === 'logs') renderLogs();
      if (t.dataset.tab === 'api') renderApiLogs();
    });
  });
}

// ── Buttons ───────────────────────────────────────────────────────────────────
function setupButtons() {
  document.getElementById('btnGo').addEventListener('click', openIDFC);
  document.getElementById('btnOpen').addEventListener('click', openIDFC);
  document.getElementById('btnForce').addEventListener('click', forceSync);
  document.getElementById('btnReload').addEventListener('click', reloadTab);
  document.getElementById('btnClearLog').addEventListener('click', () => { chrome.storage.local.set({ syncLog: [] }); renderLogs(); });
  document.getElementById('btnClearApi').addEventListener('click', () => { chrome.storage.local.set({ apiLogs: [] }); renderApiLogs(); });
  document.getElementById('btnSaveKey').addEventListener('click', saveKey);
  document.getElementById('btnSaveInterval').addEventListener('click', saveInterval);

  document.querySelectorAll('.filter-btn[data-filter]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-filter]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      logFilter = b.dataset.filter;
      renderLogs();
    });
  });

  ['togAutoFill','togCaptcha','togFilter','togPerPage'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveToggles);
  });
}

function openIDFC() {
  chrome.runtime.sendMessage({ action: 'openIDFC' });
}

function forceSync() {
  chrome.tabs.query({ url: 'https://merchant.phi.idfcbank.com/*' }, tabs => {
    if (!tabs.length) { openIDFC(); return; }
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { action: 'forceSync' }).catch(() => {}));
    setStatus('syncing', 'Force sync triggered...');
    countdown = 30;
  });
}

function reloadTab() {
  chrome.tabs.query({ url: 'https://merchant.phi.idfcbank.com/*' }, tabs => {
    if (tabs.length) chrome.tabs.reload(tabs[0].id);
    else openIDFC();
  });
}

// ── Load configs ──────────────────────────────────────────────────────────────
async function loadConfigs() {
  try {
    const r = await fetch(`${API}/configs`);
    const j = await r.json();
    configs = (j.data || []).filter(c => c.login_username);
    const sel = document.getElementById('sel');
    if (!configs.length) { sel.innerHTML = '<option>No IDFC accounts found</option>'; return; }
    sel.innerHTML = '<option value="">— Select account —</option>' +
      configs.map(c => `<option value="${c.id}">${c.bank_name} · ${c.account_name}</option>`).join('');
    sel.addEventListener('change', onSelect);
    chrome.storage.local.get('selectedId', d => {
      if (d.selectedId) { sel.value = d.selectedId; onSelect(); }
    });
  } catch (e) {
    document.getElementById('sel').innerHTML = `<option>Error: ${e.message}</option>`;
  }
}

async function onSelect() {
  const id = document.getElementById('sel').value;
  const chip = document.getElementById('acctChip');
  if (!id) { chip.classList.remove('show'); chrome.storage.local.remove(['selectedId', 'cachedCfg', 'cachedCfgId']); return; }
  chrome.storage.local.set({ selectedId: id, cachedCfg: null, cachedCfgId: null });
  const c = configs.find(x => x.id === id);
  if (c) {
    document.getElementById('chipName').textContent = c.account_name;
    document.getElementById('chipMeta').textContent = `${c.bank_name}  ·  ${c.account_type}`;
    document.getElementById('chipAcct').textContent = c.account_number;
    document.getElementById('chipUser').textContent = c.login_username;
    chip.classList.add('show');
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettings() {
  chrome.storage.local.get(['anthropicKey','syncInterval','toggles'], d => {
    if (d.anthropicKey) document.getElementById('inpKey').value = d.anthropicKey;
    if (d.syncInterval) document.getElementById('inpInterval').value = d.syncInterval;
    if (d.toggles) {
      ['togAutoFill','togCaptcha','togFilter','togPerPage'].forEach(id => {
        if (d.toggles[id] !== undefined) document.getElementById(id).checked = d.toggles[id];
      });
    }
  });
}

function saveKey() {
  const v = document.getElementById('inpKey').value.trim();
  chrome.storage.local.set({ anthropicKey: v });
  flash('btnSaveKey', '✓ Saved');
}

function saveInterval() {
  const v = parseInt(document.getElementById('inpInterval').value) || 30;
  chrome.storage.local.set({ syncInterval: v });
  flash('btnSaveInterval', '✓ Saved');
}

function saveToggles() {
  const t = {};
  ['togAutoFill','togCaptcha','togFilter','togPerPage'].forEach(id => { t[id] = document.getElementById(id).checked; });
  chrome.storage.local.set({ toggles: t });
}

// ── Poll everything every 2s ──────────────────────────────────────────────────
function pollAll() {
  chrome.storage.local.get(['syncStatus','syncStats','syncLog','apiLogs'], d => {
    if (d.syncStatus) applyStatus(d.syncStatus);
    if (d.syncStats) applyStats(d.syncStats);
    // refresh active tab
    const active = document.querySelector('.tab.active')?.dataset.tab;
    if (active === 'logs') renderLogs(d.syncLog);
    if (active === 'api') renderApiLogs(d.apiLogs);
  });
  setTimeout(pollAll, 2000);
}

function restoreStats() {
  chrome.storage.local.get('syncStats', d => { if (d.syncStats) applyStats(d.syncStats); });
}

function applyStatus({ type, msg }) { setStatus(type, msg); }

function setStatus(type, msg) {
  const dot = document.getElementById('scDot');
  const state = document.getElementById('scState');
  const scMsg = document.getElementById('scMsg');
  const dotColors = { ok: 'green', syncing: 'yellow', error: 'red', idle: 'green' };
  const labels = { ok: 'Synced', syncing: 'Syncing...', error: 'Error', idle: 'Monitoring' };
  dot.className = 'sc-dot ' + (dotColors[type] || '');
  state.textContent = labels[type] || 'Monitoring';
  scMsg.textContent = msg || '';
}

function applyStats(s) {
  document.getElementById('stSynced').textContent = s.synced ?? 0;
  document.getElementById('stAmt').textContent = `₹${fmt(s.amt ?? 0)}`;
  document.getElementById('stCycles').textContent = s.cycles ?? 0;
  document.getElementById('stErrors').textContent = s.errors ?? 0;
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown() {
  setInterval(() => {
    countdown = Math.max(0, countdown - 1);
    if (countdown === 0) countdown = 40;
    document.getElementById('countdown').textContent = countdown;
  }, 1000);
}

// ── Activity ticker (every 5s) ────────────────────────────────────────────────
const ACTIVITY_MSGS = [
  '⟳ Monitoring IDFC UPI transactions...',
  '📡 Listening for incoming payments...',
  '🔍 Scanning transaction history...',
  '⚡ Auto-sync engine running...',
  '📊 Aggregating payment data...',
  '🔄 Ready to sync next batch...',
  '💳 Watching UPI collect flow...',
  '🛡 VeloraPay guard active...',
];

function startActivityTicker() {
  const el = document.getElementById('activityText');
  setInterval(() => {
    chrome.storage.local.get(['syncStatus','syncStats'], d => {
      if (d.syncStatus?.type === 'syncing') {
        el.textContent = '⟳ Syncing transactions to VeloraPay...';
        return;
      }
      if (d.syncStats?.lastSync) {
        ACTIVITY_MSGS[0] = `✓ Last sync: ${d.syncStats.lastSync}  ·  ${d.syncStats.synced ?? 0} total`;
      }
      activityIdx = (activityIdx + 1) % ACTIVITY_MSGS.length;
      el.textContent = ACTIVITY_MSGS[activityIdx];
    });
  }, 5000);
}

// ── Render Logs ───────────────────────────────────────────────────────────────
function renderLogs(logs) {
  if (!logs) { chrome.storage.local.get('syncLog', d => renderLogs(d.syncLog || [])); return; }
  const filtered = logFilter === 'all' ? logs : logs.filter(l => l.level === logFilter);
  const icons = { ok: '✓', error: '✗', warn: '⚠', info: '·' };
  const el = document.getElementById('logScroll');
  if (!filtered.length) { el.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:12px;text-align:center;">No logs yet</div>'; return; }
  el.innerHTML = filtered.map(l => `
    <div class="log-line">
      <span class="log-ts">${l.ts}</span>
      <span class="log-icon">${icons[l.level] || '·'}</span>
      <span class="log-msg ${l.level}">${esc(l.msg)}</span>
    </div>`).join('');
}

// ── Render API Logs ───────────────────────────────────────────────────────────
function renderApiLogs(logs) {
  if (!logs) { chrome.storage.local.get('apiLogs', d => renderApiLogs(d.apiLogs || [])); return; }
  const el = document.getElementById('apiList');
  if (!logs.length) { el.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:16px;text-align:center;">No API calls yet</div>'; return; }
  el.innerHTML = logs.map((l, i) => `
    <div class="api-entry" id="api-${i}">
      <div class="api-entry-head" onclick="toggleApi(${i})">
        <span class="api-badge ${l.ok ? 'ok' : 'err'}">${l.status || (l.ok ? '200' : 'ERR')}</span>
        <span class="api-ts">${l.ts}</span>
        <span class="api-summary">${l.count} txn${l.count !== 1 ? 's' : ''} · ₹${fmt(l.amt || 0)} ${l.ok ? '✓' : '✗'}</span>
      </div>
      <div class="api-body">
        <div class="api-section">
          <div class="api-section-title">UTRs Sent (${(l.request?.utrs || []).length})</div>
          <div class="api-utr-list">${(l.request?.utrs || []).map(u => `<span class="utr-tag">${esc(u)}</span>`).join('') || '<span style="color:var(--text3);font-size:10px;">none</span>'}</div>
        </div>
        <div class="api-section">
          <div class="api-section-title">API Response</div>
          <div class="api-code">${esc(JSON.stringify(l.response, null, 2))}</div>
        </div>
      </div>
    </div>`).join('');
}

window.toggleApi = (i) => {
  document.getElementById('api-' + i)?.classList.toggle('open');
};

// ── Utils ─────────────────────────────────────────────────────────────────────
function fmt(n) { return (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function flash(id, text) {
  const b = document.getElementById(id); if (!b) return;
  const orig = b.textContent; b.textContent = text;
  setTimeout(() => b.textContent = orig, 1800);
}
