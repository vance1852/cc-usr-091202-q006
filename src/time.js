// 跨时区出生日期归一：医院出生时刻（带偏移的绝对时间）-> 登记地当地日历日期
// 不依赖第三方库，仅使用 Node 内置 Intl（full-icu）。

const DATE_FORMATTER_CACHE = new Map();

function formatter(zone) {
  let f = DATE_FORMATTER_CACHE.get(zone);
  if (!f) {
    // en-CA 输出 YYYY-MM-DD，避免从本地化字符串解析日期
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DATE_FORMATTER_CACHE.set(zone, f);
  }
  return f;
}

export function isValidZone(zone) {
  try {
    formatter(zone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// 返回登记地/医院地的当地日历日期 'YYYY-MM-DD'
export function localDateInZone(instantIso, zone) {
  if (!isValidZone(zone)) {
    throw new Error(`不支持的时区: ${zone}`);
  }
  const d = new Date(instantIso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`无法解析的出生时刻: ${instantIso}`);
  }
  return formatter(zone).format(d);
}

// 两个时区间的当地日历日期是否因跨时区而不同（同一绝对时刻）
export function crossesDateLine(instantIso, fromZone, toZone) {
  return localDateInZone(instantIso, fromZone) !== localDateInZone(instantIso, toZone);
}

// 仅按日历日计算相差天数（b - a），输入 'YYYY-MM-DD'，避免夏令时/时分干扰
export function calendarDaysBetween(fromDate, toDate) {
  const [y1, m1, d1] = fromDate.split("-").map(Number);
  const [y2, m2, d2] = toDate.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

export function toDateInput(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(
    x.getDate(),
  ).padStart(2, "0")}`;
}
