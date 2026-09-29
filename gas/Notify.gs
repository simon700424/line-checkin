/**
 * 自動通知家長：
 *  - 每分鐘觸發 checkAbsences()，上課後 N 分鐘仍未簽到（且沒請假）→ 私訊家長「未到」
 *  - 已發過「未到」的學生之後簽到 → 私訊家長「已到」
 * 準時簽到不發通知（免費方案每月約 200 則，省著用）。
 */

function parentsOf_(studentId) {
  return getFriends_().filter(function (f) {
    return f.role === '家長' && f.studentIds.indexOf(studentId) >= 0;
  });
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

/** 時間觸發器每分鐘執行。 */
function checkAbsences() {
  var now = now_();
  var settings = getSettings_();
  var due = todaysCourses_(now).filter(function (c) {
    return isAbsentNoticeDue(now.minutes, c, settings.delayMin);
  });
  if (!due.length) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 上一輪還在跑，下一分鐘再說
  try {
    var students = getStudents_();
    var records = getRecords_(now.dateStr);
    var notices = getNotices_(now.dateStr);
    var leaves = getLeaves_();

    due.forEach(function (c) {
      students.filter(function (s) { return studentInCourse(s, c); }).forEach(function (s) {
        var checked = records.some(function (r) { return r.courseId === c.id && r.studentId === s.id; });
        var notified = notices.some(function (n) { return n.courseId === c.id && n.studentId === s.id && n.type === '未到'; });
        if (checked || notified || isOnLeave(leaves, now.dateStr, s.id, c.id)) return;
        notifyParents_(s, c, now, '未到',
          '【' + settings.schoolName + '】' + s.name + ' 今天 ' + formatHm(c.startMin) + ' 的「' + c.name +
          '」到目前（' + now.hm + '）尚未簽到，請留意孩子狀況。若已請假請告知老師。');
      });
    });
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
