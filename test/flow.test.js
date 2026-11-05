// 端到端流程測試：用記憶體假試算表 + 假 LINE API 跑整套 Apps Script 程式。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEnv(clock) {
  const sheets = {};
  function makeSheet(name) {
    const rows = [];
    return {
      rows,
      getName: () => name,
      getLastRow: () => rows.length,
      getLastColumn: () => Math.max(0, ...rows.map((r) => r.length)),
      getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
      appendRow: (r) => rows.push(r.slice()),
      setFrozenRows() {},
      getRange(a, b, c, d) {
        const api = {
          setValues(vals) { vals.forEach((v, i) => { rows[a - 1 + i] = v.slice(); }); return api; },
          getValues: () => rows.slice(a - 1, a - 1 + c).map((r) => r.slice(b - 1, b - 1 + d)),
          setFontWeight: () => api, setNumberFormat: () => api, setDataValidation: () => api
        };
        return api;
      }
    };
  }
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    toast() {}
  };
  const pushes = [];
  const replies = [];
  const fmt = (d, tz, pattern) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(d).map((x) => [x.type, x.value]));
    const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
    return {
      'yyyy-MM-dd': `${p.year}-${p.month}-${p.day}`, 'yyyy-MM-dd HH:mm': `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
      'HH:mm': `${p.hour}:${p.minute}`, 'H:mm': `${Number(p.hour)}:${p.minute}`,
      u: String(u), H: String(Number(p.hour)), m: String(Number(p.minute))
    }[pattern];
  };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
  }
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date: FakeDate,
    SpreadsheetApp: {
      getActive: () => ss,
      newDataValidation: () => { const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) }; return b; }
    },
    Utilities: { formatDate: fmt },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => ({ LINE_CHANNEL_ACCESS_TOKEN: 'tok' })[k] || null }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; } })
    },
    UrlFetchApp: {
      fetch(url, opt) {
        if (url.includes('/oauth2/v2.1/verify')) {
          const ok = opt.payload.client_id === '1234' && opt.payload.id_token.startsWith('tok-');
          return { getResponseCode: () => (ok ? 200 : 400), getContentText: () => JSON.stringify({ sub: opt.payload.id_token.slice(4), name: 'N' }) };
        }
        if (url.includes('/message/push')) {
          pushes.push(JSON.parse(opt.payload));
          return { getResponseCode: () => 200, getContentText: () => '{}' };
        }
        if (url.includes('/message/reply')) {
          replies.push(JSON.parse(opt.payload).messages[0].text);
          return { getResponseCode: () => 200, getContentText: () => '{}' };
        }
        if (url.includes('/profile/')) return { getResponseCode: () => 200, getContentText: () => '{"displayName":"新朋友"}' };
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      }
    }
  };
  vm.createContext(ctx);
  for (const f of ['Logic', 'Sheets', 'Line', 'Main', 'Notify', 'Contact']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../gas/${f}.gs`), 'utf8'), ctx);
  }
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, sheets, pushes, replies, call };
}

const T = (hm) => new Date(`2026-09-29T${hm}:00+08:00`).getTime(); // 2026-09-29 是星期二

