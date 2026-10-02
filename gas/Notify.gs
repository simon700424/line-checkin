/**
 * 未到通知流程：
 *  - 每分鐘觸發 checkAbsences()：上課後 N 分鐘，傳「一則彙整名單」給所有老師（每堂課每天一次）
 *  - 老師確認後，在 LINE 看板按「通知家長」，才私訊家長「未到」
 *  - 已通知家長的學生之後簽到 → 自動私訊家長「已到」
 * 準時簽到不發通知（免費方案每月約 200 則，省著用）。
 */

function parentsOf_(studentId) {
  return getFriends_().filter(function (f) {
    return f.role === '家長' && f.studentIds.indexOf(studentId) >= 0;
  });
}

function teachers_() {
  return getFriends_().filter(function (f) { return f.role === '老師'; });
}

/** 發給該學生所有家長，並寫一筆通知紀錄。 */
function notifyParents_(student, course, now, type, text) {
  var parents = parentsOf_(student.id);
  var sent = 0;
  parents.forEach(function (p) { if (push_(p.userId, text)) sent++; });
  appendRow_('notices', {
    '日期': now.dateStr, '課程ID': course.id, '學號': student.id, '類型': type,
    '發送時間': now.hm, '家長數': parents.length,
    '結果': parents.length === 0 ? '無配對家長' : (sent === parents.length ? '成功' : '部分失敗 ' + sent + '/' + parents.length)
  });
}

/** 這堂課目前未到（沒簽到、沒請假）的學生。 */
function absentStudents_(course, now, students, records, leaves) {
  return students.filter(function (s) {
    return studentInCourse(s, course) &&
      !records.some(function (r) { return r.courseId === course.id && r.studentId === s.id; }) &&
      !isOnLeave(leaves, now.dateStr, s.id, course.id);
  });
}

/**
 * 時間觸發器每分鐘執行：到了通知時間，傳彙整名單給老師（每堂課每天一次）。
 * 回傳這次傳出的彙整則數。
 */
function checkAbsences() {
  var now = now_();
  var settings = getSettings_();
  var due = todaysCourses_(now).filter(function (c) {
    return isAbsentNoticeDue(now.minutes, c, settings.delayMin);
  });
  if (!due.length) return 0;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0; // 上一輪還在跑，下一分鐘再說
  var sent = 0;
  try {
    var notices = getNotices_(now.dateStr);
    due = due.filter(function (c) {
      return !notices.some(function (n) { return n.courseId === c.id && n.type === '通知老師'; });
    });
    if (!due.length) return 0;

    var students = getStudents_();
    var records = getRecords_(now.dateStr);
    var leaves = getLeaves_();
    var teachers = teachers_();

    due.forEach(function (c) {
      var absent = absentStudents_(c, now, students, records, leaves);
      var leaveNames = students.filter(function (s) {
        return studentInCourse(s, c) && isOnLeave(leaves, now.dateStr, s.id, c.id);
      }).map(function (s) { return s.name; });
      var text = '【' + settings.schoolName + '】' + now.dateStr.slice(5).replace('-', '/') + '「' + c.name + '」' + now.hm + ' 點名\n' +
        (absent.length
          ? '未到 ' + absent.length + ' 人：' + absent.map(function (s) { return s.name; }).join('、')
          : '全員到齊 ✅') +
        (leaveNames.length ? '\n請假 ' + leaveNames.length + ' 人：' + leaveNames.join('、') : '') +
        (absent.length ? '\n\n確認後請到看板按「通知家長」' + (settings.liffUrl ? '：\n' + settings.liffUrl : '。') : '');
      var ok = 0;
      teachers.forEach(function (t) { if (push_(t.userId, text)) ok++; });
      sent++;
      appendRow_('notices', {
        '日期': now.dateStr, '課程ID': c.id, '學號': absent.map(function (s) { return s.id; }).join(','),
        '類型': '通知老師', '發送時間': now.hm, '家長數': teachers.length,
        '結果': teachers.length === 0 ? '無老師帳號' : (ok === teachers.length ? '成功（未到 ' + absent.length + ' 人）' : '部分失敗 ' + ok + '/' + teachers.length)
      });
    });
  } finally {
    lock.releaseLock();
  }
  return sent;
}

