/**
 * Web App 入口：
 *  - LINE webhook（body 內有 events）
 *  - LIFF 頁面呼叫（body 內有 action）
 */

function doGet() {
  return ContentService.createTextOutput('line-checkin OK');
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, message: '格式錯誤' });
  }
  if (body.events) {
    handleWebhook_(body);
    return json_({ ok: true });
  }
  try {
    return json_(handleAction_(body));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, message: '系統錯誤：' + err.message });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- LINE webhook ---------------- */

/**
 * Apps Script 讀不到 HTTP header，無法驗證 X-Line-Signature。
 * 因此 webhook 只做低風險的事（記錄好友、回覆連結）；簽到一律走 LIFF + ID token 驗證。
 * 若有設定指令碼屬性 LINE_BOT_USER_ID，會檢查 destination 是否相符。
 */
function handleWebhook_(body) {
  var botId = PropertiesService.getScriptProperties().getProperty('LINE_BOT_USER_ID');
  if (botId && body.destination !== botId) return;
  var settings = getSettings_();

  body.events.forEach(function (ev) {
    var userId = ev.source && ev.source.userId;
    if (!userId || ev.source.type !== 'user') return;

    if (ev.type === 'follow') {
      var profile = getProfile_(userId);
      registerFriend_(userId, profile ? profile.displayName : '');
      reply_(ev.replyToken, '歡迎加入' + settings.schoolName + '！\n老師會幫你完成配對，配對後：\n・學生：傳「簽到」取得簽到連結\n・家長：孩子未到時會收到通知');
      return;
    }

    if (ev.type === 'message' && ev.message.type === 'text') {
      var text = ev.message.text.trim();
      if (/^(簽到|點名|打卡)$/.test(text) || /^(老師|出缺席)$/.test(text)) {
        registerFriend_(userId, '');
        reply_(ev.replyToken, settings.liffUrl
          ? '請點這個連結：\n' + settings.liffUrl
          : '老師還沒設定簽到連結，請通知老師。');
      }
    }
  });
}

/** 把 LINE 使用者寫進「LINE好友」表（已存在就略過），讓老師手動配對角色與學號。 */
function registerFriend_(userId, displayName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var exists = getFriends_().some(function (f) { return f.userId === userId; });
    if (exists) return;
    appendRow_('friends', {
      'LINE使用者ID': userId,
      '顯示名稱': displayName || (getProfile_(userId) || {}).displayName || '',
      '加入時間': Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')
    });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- LIFF actions ---------------- */

function handleAction_(body) {
  var settings = getSettings_();
  var me = verifyIdToken_(body.idToken, settings.loginChannelId);
  if (!me) return { ok: false, message: '登入驗證失敗，請關閉頁面後重新開啟。' };

  var friend = getFriends_().filter(function (f) { return f.userId === me.userId; })[0];
  if (!friend) {
    registerFriend_(me.userId, me.name);
    friend = { role: '', studentIds: [] };
  }

  switch (body.action) {
    case 'me': return actionMe_(me, friend, settings);
    case 'checkin': return actionCheckin_(friend, settings, body);
    case 'manualCheckin': return actionManualCheckin_(friend, body);
    case 'notifyParents': return actionNotifyParents_(friend, body);
    default: return { ok: false, message: '未知的操作' };
  }
}

/** 開啟 LIFF 頁面時呼叫：依角色回傳要顯示的內容。 */
function actionMe_(me, friend, settings) {
  var base = { ok: true, role: friend.role, schoolName: settings.schoolName, displayName: me.name };
  if (friend.role === '老師') {
    base.dashboard = buildDashboard_();
    return base;
  }
  if (friend.role === '學生') {
    var student = findStudent_(friend.studentIds[0]);
    if (!student) return { ok: true, role: '', displayName: me.name, schoolName: settings.schoolName, message: '學號設定有誤，請通知老師。' };
    base.student = { id: student.id, name: student.name, classes: student.classes };
    base.courses = studentTodayCourses_(student);
    return base;
  }
  if (friend.role === '家長') {
    base.message = '您已完成配對。孩子上課未簽到時，系統會私訊通知您。';
    return base;
  }
  base.role = '';
  base.message = '尚未配對。請把你的 LINE 名稱「' + me.name + '」告訴老師，由老師完成配對。';
  return base;
}

function findStudent_(studentId) {
  return getStudents_().filter(function (s) { return s.id === studentId; })[0] || null;
}

/** 學生今天的課與簽到狀態。 */
function studentTodayCourses_(student) {
  var now = now_();
  var records = getRecords_(now.dateStr);
  var leaves = getLeaves_();
  return todaysCourses_(now).filter(function (c) {
    return studentInCourse(student, c);
  }).map(function (c) {
    var rec = records.filter(function (r) { return r.courseId === c.id && r.studentId === student.id; })[0];
    return {
      id: c.id, name: c.name, place: c.place,
      start: formatHm(c.startMin), end: formatHm(c.endMin),
      status: rec ? rec.status : (isOnLeave(leaves, now.dateStr, student.id, c.id) ? '請假' : '未簽到'),
      time: rec ? rec.time : ''
    };
  });
}

/** 學生簽到。 */
function actionCheckin_(friend, settings, body) {
  if (friend.role !== '學生') return { ok: false, message: '只有已配對的學生可以簽到。' };
  var student = findStudent_(friend.studentIds[0]);
  if (!student) return { ok: false, message: '學號設定有誤，請通知老師。' };

  var now = now_();
  var mine = todaysCourses_(now).filter(function (c) { return studentInCourse(student, c); });
  var course = findActiveCourse(mine, now.minutes, settings.earlyMin);
  if (!course) return { ok: false, message: '現在不是你的簽到時間（上課前 ' + settings.earlyMin + ' 分鐘開放）。' };

  var loc = evaluateLocation({
    lat: Number(body.lat), lng: Number(body.lng), accuracy: Number(body.accuracy) || 0
  }, course, settings.maxAccuracy);
  if (!loc.ok) return { ok: false, message: loc.reason };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var done = getRecords_(now.dateStr).filter(function (r) {
      return r.courseId === course.id && r.studentId === student.id;
    })[0];
    if (done) return { ok: true, message: '你已經在 ' + done.time + ' 簽到過了。', status: done.status };

    var status = decideStatus(now.minutes, course.startMin, settings.graceMin);
    appendRow_('records', {
      '日期': now.dateStr, '課程ID': course.id, '學號': student.id, '姓名': student.name,
      '簽到時間': now.hm, '狀態': status, '距離公尺': loc.distance,
      '定位精度公尺': Math.round(Number(body.accuracy) || 0)
    });
  } finally {
    lock.releaseLock();
  }

  notifyArrivedIfNeeded_(student, course, now, status, settings);
  return { ok: true, message: '簽到成功！（' + course.name + '，' + status + '）', status: status };
}

