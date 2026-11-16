/**
 * 一鍵設定精靈：試算表選單「★ 一鍵設定」。
 * 老師只要依序貼上 LINE 的 token、網頁應用程式網址、Login Channel ID、LIFF 網址，
 * 其餘（建立工作表、設定 Webhook、指令碼屬性、觸發條件、檢查設定）自動完成。
 * 每一格都可以留空跳過，之後再執行一次補上。
 */

function runSetupWizard() {
  var ui = SpreadsheetApp.getUi();
  var s = getSettingsSafe_();
  var hasToken = !!PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  var inputs = {};

  var steps = [
    { key: 'token', title: '1／4　LINE 官方帳號的 Channel access token',
      hint: '在 LINE Developers → Messaging API channel →「Messaging API」分頁最下方 → Issue → 複製。',
      done: hasToken },
    { key: 'execUrl', title: '2／4　網頁應用程式網址（結尾是 /exec）',
      hint: 'Apps Script 右上「部署 → 新增部署作業 → 網頁應用程式」，執行身分「我」、存取「所有人」，部署後複製網址。',
      done: !!s.execUrl },
    { key: 'loginChannelId', title: '3／4　LINE Login Channel ID（10 位數字）',
      hint: 'LINE Developers → 同一個 Provider 的 LINE Login channel →「Basic settings」→ Channel ID。',
      done: !!s.loginChannelId }
  ];
  for (var i = 0; i < steps.length; i++) {
    var st = steps[i];
    var r = ui.prompt(st.title, st.hint + (st.done ? '\n\n（已設定過；留空 = 保留原本的值）' : '\n\n（留空 = 先跳過，之後再設定）'), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    inputs[st.key] = r.getResponseText().trim();
  }

  var first = applySetupInputs_(inputs);
  var endpoint = getSettingsSafe_().endpointUrl;
  if (endpoint) {
    var r4 = ui.prompt('4／4　LIFF 網址',
      '請到 LINE Login channel →「LIFF」分頁 → Add：\n' +
      '・Size：Full\n・Endpoint URL：貼上「設定」表「LIFF Endpoint URL」那一格（已自動填好，直接複製）\n' +
      '・Scopes：勾選 openid、profile\n・Add friend option：On (Aggressive)\n\n' +
      '建立後把 LIFF URL（https://liff.line.me/…）貼在下面。\n' +
      '最後記得把 LINE Login channel 右上角從 Developing 改成 Published。',
      ui.ButtonSet.OK_CANCEL);
    if (r4.getSelectedButton() === ui.Button.OK && r4.getResponseText().trim()) {
      var second = applySetupInputs_({ liffUrl: r4.getResponseText().trim() });
      first.lines = first.lines.concat(second.lines);
      first.errors = first.errors.concat(second.errors);
    }
  }

  var problems = setupProblems_();
  ui.alert('一鍵設定結果',
    first.lines.map(function (l) { return '✅ ' + l; }).concat(first.errors.map(function (e) { return '❌ ' + e; })).join('\n') +
    '\n\n' + (problems.length ? '還需要處理：\n・' + problems.join('\n・') : '🎉 設定都沒問題了！接著到「學生」「課表」填資料，再請學生、家長加官方帳號好友。'),
    ui.ButtonSet.OK);
}

/** 讀設定，但工作表還沒建時不出錯。 */
function getSettingsSafe_() {
  try { return getSettings_(); } catch (e) { return {}; }
}

/**
 * 套用精靈收到的值（不含畫面，方便測試）。
 * inputs: { token?, execUrl?, loginChannelId?, liffUrl? }；空字串 = 不變。
 * 回傳 { lines: [做了什麼], errors: [哪裡不對] }。
 */
function applySetupInputs_(inputs) {
  var lines = [], errors = [];
  var props = PropertiesService.getScriptProperties();

  setupSheets();
  lines.push('工作表已建立／確認');

  if (inputs.token) {
    var info = botInfo_(inputs.token);
    if (info) {
      props.setProperty('LINE_CHANNEL_ACCESS_TOKEN', inputs.token);
      if (info.userId) props.setProperty('LINE_BOT_USER_ID', info.userId);
      lines.push('LINE token 正確（官方帳號：' + (info.displayName || info.basicId || '') + '）');
    } else {
      errors.push('LINE token 無效，請重新複製（不要多貼空白或換行）');
    }
  }

  if (inputs.loginChannelId) {
    if (/^\d{10}$/.test(inputs.loginChannelId)) {
      setSetting_('LINE Login Channel ID', inputs.loginChannelId);
      lines.push('Login Channel ID 已填入');
    } else {
      errors.push('Login Channel ID 應該是 10 位數字');
    }
  }

  if (inputs.execUrl) {
    if (isExecUrl(inputs.execUrl)) {
      setSetting_('網頁應用程式網址', inputs.execUrl, '部署後的 /exec 網址（一鍵設定自動填）');
      setSetting_('LIFF Endpoint URL', sharedEndpointUrl(inputs.execUrl), '建立 LIFF 時貼到 Endpoint URL（一鍵設定自動填）');
      lines.push('簽到網頁網址已產生（「設定」表的 LIFF Endpoint URL）');
      if (props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) {
        if (setWebhook_(inputs.execUrl)) lines.push('LINE Webhook 已自動設定並開啟');
        else errors.push('LINE Webhook 設定失敗，請到 LINE Developers 手動貼上 /exec 網址');
      }
    } else {
      errors.push('網頁應用程式網址格式不對，要是 https://script.google.com/…/exec');
    }
  }

  if (inputs.liffUrl) {
    var id = liffIdFromUrl(inputs.liffUrl);
    if (id) {
      setSetting_('LIFF網址', 'https://liff.line.me/' + id);
      lines.push('LIFF 網址已填入');
    } else {
      errors.push('LIFF 網址格式不對，應該像 https://liff.line.me/1234567890-AbCdEfGh');
    }
  }

  if (props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) {
    installTrigger();
    lines.push('自動檢查已啟用（每分鐘）');
  }
  return { lines: lines, errors: errors };
}

/** 「設定」表：有這個鍵就改值，沒有就新增一列。 */
function setSetting_(key, value, desc) {
  var sh = sheet_('settings');
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value, desc || '']);
}
