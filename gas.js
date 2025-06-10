/* ========== SETTING========== */

const NOTION_TOKEN =
  PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN') ||
  (() => { throw new Error('NOTION_TOKEN がありません'); })();
/* ========== ENTRYPOINTS ========== */
function doGet() { return reply('ok'); }
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    if (isOffHours(data.timestamp)) {
      // 1) 軽量タスクだけ実行
      SimpleQueue.enqueue(data);   // 50ms 未満
    }
    return ContentService.createTextOutput('ok'); // 2xx
  } catch (err) {
    debugLog('doPostErr', err);
    return ContentService.createTextOutput('ok'); // 絶対に 200 を返す
  }
}
const SimpleQueue = {
  enqueue(obj) {
    const c = CacheService.getScriptCache();
    const key = 'Q_' + Date.now();
    c.put(key, JSON.stringify(obj), 600); // 最大 10 分保持
    ScriptApp.newTrigger('processQueue').timeBased().after(1).create();
  },
  dequeue() {
    const c = CacheService.getScriptCache();
    c.getKeys().forEach(k => {
      const o = JSON.parse(c.get(k) || '{}');
      if (o.type) { saveEvent(o); }
      c.remove(k);
    });
  }
};
function processQueue() { SimpleQueue.dequeue(); }



function dailyDigest() {
  const rows = getRows(dayStart(-1), dayStart(0));
  if (!rows.length) return;
  const sheetUrl = exportSheet(rows);
  const blocks = buildBlocks(rows, sheetUrl);
  postSlack(blocks);
  pruneAll();
}
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyDigest')
    .timeBased().atHour(CONFIG.REPORT_HOUR).everyDays(1).create();
  debugLog('installTriggers', 'done');
  ScriptApp.newTrigger('notionHealthCheck')
    .timeBased().everyMinutes(30).create();
  // 6 時間毎に paused 状態をチェック
  ScriptApp.newTrigger('resumeWebhookIfPaused')
    .timeBased().everyHours(6).create();
}

/* ========== CORE ========== */
function saveEvent(ev) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  const sheet = getSheet('Events');
  try {
    sheet.appendRow([
      now(),                             // 0: Timestamp
      ev.type || '',                     // 1: Type
      ev.entity?.id || '',               // 2: Page/DB ID
      resolveUser(ev),                   // 3: User Name / Email
      makeNotionUrl(ev.entity?.id)       // 4: URL
    ]);
    debugLog('saveEvent', ev.type);
  } finally { lock.releaseLock(); }
}
function buildBlocks(rows, url) {
  const uniqUsers = [...new Set(rows.map(r => r[3]))];
  const md = uniqUsers.map(u => `• ${u}`).join('\n');
  return [
    { type: 'header', text: { type: 'plain_text', text: '🌙 Off-Hours Digest' } },
    { type: 'section', text: { type: 'mrkdwn', text: md } },
    {
      type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '📄 View Sheet' }, url }
      ]
    }
  ];
}

/* ========== HELPERS ========== */
function resolveUser(ev) {

  if (ev.actor?.name) return ev.actor.name;
  if (ev.actor?.person?.email) return ev.actor.person.email;
  const id = ev.authors?.[0]?.id;
  if (!id) return '(unknown)';
  const cache = CacheService.getScriptCache();
  const key = 'USER_' + id;
  const hit = cache.getProperty(key);
  if (hit) return hit;
  try {
    const res = UrlFetchApp.fetch(
      `https://api.notion.com/v1/users/${id}`,
      {
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28', muteHttpExceptions: true
        }
      }
    );
    if (res.getResponseCode() !== 200) throw new Error();
    const j = JSON.parse(res.getContentText() || '{}');
    const name = j.name || j.person?.email || id;
    cache.put(id, name, CACHE_HOURS * 3600);                  // キャッシュ
    return name;
  } catch (e) {
    debugLog('resolveUserErr', e);
    return '(unknown)';                                 // 失敗時フォールバック
  }
}
const makeNotionUrl = id => id ? `https://www.notion.so/${id.replace(/-/g, '')}` : '';