/** 老師代簽（學生手機沒電、定位失敗等）。 */
function actionManualCheckin_(friend, body) {
  if (friend.role !== '老師') return { ok: false, message: '只有老師可以代簽。' };
  var student = findStudent_(String(body.studentId || ''));
  if (!student) return { ok: false, message: '找不到學生。' };
  var now = now_();
  var course = todaysCourses_(now).filter(function (c) { return c.id === body.courseId; })[0];
  if (!course) return { ok: false, message: '今天沒有這堂課。' };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var done = getRecords_(now.dateStr).some(function (r) {
      return r.courseId === course.id && r.studentId === student.id;
    });
    if (done) return { ok: true, message: student.name + ' 已經簽到過了。', dashboard: buildDashboard_() };
    appendRow_('records', {
      '日期': now.dateStr, '課程ID': course.id, '學號': student.id, '姓名': student.name,
      '簽到時間': now.hm, '狀態': '老師代簽'
    });
  } finally {
    lock.releaseLock();
  }
  notifyArrivedIfNeeded_(student, course, now, '老師代簽', getSettings_());
  return { ok: true, message: '已替 ' + student.name + ' 代簽。', dashboard: buildDashboard_() };
}

/** 老師確認後通知家長（可一次多位）。 */
function actionNotifyParents_(friend, body) {
  if (friend.role !== '老師') return { ok: false, message: '只有老師可以通知家長。' };
  var ids = Array.isArray(body.studentIds) ? body.studentIds.map(String) : [];
  if (!ids.length) return { ok: false, message: '沒有選擇學生。' };
  var r = notifyParentsForAbsent_(String(body.courseId || ''), ids);
  return {
    ok: true,
    message: '已通知 ' + r.sent + ' 位學生的家長。' + (r.skipped.length ? '\n略過：' + r.skipped.join('、') : ''),
    dashboard: buildDashboard_()
  };
}

/** 老師看板：今天每堂課的已到／未到／請假名單。 */
function buildDashboard_() {
  var now = now_();
  var students = getStudents_();
  var records = getRecords_(now.dateStr);
  var leaves = getLeaves_();
  var notices = getNotices_(now.dateStr);
  return {
    date: now.dateStr,
    time: now.hm,
    courses: todaysCourses_(now).map(function (c) {
      var list = students.filter(function (s) { return studentInCourse(s, c); }).map(function (s) {
        var rec = records.filter(function (r) { return r.courseId === c.id && r.studentId === s.id; })[0];
        var status = rec ? rec.status : (isOnLeave(leaves, now.dateStr, s.id, c.id) ? '請假' : '未到');
        var n = notices.filter(function (x) { return x.courseId === c.id && x.studentId === s.id && x.type === '未到'; })[0];
        return { id: s.id, name: s.name, status: status, time: rec ? rec.time : '', parentNotified: n ? String(n.time || '已通知') : '' };
      });
      return {
        id: c.id, name: c.name, place: c.place,
        start: formatHm(c.startMin), end: formatHm(c.endMin),
        started: now.minutes >= c.startMin,
        students: list
      };
    })
  };
}
