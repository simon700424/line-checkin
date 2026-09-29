/**
 * 試算表結構、初始化與讀寫。
 * 老師只需要在試算表裡維護資料；程式靠「第一列標題」找欄位，欄位順序可以調整，但標題文字不要改。
 */

var TZ = 'Asia/Taipei';

var SHEETS = {
  settings: { name: '設定', headers: ['鍵', '值', '說明'] },
  friends: { name: 'LINE好友', headers: ['LINE使用者ID', '顯示名稱', '角色', '學號', '加入時間', '備註'] },
  students: { name: '學生', headers: ['學號', '姓名', '班級', '狀態'] },
  courses: { name: '課表', headers: ['課程ID', '課程名稱', '班級', '星期', '開始', '結束', '地點名稱', '緯度', '經度', '半徑公尺'] },
  leaves: { name: '請假', headers: ['日期', '學號', '課程ID', '原因'] },
  cancels: { name: '停課', headers: ['日期', '課程ID', '原因'] },
  records: { name: '簽到紀錄', headers: ['日期', '課程ID', '學號', '姓名', '簽到時間', '狀態', '距離公尺', '定位精度公尺'] },
  notices: { name: '通知紀錄', headers: ['日期', '課程ID', '學號', '類型', '發送時間', '家長數', '結果'] }
};

var DEFAULT_SETTINGS = [
  ['補習班名稱', '○○補習班', '顯示在通知訊息開頭'],
  ['LINE Login Channel ID', '', 'LIFF 所屬 LINE Login channel 的 Channel ID（用來驗證身分）'],
  ['LIFF網址', '', '例如 https://liff.line.me/1234567890-AbCdEfGh，學生傳「簽到」時回覆這個連結'],
  ['簽到提前分鐘', '15', '上課前幾分鐘開放簽到'],
  ['遲到寬限分鐘', '5', '開始後幾分鐘內仍算準時'],
  ['通知延遲分鐘', '10', '開始後幾分鐘還沒簽到就通知家長'],
  ['定位精度上限公尺', '150', '手機回報的誤差大於這個值就請學生重試']
];

function sheet_(key) {
  var def = SHEETS[key];
  var sh = SpreadsheetApp.getActive().getSheetByName(def.name);
  if (!sh) throw new Error('找不到工作表「' + def.name + '」，請先執行選單「簽到系統 → 初始化試算表」。');
  return sh;
}

/** 建立缺少的工作表、標題列、下拉選單與文字格式。重複執行不會清掉資料。 */
function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (key) {
    var def = SHEETS[key];
    var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });

  var settings = sheet_('settings');
  if (settings.getLastRow() === 1) {
    settings.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  }

  // 時間、學號、日期一律存成文字，避免 Google 試算表自動轉成日期或數字。
  sheet_('courses').getRange('A:G').setNumberFormat('@');
  sheet_('students').getRange('A:A').setNumberFormat('@');
  sheet_('friends').getRange('A:D').setNumberFormat('@');
  sheet_('leaves').getRange('A:C').setNumberFormat('@');
  sheet_('cancels').getRange('A:B').setNumberFormat('@');

  var roleRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['學生', '家長', '老師'], true).setAllowInvalid(false).build();
  sheet_('friends').getRange('C2:C').setDataValidation(roleRule);
  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['在學', '離班'], true).build();
  sheet_('students').getRange('D2:D').setDataValidation(statusRule);
}

