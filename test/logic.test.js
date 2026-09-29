// 以 Node 內建測試執行：node --test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/Logic.gs'), 'utf8'), ctx);
const L = ctx;

const course = { id: 'M1', classes: 'A班', weekday: 2, startMin: 18 * 60 + 30, endMin: 20 * 60 + 30, lat: 22.0019, lng: 120.7445, radius: 80 };

test('haversineMeters：同一點 0、約 111 公尺/0.001 緯度', () => {
  assert.strictEqual(L.haversineMeters(22, 120, 22, 120), 0);
  const d = L.haversineMeters(22, 120, 22.001, 120);
  assert.ok(d > 110 && d < 112, d);
});

test('parseHm / formatHm', () => {
  assert.strictEqual(L.parseHm('18:30'), 1110);
  assert.strictEqual(L.parseHm('8:05'), 485);
  assert.strictEqual(L.parseHm('24:00'), null);
  assert.strictEqual(L.parseHm('abc'), null);
  assert.strictEqual(L.formatHm(485), '08:05');
});

test('splitIds 接受全形逗號與頓號', () => {
  assert.deepStrictEqual(Array.from(L.splitIds('S001, S002，S003、S004')), ['S001', 'S002', 'S003', 'S004']);
  assert.deepStrictEqual(Array.from(L.splitIds('')), []);
});

test('parseWeekday', () => {
  assert.strictEqual(L.parseWeekday('二'), 2);
  assert.strictEqual(L.parseWeekday('星期日'), 7);
  assert.strictEqual(L.parseWeekday('週六'), 6);
  assert.strictEqual(L.parseWeekday(3), 3);
  assert.strictEqual(L.parseWeekday('8'), null);
});

test('courseRunsOn：星期與停課', () => {
  assert.ok(L.courseRunsOn(course, 2, [], '2026-09-29'));
  assert.ok(!L.courseRunsOn(course, 3, [], '2026-09-29'));
  assert.ok(!L.courseRunsOn(course, 2, [{ date: '2026-09-29', courseId: '' }], '2026-09-29'), '全部停課');
  assert.ok(!L.courseRunsOn(course, 2, [{ date: '2026-09-29', courseId: 'M1' }], '2026-09-29'));
  assert.ok(L.courseRunsOn(course, 2, [{ date: '2026-09-29', courseId: 'E1' }], '2026-09-29'), '別堂停課不影響');
});

test('studentInCourse：多班級', () => {
  assert.ok(L.studentInCourse({ classes: 'B班, A班' }, course));
  assert.ok(!L.studentInCourse({ classes: 'B班' }, course));
});

test('isOnLeave：整天或指定課程', () => {
  const leaves = [{ date: '2026-09-29', studentId: 'S1', courseId: '' }, { date: '2026-09-29', studentId: 'S2', courseId: 'E1' }];
  assert.ok(L.isOnLeave(leaves, '2026-09-29', 'S1', 'M1'));
  assert.ok(!L.isOnLeave(leaves, '2026-09-29', 'S2', 'M1'));
  assert.ok(L.isOnLeave(leaves, '2026-09-29', 'S2', 'E1'));
  assert.ok(!L.isOnLeave(leaves, '2026-09-30', 'S1', 'M1'));
});

test('findActiveCourse：提前開放、下課後關閉、取最早', () => {
  const c2 = Object.assign({}, course, { id: 'M2', startMin: 19 * 60, endMin: 21 * 60 });
  assert.strictEqual(L.findActiveCourse([course], 18 * 60 + 14, 15), null);
  assert.strictEqual(L.findActiveCourse([course], 18 * 60 + 15, 15).id, 'M1');
  assert.strictEqual(L.findActiveCourse([c2, course], 19 * 60 + 5, 15).id, 'M1');
  assert.strictEqual(L.findActiveCourse([course], 20 * 60 + 31, 15), null);
});

test('decideStatus', () => {
  assert.strictEqual(L.decideStatus(1115, 1110, 5), '準時');
  assert.strictEqual(L.decideStatus(1116, 1110, 5), '遲到');
});

test('evaluateLocation：範圍內、範圍外、精度差、無定位', () => {
  assert.ok(L.evaluateLocation({ lat: 22.0019, lng: 120.7445, accuracy: 20 }, course, 150).ok);
  const far = L.evaluateLocation({ lat: 22.0030, lng: 120.7445, accuracy: 20 }, course, 150);
  assert.ok(!far.ok && far.distance > 100);
  assert.ok(!L.evaluateLocation({ lat: 22.0019, lng: 120.7445, accuracy: 500 }, course, 150).ok);
  assert.ok(!L.evaluateLocation({ lat: NaN, lng: 120 }, course, 150).ok);
});

test('isAbsentNoticeDue', () => {
  assert.ok(!L.isAbsentNoticeDue(1110 + 9, course, 10));
  assert.ok(L.isAbsentNoticeDue(1110 + 10, course, 10));
  assert.ok(!L.isAbsentNoticeDue(course.endMin + 1, course, 10));
});

test('findSetupProblems：課表班級對不到學生、學生缺學號、半徑太小', () => {
  const students = [{ id: '410621', classes: '觀二甲' }];
  const courses = [{ id: 'D2', classes: 'A', radius: 50 }];
  const friends = [
    { name: '李國祿老師', role: '學生', studentIds: [] },
    { name: '陳慈宇', role: '學生', studentIds: ['410621'] },
    { name: '某家長', role: '家長', studentIds: ['999'] },
    { name: '新朋友', role: '', studentIds: [] }
  ];
  const p = Array.from(L.findSetupProblems(students, courses, friends)).join('\n');
  assert.match(p, /課表「D2」的班級「A」在學生表裡找不到.*觀二甲/);
  assert.match(p, /學生表的班級「觀二甲」在課表裡沒有任何課/);
  assert.match(p, /半徑只有 50/);
  assert.match(p, /李國祿老師」是學生，學號欄要填剛好一個學號/);
  assert.match(p, /某家長」填的學號「999」不在學生表裡/);
  assert.match(p, /新朋友」還沒填角色/);
  assert.doesNotMatch(p, /陳慈宇/);
  assert.strictEqual(L.findSetupProblems(students, [{ id: 'D2', classes: '觀二甲', radius: 100 }], [friends[1]]).length, 0);
});