test('完整流程：簽到失敗 → 未到通知 → 補簽 → 已到通知 → 老師看板與代簽', () => {
  const clock = { now: T('18:10') };
  const { ctx, sheets, pushes, call } = makeEnv(clock);
  ctx.setupSheets();
  const settings = sheets['設定'].rows;
  settings.find((r) => r[0] === 'LINE Login Channel ID')[1] = '1234';
  settings.find((r) => r[0] === '補習班名稱')[1] = '測試補習班';
  sheets['LINE好友'].rows.push(
    ['U_stu', '小明', '學生', 'S001'], ['U_stu2', '小華', '學生', 'S002'],
    ['U_mom', '明媽', '家長', 'S001'], ['U_dad', '明爸', '家長', 'S001，S009'], ['U_tea', '王老師', '老師', '']
  );
  sheets['學生'].rows.push(['S001', '王小明', 'A班', '在學'], ['S002', '陳小華', 'A班', '在學'], ['S003', '林小美', 'A班', '在學'], ['S004', '離班生', 'A班', '離班']);
  sheets['課表'].rows.push(['M1', '數學', 'A班', '二', '18:30', '20:30', '教室', '22.0019', '120.7445', '80']);
  sheets['請假'].rows.push(['2026/9/29', 'S003', '', '生病']);

  // 驗證失敗
  assert.strictEqual(call({ action: 'me', idToken: 'bad' }).ok, false);

  // 未配對的人打開 LIFF → 自動加入 LINE好友
  const stranger = call({ action: 'me', idToken: 'tok-U_new' });
  assert.strictEqual(stranger.role, '');
  assert.ok(sheets['LINE好友'].rows.some((r) => r[0] === 'U_new'));

  // 18:10 還沒開放（提前 15 分鐘）
  assert.match(call({ action: 'checkin', idToken: 'tok-U_stu', lat: 22.0019, lng: 120.7445, accuracy: 10 }).message, /不是你的簽到時間/);

  // 18:20 小華準時簽到；小明在太遠的地方
  clock.now = T('18:20');
  const me = call({ action: 'me', idToken: 'tok-U_stu' });
  assert.strictEqual(me.courses[0].status, '未簽到');
  assert.strictEqual(call({ action: 'checkin', idToken: 'tok-U_stu2', lat: 22.0019, lng: 120.7445, accuracy: 10 }).status, '準時');
  assert.match(call({ action: 'checkin', idToken: 'tok-U_stu2', lat: 22.0019, lng: 120.7445, accuracy: 10 }).message, /已經在/);
  assert.match(call({ action: 'checkin', idToken: 'tok-U_stu', lat: 22.01, lng: 120.7445, accuracy: 10 }).message, /超出簽到範圍/);
  assert.strictEqual(call({ action: 'checkin', idToken: 'tok-U_mom', lat: 22.0019, lng: 120.7445 }).ok, false, '家長不能簽到');

  // 18:39 還不到通知時間
  clock.now = T('18:39');
  ctx.checkAbsences();
  assert.strictEqual(pushes.length, 0);

  // 18:40 先傳一則彙整名單給老師；家長還不通知。請假的小美、準時的小華、離班生不在名單內
  clock.now = T('18:40');
  assert.strictEqual(ctx.checkAbsences(), 1);
  assert.deepStrictEqual(pushes.map((p) => p.to), ['U_tea']);
  assert.doesNotMatch(String(sheets['通知紀錄'].rows.at(-1)[2]), /,/, '學號不可用逗號分隔（會被試算表當成數字）');
  assert.match(pushes[0].messages[0].text, /未到 1 人：王小明/);
  assert.match(pushes[0].messages[0].text, /請假 1 人：林小美/);
  assert.strictEqual(ctx.checkAbsences(), 0, '同一堂課只傳一次給老師');
  assert.strictEqual(pushes.length, 1);

  // 看板顯示未到、尚未通知家長
  let board = call({ action: 'me', idToken: 'tok-U_tea' }).dashboard.courses[0].students;
  assert.strictEqual(board.find((s) => s.id === 'S001').parentNotified, '');

  // 學生不能通知家長；老師確認後按「通知家長」→ 兩位家長收到
  assert.strictEqual(call({ action: 'notifyParents', idToken: 'tok-U_stu', courseId: 'M1', studentIds: ['S001'] }).ok, false);
  clock.now = T('18:42');
  const np = call({ action: 'notifyParents', idToken: 'tok-U_tea', courseId: 'M1', studentIds: ['S001', 'S002', 'S003'] });
  assert.match(np.message, /已通知 1 位/, '準時的小華、請假的小美不會被通知');
  assert.deepStrictEqual(pushes.slice(1).map((p) => p.to).sort(), ['U_dad', 'U_mom']);
  assert.match(pushes[1].messages[0].text, /王小明.*尚未簽到/);
  assert.strictEqual(np.dashboard.courses[0].students.find((s) => s.id === 'S001').parentNotified, '18:42');
  assert.match(call({ action: 'notifyParents', idToken: 'tok-U_tea', courseId: 'M1', studentIds: ['S001'] }).message, /已通知過/);
  assert.strictEqual(pushes.length, 3);

  // 18:45 小明到了 → 遲到 → 家長收到「已到」
  clock.now = T('18:45');
  const res = call({ action: 'checkin', idToken: 'tok-U_stu', lat: 22.0020, lng: 120.7446, accuracy: 30 });
  assert.strictEqual(res.status, '遲到');
  assert.strictEqual(pushes.length, 5);
  assert.match(pushes[4].messages[0].text, /已於 18:45 抵達/);
  // 不存經緯度
  const rec = sheets['簽到紀錄'].rows.at(-1);
  assert.ok(!rec.includes(22.002) && !rec.includes(120.7446));

  // 老師看板
  const t = call({ action: 'me', idToken: 'tok-U_tea' });
  const st = Object.fromEntries(t.dashboard.courses[0].students.map((s) => [s.id, s.status]));
  assert.deepStrictEqual(st, { S001: '遲到', S002: '準時', S003: '請假' });

  // 學生不能代簽；老師可以
  assert.strictEqual(call({ action: 'manualCheckin', idToken: 'tok-U_stu', courseId: 'M1', studentId: 'S003' }).ok, false);
  const m = call({ action: 'manualCheckin', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S003' });
  assert.ok(m.ok);
  assert.strictEqual(m.dashboard.courses[0].students.find((s) => s.id === 'S003').status, '老師代簽');
});

test('停課日不通知、webhook 加好友會登記', () => {
  const clock = { now: T('18:45') };
  const { ctx, sheets, pushes, call } = makeEnv(clock);
  ctx.setupSheets();
  sheets['LINE好友'].rows.push(['U_mom', '明媽', '家長', 'S001'], ['U_tea', '王老師', '老師', '']);
  sheets['學生'].rows.push(['S001', '王小明', 'A班', '在學']);
  sheets['課表'].rows.push(['M1', '數學', 'A班', '2', '18:30', '20:30', '教室', '22', '120', '80']);
  sheets['停課'].rows.push(['2026-09-29', '', '颱風假']);
  ctx.checkAbsences();
  assert.strictEqual(pushes.length, 0);

  call({ destination: 'x', events: [{ type: 'follow', replyToken: 'r', source: { type: 'user', userId: 'U_x' } }] });
  assert.ok(sheets['LINE好友'].rows.some((r) => r[0] === 'U_x' && r[1] === '新朋友'));
});

test('立即檢查：已通知過不重發，並回傳今日摘要（重現 2026-10-01 狀況）', () => {
  const clock = { now: new Date('2026-10-01T15:41:00+08:00').getTime() }; // 星期四
  const { ctx, sheets, call } = makeEnv(clock);
  ctx.setupSheets();
  sheets['學生'].rows.push(['410601', '尤沛筠', '觀二甲', '在學'], ['410609', '柯雅娟', '觀二甲', '在學'], ['410615', '葉翊涵', '觀二甲', '在學']);
  sheets['課表'].rows.push(['A4', '到校簽到', '觀二甲', '四', '08:05', '16:10', '教室', '21.9938173', '120.747958', '150']);
  sheets['請假'].rows.push(['2026/10/01', '410609', 'A4', '事']);
  sheets['簽到紀錄'].rows.push(['2026-10-01', 'A4', '410601', '尤沛筠', '8:17', '遲到', 73, 31]);
  sheets['通知紀錄'].rows.push(['2026-10-01', 'A4', '410615', '通知老師', '8:15', 1, '成功（未到 1 人）']);

  assert.strictEqual(ctx.checkAbsences(), 0, '今天已傳過名單給老師，不重發');
  assert.strictEqual(sheets['通知紀錄'].rows.length, 2);
  const summary = ctx.todaySummary_();
  assert.match(summary, /已於 8:15 傳名單給老師/);

  sheets['通知紀錄'].rows.length = 1; // 使用者清空通知紀錄
  clock.now = new Date('2026-10-01T16:30:00+08:00').getTime();
  assert.strictEqual(ctx.checkAbsences(), 0, '下課後不傳');
  assert.match(ctx.todaySummary_(), /已下課，今天沒有傳名單給老師/);
  clock.now = new Date('2026-10-01T08:00:00+08:00').getTime();
  assert.match(ctx.todaySummary_(), /將於 08:15 傳名單給老師/);
  clock.now = new Date('2026-10-01T15:41:00+08:00').getTime();
  sheets['通知紀錄'].rows.push(['2026-10-01', 'A4', '410615', '通知老師', '8:15', 1, '成功（未到 1 人）']);
  assert.match(summary, /已到 1 人/);
  assert.match(summary, /請假 1 人：柯雅娟/);
  assert.match(summary, /未到 1 人：葉翊涵（尚未通知家長）/);
});

test('聯絡未到學生：老師傳訊息 → 學生點按鈕回覆 → 通知老師 → 老師登記結果', () => {
  const clock = { now: T('18:45') };
  const { ctx, sheets, pushes, replies, call } = makeEnv(clock);
  ctx.setupSheets();
  ctx.SpreadsheetApp.getActive().getSheetByName('設定').rows.find((r) => r[0] === 'LINE Login Channel ID')[1] = '1234';
  sheets['設定'].rows.find((r) => r[0] === 'LIFF網址')[1] = 'https://liff.line.me/x';
  sheets['LINE好友'].rows.push(['U_stu', '小明', '學生', 'S001'], ['U_tea', '王老師', '老師', ''], ['U_other', '小華', '學生', 'S002']);
  sheets['學生'].rows.push(['S001', '王小明', 'A班', '在學'], ['S002', '陳小華', 'A班', '在學'], ['S003', '沒LINE', 'A班', '在學']);
  sheets['課表'].rows.push(['M1', '數學', 'A班', '二', '18:30', '20:30', '教室', '22.0019', '120.7445', '80']);
  const webhook = (userId, ev) => call({ destination: 'x', events: [Object.assign({ replyToken: 'r', source: { type: 'user', userId } }, ev)] });

  // 學生不能聯絡別人；沒綁 LINE 的學生會提示
  assert.strictEqual(call({ action: 'contactStudent', idToken: 'tok-U_stu', courseId: 'M1', studentId: 'S002' }).ok, false);
  assert.match(call({ action: 'contactStudent', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S003' }).message, /還沒有綁定 LINE/);

  // 還沒被聯絡時，學生隨便聊天不會轉給老師
  webhook('U_stu', { type: 'message', message: { type: 'text', text: '哈囉' } });
  assert.strictEqual(pushes.length, 0);

  // 老師傳訊息 → 學生收到帶快速回覆的訊息
  const r1 = call({ action: 'contactStudent', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S001' });
  assert.ok(r1.ok);
  assert.strictEqual(pushes[0].to, 'U_stu');
  const msg = pushes[0].messages[0];
  assert.match(msg.text, /王小明 同學，王老師 在找你/);
  assert.deepStrictEqual(msg.quickReply.items.map((i) => i.action.type), ['postback', 'postback', 'postback', 'uri']);
  assert.strictEqual(r1.dashboard.courses[0].students.find((s) => s.id === 'S001').contact.asked, '18:45');

  // 別的學生偽造同一個按鈕：沒被聯絡過，不接受
  webhook('U_other', { type: 'postback', postback: { data: 'contact|M1|2026-09-29|road' } });
  assert.strictEqual(pushes.length, 1);

  // 本人點「在路上」→ 回覆學生、通知老師、看板顯示
  clock.now = T('18:47');
  webhook('U_stu', { type: 'postback', postback: { data: 'contact|M1|2026-09-29|road' } });
  assert.match(replies.at(-1), /已經轉告老師/);
  assert.strictEqual(pushes[1].to, 'U_tea');
  assert.match(pushes[1].messages[0].text, /王小明 回覆：🚌 在路上（18:47）/);
  let st = call({ action: 'me', idToken: 'tok-U_tea' }).dashboard.courses[0].students.find((s) => s.id === 'S001');
  assert.strictEqual(st.contact.reply, '🚌 在路上 18:47');

  // 已回覆後再打字，不會再轉給老師
  webhook('U_stu', { type: 'message', message: { type: 'text', text: '快到了' } });
  assert.strictEqual(pushes.length, 2);

  // 過期的按鈕
  webhook('U_stu', { type: 'postback', postback: { data: 'contact|M1|2026-09-28|road' } });
  assert.match(replies.at(-1), /過期/);

  // 老師登記結果；不在選項內的結果不接受
  assert.strictEqual(call({ action: 'logContact', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S001', result: '亂寫' }).ok, false);
  const r2 = call({ action: 'logContact', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S001', result: '在路上' });
  assert.ok(r2.ok);
  assert.strictEqual(r2.dashboard.courses[0].students.find((s) => s.id === 'S001').contact.result, '在路上 18:47');
  assert.deepStrictEqual(sheets['聯絡紀錄'].rows.slice(1).map((r) => r[4]), ['傳訊息', '學生回覆', '老師登記']);

  // 學生打字回覆（先被聯絡、尚未回覆）
  call({ action: 'contactStudent', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S002' });
  webhook('U_other', { type: 'message', message: { type: 'text', text: '我睡過頭了' } });
  assert.match(pushes.at(-1).messages[0].text, /陳小華 回覆：我睡過頭了/);

  // 已簽到的學生不能再傳訊息
  clock.now = T('18:50');
  call({ action: 'checkin', idToken: 'tok-U_stu', lat: 22.0019, lng: 120.7445, accuracy: 10 });
  assert.match(call({ action: 'contactStudent', idToken: 'tok-U_tea', courseId: 'M1', studentId: 'S001' }).message, /已經簽到/);
});