function isOffHours(ts) {
  const d = ts ? new Date(ts) : new Date();
  const h = d.getHours(), w = d.getDay();
  return (h >= 20 || h < 9) || w === 0 || w === 6 || isHoliday(d);
}
function isHoliday(d) {
  const key = 'HOLI_' + Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
  const cache = PropertiesService.getScriptProperties();
  const hit = cache.getProperty(key);
  if (hit !== null) return hit === '1';
  const ev = Calendar.Events.list(
    'ja.japanese#holiday@group.v.calendar.google.com',
    { timeMin: d.toISOString(), timeMax: new Date(d.getTime() + 86400000).toISOString(), maxResults: 1, singleEvents: true });
  const hol = !!(ev.items && ev.items.length);
  cache.setProperty(key, hol ? '1' : '0');
  return hol;
}

function getRows(from, to) {
  return getSheet('Events').getDataRange().getValues()
    .filter(r => { const t = new Date(r[0]); return t >= from && t < to; });
}
function exportSheet(rows) {
  const file = SpreadsheetApp.create(
    'OffHours_' + Utilities.formatDate(dayStart(-1), TIMEZONE, 'yyyyMMdd_HHmm'));
  file.getSheets()[0].getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  return file.getUrl();
}

/* ---- Slack & Log ---- */
function postSlack(blocks) {
  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: `Bearer ${CONFIG.SLACK_BOT_TOKEN}` },
    payload: JSON.stringify({ channel: CONFIG.SLACK_CHANNEL, blocks })
  }).getContentText();
  logSlack('response', res);
}
function logSlack(phase, msg) {
  const sh = getSheet('SlackLogs');
  sh.appendRow([now(), 'INFO', phase, msg.slice(0, 2000)]);
  prune(sh);
}
function debugLog(label, obj) {
  if (!CONFIG.DEBUG) return;
  const sh = getSheet('DebugLogs');
  sh.appendRow([now(), label, JSON.stringify(obj).slice(0, 2000)]);
  prune(sh);
}

/* ---- Sheet helpers ---- */
function getSheet(name) {
  const id = ensureSheetId(); const ss = SpreadsheetApp.openById(id);
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function ensureSheetId() {
  const prop = PropertiesService.getScriptProperties();
  let id = prop.getProperty('SPREADSHEET_ID');
  if (!id) { id = SpreadsheetApp.create('Notion_OffHours_Logs').getId(); prop.setProperty('SPREADSHEET_ID', id); }
  return id;
}
function prune(sh) { if (sh.getLastRow() > 2000) sh.deleteRows(2, 1000); }
function pruneAll() { ['Events', 'DebugLogs', 'SlackLogs'].forEach(n => prune(getSheet(n))); }

/* ---- Misc helpers ---- */
const now = () => Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
function dayStart(off) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d; }
function reply(t) { return ContentService.createTextOutput(t); }

/* ---- Test Harness ---- */
function testDoPostNight() {
  const p = {
    timestamp: '2025-01-01T22:30:00.000Z',
    type: 'page.content_updated',
    entity: { id: 'test-page-id' }, authors: [{ id: '4489d9c5-b8a5-49c3-a81e-4a282c5c3bed' }]
  };
  doPost({ postData: { contents: JSON.stringify(p) } });
}
/* == Health Check == */
function notionHealthCheck() {
  const url = 'https://api.notion.com/v1/users/me';
  const res = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true       // ← 必須
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    const body = res.getContentText().slice(0, 300);
    postSlack([{
      type: 'section', text: {
        type: 'mrkdwn',
        text: `*:warning: Notion API 健康チェック失敗*\nStatus: ${code}\n\`\`\`${body}\`\`\``
      }
    }]);
  }
}

/* == Resume webhook if paused == */
const WEBHOOK_ID = '553f889d-649b-47f9-bc41-db9748ad8fc1'; // ★自分の ID に置換

function resumeWebhookIfPaused() {
  const endpoint = `https://api.notion.com/v1/webhooks/${WEBHOOK_ID}`;
  const common = {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
    muteHttpExceptions: true
  };

  const statusRes = UrlFetchApp.fetch(endpoint, common);
  if (statusRes.getResponseCode() !== 200) return;          // 取得失敗は無視

  const paused = JSON.parse(statusRes).paused;
  if (!paused) return;                                      // 稼働中なら何もしない

  const patchRes = UrlFetchApp.fetch(endpoint, {
    ...common,
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify({ paused: false })
  });
  if (patchRes.getResponseCode() === 200) {
    postSlack([{
      type: 'section', text: {
        type: 'mrkdwn',
        text: `*:arrow_forward: Notion Webhook を自動再開しました*`
      }
    }]);
  }
}
