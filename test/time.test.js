import { test } from "node:test";
import assert from "node:assert/strict";
import { localDateInZone, crossesDateLine, calendarDaysBetween } from "../src/time.js";

test("跨时区：乌鲁木齐深夜出生归一为登记地（上海）次日", () => {
  const t = "2026-09-30T23:30:00+06:00";
  assert.equal(localDateInZone(t, "Asia/Urumqi"), "2026-09-30");
  assert.equal(localDateInZone(t, "Asia/Shanghai"), "2026-10-01");
  assert.ok(crossesDateLine(t, "Asia/Urumqi", "Asia/Shanghai"));
});

test("同一绝对时刻在同一时区日期不变", () => {
  const t = "2026-10-01T08:15:00+08:00";
  assert.equal(localDateInZone(t, "Asia/Shanghai"), "2026-10-01");
  assert.equal(crossesDateLine(t, "Asia/Shanghai", "Asia/Shanghai"), false);
});

test("日历日差不受夏令时/时分影响", () => {
  assert.equal(calendarDaysBetween("2026-10-01", "2026-10-05"), 4);
  assert.equal(calendarDaysBetween("2026-09-30", "2026-10-01"), 1);
  assert.equal(calendarDaysBetween("2026-07-01", "2026-10-05"), 96);
});

test("非法时区与非法时间被拒绝", () => {
  assert.throws(() => localDateInZone("2026-10-01T08:00:00Z", "Asia/NoPlace"));
  assert.throws(() => localDateInZone("not-a-date", "Asia/Shanghai"));
});
