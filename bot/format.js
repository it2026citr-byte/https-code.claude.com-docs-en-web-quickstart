/** Цена с разумным числом знаков: 77228.03, 4.9450, 0.00012345 */
export function fmtPrice(p) {
  const a = Math.abs(p);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return p.toFixed(d).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}
export const fmtPct = (x) => (x > 0 ? "+" : "") + x.toFixed(2) + "%";

export function fmtUsd(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + " млрд";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + " млн";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + " тыс";
  return v.toFixed(0);
}

/** «2 ч 14 мин», «3 дн 5 ч», «47 сек» */
export function fmtAgo(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} сек`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${m % 60} мин`;
  const d = Math.floor(h / 24);
  return `${d} дн ${h % 24} ч`;
}

export const fmtTime = (sec) =>
  new Date(sec * 1000).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