/**
 * 老師在看板按「通知家長」：只通知仍未到、沒請假、還沒通知過的學生。
 * 回傳 { sent: 通知人數, skipped: [略過原因] }。
 */
function notifyParentsForAbsent_(courseId, studentIds) {
  var now = now_();
  var settings = getSettings_();
  var course = todaysCourses_(now).filter(function (c) { return c.id === courseId; })[0];
  if (!course) return { sent: 0, skipped: ['今天沒有這堂課'] };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var notices = getNotices_(now.dateStr);
    var absent = absentStudents_(course, now, getStudents_(), getRecords_(now.dateStr), getLeaves_());
    var sent = 0, skipped = [];
    absent.filter(function (s) { return studentIds.indexOf(s.id) >= 0; }).forEach(function (s) {
      var done = notices.some(function (n) { return n.courseId === course.id && n.studentId === s.id && n.type === '未到'; });
      if (done) { skipped.push(s.name + '（已通知過）'); return; }
      if (!parentsOf_(s.id).length) skipped.push(s.name + '（沒有配對家長）');
      else sent++;
      notifyParents_(s, course, now, '未到',
        '【' + settings.schoolName + '】' + s.name + ' 今天「' + course.name + '」（' + formatHm(course.startMin) +
        '）到目前（' + now.hm + '）尚未簽到，請留意孩子狀況。若已請假請告知老師。');
    });
    return { sent: sent, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

/** 學生簽到後：如果先前已通知家長「未到」，補發「已到」。 */
function notifyArrivedIfNeeded_(student, course, now, status, settings) {
  var notified = getNotices_(now.dateStr).some(function (n) {
    return n.courseId === course.id && n.studentId === student.id && n.type === '未到';
  });
  if (!notified) return;
  notifyParents_(student, course, now, '已到',
    '【' + settings.schoolName + '】' + student.name + ' 已於 ' + now.hm + ' 抵達「' + course.name + '」（' + status + '），請放心。');
}

/** 今天每堂課的出缺席摘要（給選單「立即檢查」顯示用）。 */
function todaySummary_() {
  var now = now_();
  var notices = getNotices_(now.dateStr);
  var delayMin = getSettings_().delayMin;
  var d = buildDashboard_();
  if (!d.courses.length) return '今天（' + now.dateStr + '）沒有課。';
  return d.courses.map(function (c) {
    var arrived = [], leave = [], absent = [];
    c.students.forEach(function (s) {
      if (s.status === '請假') leave.push(s.name);
      else if (s.status === '未到') {
        var n = notices.filter(function (x) { return x.courseId === c.id && x.studentId === s.id && x.type === '未到'; })[0];
        absent.push(s.name + (n ? '（已通知家長）' : '（尚未通知家長）'));
      } else arrived.push(s.name);
    });
    var t = notices.filter(function (x) { return x.courseId === c.id && x.type === '通知老師'; })[0];
    var noticeAt = parseHm(c.start) + delayMin;
    var teacherState = t ? '已於 ' + t.time + ' 傳名單給老師'
      : now.minutes < noticeAt ? '將於 ' + formatHm(noticeAt) + ' 傳名單給老師'
      : now.minutes > parseHm(c.end) ? '已下課，今天沒有傳名單給老師（當時自動檢查可能沒有執行）'
      : '下一分鐘會傳名單給老師';
    return '【' + c.name + ' ' + c.start + '–' + c.end + '】\n' + teacherState + '\n' +
      '已到 ' + arrived.length + ' 人\n' +
      '請假 ' + leave.length + ' 人' + (leave.length ? '：' + leave.join('、') : '') + '\n' +
      '未到 ' + absent.length + ' 人' + (absent.length ? '：' + absent.join('、') : '');
  }).join('\n\n');
}
