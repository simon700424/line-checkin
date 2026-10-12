/**
 * 聯絡未到學生：
 *  - 老師在看板按「傳訊息」→ 官方帳號私訊學生，附快速回覆按鈕
 *  - 學生點按鈕（或直接打字）→ 寫進「聯絡紀錄」、回覆學生、通知老師
 *  - 老師在看板選「聯絡結果」→ 寫進「聯絡紀錄」
 * 學生回覆「請假」不會自動登記請假，由老師決定。
 */

/** 學生可點的回覆選項（postback 代碼 → 顯示文字）。 */
var CONTACT_REPLIES = {
  road: '🚌 在路上',
  sick: '🤒 身體不舒服要請假',
  call: '📞 請老師打給我'
};

/** 老師可登記的聯絡結果。 */
var CONTACT_RESULTS = ['已聯絡上', '未接／未回', '在路上', '請假', '其他'];

function getContacts_(dateStr) {
  return readTable_('contacts').filter(function (r) {
    return toDateStr_(r['日期']) === dateStr;
  }).map(function (r) {
    var t = r['時間'];
    return {
      courseId: String(r['課程ID']), studentId: String(r['學號']), name: String(r['姓名']),
      type: String(r['方式']), content: String(r['內容']),
      time: t instanceof Date ? Utilities.formatDate(t, TZ, 'HH:mm') : String(t)
    };
  });
}

function studentLineIds_(studentId) {
  return getFriends_().filter(function (f) {
    return f.role === '學生' && f.studentIds[0] === studentId;
  }).map(function (f) { return f.userId; });
}

/** 老師按「傳訊息」：私訊學生並附快速回覆。回傳給老師看的訊息。 */
function contactStudent_(teacherName, courseId, studentId) {
  var now = now_();
  var settings = getSettings_();
  var course = todaysCourses_(now).filter(function (c) { return c.id === courseId; })[0];
  var student = findStudent_(studentId);
  if (!course || !student) return { ok: false, message: '找不到這堂課或學生。' };
  if (getRecords_(now.dateStr).some(function (r) { return r.courseId === courseId && r.studentId === studentId; })) {
    return { ok: false, message: student.name + ' 已經簽到了。' };
  }
  var ids = studentLineIds_(studentId);
  if (!ids.length) return { ok: false, message: student.name + ' 還沒有綁定 LINE（LINE好友表沒有這位學生）。' };

  var items = Object.keys(CONTACT_REPLIES).map(function (code) {
    return {
      type: 'action',
      action: {
        type: 'postback', label: CONTACT_REPLIES[code].slice(0, 20),
        data: ['contact', courseId, now.dateStr, code].join('|'),
        displayText: CONTACT_REPLIES[code]
      }
    };
  });
  if (settings.liffUrl) {
    items.push({ type: 'action', action: { type: 'uri', label: '📍 我到了，去簽到', uri: settings.liffUrl } });
  }
  var message = {
    type: 'text',
    text: '【' + settings.schoolName + '】' + student.name + ' 同學，' + (teacherName || '老師') +
      ' 在找你：今天「' + course.name + '」還沒看到你簽到，你現在在哪裡？\n請點下方按鈕回覆，或直接打字告訴老師。',
    quickReply: { items: items }
  };
  var sent = ids.filter(function (id) { return pushMessages_(id, [message]); }).length;
  appendRow_('contacts', {
    '日期': now.dateStr, '課程ID': courseId, '學號': studentId, '姓名': student.name,
    '方式': '傳訊息', '內容': sent ? '已傳訊息給學生' : '傳送失敗', '時間': now.hm, '記錄者': teacherName || ''
  });
  return sent
    ? { ok: true, message: '已傳訊息給 ' + student.name + '，學生回覆後會通知你。' }
    : { ok: false, message: '傳送失敗，學生可能封鎖了官方帳號。' };
}

/** 老師登記聯絡結果。 */
function logContact_(teacherName, courseId, studentId, result, note) {
  var student = findStudent_(studentId);
  if (!student) return { ok: false, message: '找不到學生。' };
  if (CONTACT_RESULTS.indexOf(result) < 0) return { ok: false, message: '聯絡結果不正確。' };
  var now = now_();
  appendRow_('contacts', {
    '日期': now.dateStr, '課程ID': courseId, '學號': studentId, '姓名': student.name,
    '方式': '老師登記', '內容': result + (note ? '：' + note : ''), '時間': now.hm, '記錄者': teacherName || ''
  });
  return { ok: true, message: '已記錄：' + student.name + ' ' + result };
}

/**
 * 學生回覆（postback 代碼或自由文字）。今天有被老師聯絡、而且是本人才接受。
 * 回傳要回覆給學生的文字；不是聯絡回覆則回傳 null。
 */
function handleStudentContactReply_(userId, courseId, dateStr, content) {
  var now = now_();
  if (dateStr && dateStr !== now.dateStr) return '這是之前的詢問，已經過期了，謝謝你。';
  var friend = getFriends_().filter(function (f) { return f.userId === userId && f.role === '學生'; })[0];
  if (!friend) return null;
  var studentId = friend.studentIds[0];
  var contacts = getContacts_(now.dateStr).filter(function (c) { return c.studentId === studentId; });
  var asked = contacts.filter(function (c) { return c.type === '傳訊息' && (!courseId || c.courseId === courseId); }).pop();
  if (!asked) return null;
  // 自由文字只在「還沒回覆過」時才算，避免之後每句聊天都轉給老師
  var replied = contacts.some(function (c) { return c.type === '學生回覆' && c.courseId === asked.courseId && c.time >= asked.time; });
  if (!courseId && replied) return null;
  var student = findStudent_(studentId);
  var name = student ? student.name : friend.name;

  appendRow_('contacts', {
    '日期': now.dateStr, '課程ID': asked.courseId, '學號': studentId, '姓名': name,
    '方式': '學生回覆', '內容': content, '時間': now.hm, '記錄者': name
  });
  var settings = getSettings_();
  teachers_().forEach(function (t) {
    push_(t.userId, '【' + settings.schoolName + '】' + name + ' 回覆：' + content + '（' + now.hm + '）' +
      (settings.liffUrl ? '\n看板：' + settings.liffUrl : ''));
  });
  return '收到，已經轉告老師了，謝謝你！' + (/打給我/.test(content) ? '老師會盡快跟你聯絡。' : '');
}

/** 看板用：每位學生今天最新的聯絡狀態，key = 課程ID|學號。 */
function contactStatusMap_(dateStr) {
  var map = {};
  getContacts_(dateStr).forEach(function (c) {
    var key = c.courseId + '|' + c.studentId;
    var s = map[key] || (map[key] = { asked: '', reply: '', result: '' });
    if (c.type === '傳訊息') s.asked = c.time;
    if (c.type === '學生回覆') s.reply = c.content + ' ' + c.time;
    if (c.type === '老師登記') s.result = c.content + ' ' + c.time;
  });
  return map;
}
