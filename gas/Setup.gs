/** 試算表選單與一次性設定。 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('簽到系統')
    .addItem('1. 初始化試算表', 'setupSheets')
    .addItem('2. 啟用自動通知（每分鐘檢查）', 'installTrigger')
    .addItem('3. 檢查設定（班級、學號、配對）', 'checkSetup')
    .addItem('停用自動通知', 'removeTrigger')
    .addSeparator()
    .addItem('立即檢查一次未到', 'checkAbsencesNow')
    .addItem('測試推播給選取列的 LINE 使用者', 'testPushSelected')
    .addToUi();
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('checkAbsences').timeBased().everyMinutes(1).create();
  SpreadsheetApp.getActive().toast('已啟用：每分鐘檢查一次未簽到學生');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkAbsences') ScriptApp.deleteTrigger(t);
  });
}

/** 選單用：立即檢查並顯示結果。每位學生每堂課只會通知一次，所以已通知過的不會重發。 */
function checkAbsencesNow() {
  var sent = checkAbsences();
  SpreadsheetApp.getUi().alert('檢查完成：這次新增 ' + sent + ' 筆未到通知。\n' +
    '（每位學生每堂課只通知一次，已通知過的不會重發）\n\n' + todaySummary_());
}

/** 在「LINE好友」表選一列，推一則測試訊息給他，確認 token 與配對正確。 */
function testPushSelected() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.friends.name) {
    SpreadsheetApp.getUi().alert('請先到「LINE好友」工作表，點選要測試的那一列。');
    return;
  }
  var row = sh.getActiveRange().getRow();
  var userId = String(sh.getRange(row, 1).getValue()).trim();
  var name = sh.getRange(row, 2).getValue();
  if (!userId || row === 1) return;
  var ok = push_(userId, '這是簽到系統的測試訊息，收到代表設定成功 🎉');
  SpreadsheetApp.getUi().alert(ok ? '已送出給 ' + name : '送出失敗，請看「執行作業」記錄');
}

/** 檢查名單、課表、配對是否對得上，用對話框列出問題。 */
function checkSetup() {
  var problems = [];
  var courses = getCourses_(problems);
  problems = problems.concat(findSetupProblems(getStudents_(), courses, getFriends_()));
  var settings = getSettings_();
  if (!settings.loginChannelId) problems.push('「設定」表還沒填 LINE Login Channel ID。');
  if (!settings.liffUrl) problems.push('「設定」表還沒填 LIFF網址。');
  if (!PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN')) {
    problems.push('指令碼屬性還沒設定 LINE_CHANNEL_ACCESS_TOKEN，家長會收不到通知。');
  }
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'checkAbsences'; })) {
    problems.push('還沒啟用自動通知（選單 2）。');
  }
  SpreadsheetApp.getUi().alert(problems.length
    ? '發現 ' + problems.length + ' 個問題：\n\n・' + problems.join('\n・')
    : '✅ 設定看起來都沒問題！');
}
