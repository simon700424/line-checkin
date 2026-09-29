/**
 * 純邏輯函式：不碰 SpreadsheetApp / UrlFetchApp，
 * 可以在 Node 下測試（見 test/logic.test.js）。
 */

/** 兩點經緯度的距離（公尺），Haversine 公式。 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** "18:30" / "8:05" → 從午夜起算的分鐘數；格式錯誤回傳 null。 */
function parseHm(text) {
  var m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  var h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 分鐘數 → "HH:mm"。 */
function formatHm(minutes) {
  var h = Math.floor(minutes / 60), m = minutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

/** "S001, S002，S003" → ["S001","S002","S003"]（接受全形逗號、頓號、空白）。 */
function splitIds(text) {
  return String(text || '').split(/[,，、\s]+/).map(function (s) {
    return s.trim();
  }).filter(function (s) { return s; });
}

/** 星期欄位接受 1-7（一到日）或「一、二…日／天」，回傳 1-7；無法辨識回傳 null。 */
function parseWeekday(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/^(星期|週|周|禮拜)/, '').trim();
  var map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  if (map[s]) return map[s];
  var n = Number(s);
  return n >= 1 && n <= 7 ? n : null;
}

/** 課程是否在某天開課：星期符合，且沒有被停課。 */
function courseRunsOn(course, weekday, cancellations, dateStr) {
  if (course.weekday !== weekday) return false;
  return !cancellations.some(function (c) {
    return c.date === dateStr && (!c.courseId || c.courseId === course.id);
  });
}

/** 學生是否屬於該課程的班級（課程班級欄可逗號分隔多班）。 */
function studentInCourse(student, course) {
  var studentClasses = splitIds(student.classes);
  return splitIds(course.classes).some(function (c) {
    return studentClasses.indexOf(c) >= 0;
  });
}

/** 學生在這天這堂課是否請假（課程ID 空白 = 整天請假）。 */
function isOnLeave(leaves, dateStr, studentId, courseId) {
  return leaves.some(function (l) {
    return l.date === dateStr && l.studentId === studentId &&
      (!l.courseId || l.courseId === courseId);
  });
}

/**
 * 找出「現在可以簽到」的課：開始前 earlyMin 分鐘 ～ 下課前。
 * 多堂符合時取最早開始的那堂。
 */
function findActiveCourse(courses, nowMin, earlyMin) {
  var active = courses.filter(function (c) {
    return nowMin >= c.startMin - earlyMin && nowMin <= c.endMin;
  });
  active.sort(function (a, b) { return a.startMin - b.startMin; });
  return active[0] || null;
}

/** 簽到狀態：開始時間 + 寬限內為「準時」，否則「遲到」。 */
function decideStatus(nowMin, startMin, graceMin) {
  return nowMin <= startMin + graceMin ? '準時' : '遲到';
}

/**
 * 判斷定位是否可接受。
 * 回傳 { ok, distance, reason }；reason 是給學生看的訊息。
 */
function evaluateLocation(pos, course, maxAccuracy) {
  if (typeof pos.lat !== 'number' || typeof pos.lng !== 'number' ||
      isNaN(pos.lat) || isNaN(pos.lng)) {
    return { ok: false, distance: null, reason: '沒有取得定位，請允許 LINE 使用位置資訊後再試一次。' };
  }
  var distance = Math.round(haversineMeters(pos.lat, pos.lng, course.lat, course.lng));
  if (pos.accuracy && pos.accuracy > maxAccuracy) {
    return { ok: false, distance: distance, reason: '定位不夠準（誤差約 ' + Math.round(pos.accuracy) + ' 公尺），請移到窗邊或開啟 Wi-Fi 後再試。' };
  }
  if (distance > course.radius) {
    return { ok: false, distance: distance, reason: '你距離上課地點約 ' + distance + ' 公尺，超出簽到範圍（' + course.radius + ' 公尺）。' };
  }
  return { ok: true, distance: distance, reason: '' };
}

/** 是否該發「未到」通知：已過通知時間、還沒下課。 */
function isAbsentNoticeDue(nowMin, course, delayMin) {
  return nowMin >= course.startMin + delayMin && nowMin <= course.endMin;
}