/** 讀整張表成物件陣列，key 是標題文字。空白列略過。 */
function readTable_(key) {
  var values = sheet_(key).getDataRange().getValues();
  var headers = values.shift() || [];
  return values.filter(function (row) {
    return row.some(function (v) { return v !== '' && v !== null; });
  }).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function appendRow_(key, obj) {
  var sh = sheet_(key);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

/** 儲存格值 → "yyyy-MM-dd"（接受 Date 物件或 2026/9/29、2026-09-29 等文字）。 */
function toDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  var m = String(v || '').trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/** 儲存格值 → 分鐘數（接受 Date 物件或 "18:30"）。 */
function toMinutes_(v) {
  if (v instanceof Date) return parseHm(Utilities.formatDate(v, TZ, 'H:mm'));
  return parseHm(v);
}

function getSettings_() {
  var s = {};
  readTable_('settings').forEach(function (r) { s[String(r['鍵']).trim()] = String(r['值']).trim(); });
  return {
    schoolName: s['補習班名稱'] || '補習班',
    loginChannelId: s['LINE Login Channel ID'],
    liffUrl: s['LIFF網址'],
    earlyMin: Number(s['簽到提前分鐘']) || 15,
    graceMin: Number(s['遲到寬限分鐘']) || 0,
    delayMin: Number(s['通知延遲分鐘']) || 10,
    maxAccuracy: Number(s['定位精度上限公尺']) || 150
  };
}

function getFriends_() {
  return readTable_('friends').map(function (r) {
    return {
      userId: String(r['LINE使用者ID']).trim(),
      name: String(r['顯示名稱']),
      role: String(r['角色']).trim(),
      studentIds: splitIds(r['學號'])
    };
  });
}

function getStudents_() {
  return readTable_('students').filter(function (r) {
    return String(r['狀態']).trim() !== '離班';
  }).map(function (r) {
    return { id: String(r['學號']).trim(), name: String(r['姓名']), classes: String(r['班級']) };
  });
}

/** 課表中格式正確的課；格式錯誤的列略過並寫進執行記錄，方便老師排查。 */
function getCourses_() {
  var out = [];
  readTable_('courses').forEach(function (r, i) {
    var c = {
      id: String(r['課程ID']).trim(),
      name: String(r['課程名稱'] || r['課程ID']),
      classes: String(r['班級']),
      weekday: parseWeekday(r['星期']),
      startMin: toMinutes_(r['開始']),
      endMin: toMinutes_(r['結束']),
      place: String(r['地點名稱'] || ''),
      lat: Number(r['緯度']),
      lng: Number(r['經度']),
      radius: Number(r['半徑公尺']) || 100
    };
    if (!c.id || !c.weekday || c.startMin === null || c.endMin === null || !c.lat || !c.lng) {
      console.warn('課表第 ' + (i + 2) + ' 列格式不完整，已略過');
      return;
    }
    out.push(c);
  });
  return out;
}

function getLeaves_() {
  return readTable_('leaves').map(function (r) {
    return { date: toDateStr_(r['日期']), studentId: String(r['學號']).trim(), courseId: String(r['課程ID']).trim() };
  });
}

function getCancels_() {
  return readTable_('cancels').map(function (r) {
    return { date: toDateStr_(r['日期']), courseId: String(r['課程ID']).trim() };
  });
}

function getRecords_(dateStr) {
  return readTable_('records').filter(function (r) {
    return toDateStr_(r['日期']) === dateStr;
  }).map(function (r) {
    return { courseId: String(r['課程ID']), studentId: String(r['學號']), time: String(r['簽到時間']), status: String(r['狀態']) };
  });
}

function getNotices_(dateStr) {
  return readTable_('notices').filter(function (r) {
    return toDateStr_(r['日期']) === dateStr;
  }).map(function (r) {
    return { courseId: String(r['課程ID']), studentId: String(r['學號']), type: String(r['類型']) };
  });
}

/** 現在（台灣時間）的日期字串、星期（1-7）、分鐘數。 */
function now_() {
  var d = new Date();
  return {
    dateStr: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'),
    weekday: Number(Utilities.formatDate(d, TZ, 'u')),
    minutes: Number(Utilities.formatDate(d, TZ, 'H')) * 60 + Number(Utilities.formatDate(d, TZ, 'm')),
    hm: Utilities.formatDate(d, TZ, 'HH:mm')
  };
}

/** 今天有開課（未停課）的課程。 */
function todaysCourses_(now) {
  var cancels = getCancels_();
  return getCourses_().filter(function (c) {
    return courseRunsOn(c, now.weekday, cancels, now.dateStr);
  });
}
