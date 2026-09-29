/** 試算表選單與一次性設定。 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('簽到系統')
    .addItem('1. 初始化試算表', 'setupSheets')
    .addItem('2. 啟用自動通知（每分鐘檢查）', 'installTrigger')
    .addItem('停用自動通知', 'removeTrigger')
    .addSeparator()
    .addItem('立即檢查一次未到', 'checkAbsences')
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
