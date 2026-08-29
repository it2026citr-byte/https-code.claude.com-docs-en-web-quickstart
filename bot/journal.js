import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db, now } from "./db.js";
import { ROOT } from "./config.js";
import { fmtPrice } from "./format.js";
import { num } from "./runtime.js";

const DIR = join(ROOT, "storage", "journal");
mkdirSync(DIR, { recursive: true });

export const monthKey = (ts = now()) =>
  new Date(ts * 1000).toISOString().slice(0, 7);

/** «Aug-22, 6:49 PM» — тот же вид, что в базе Golden, чтобы данные склеивались. */
export function goldenTime(ts) {
  const d = new Date(ts * 1000);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  let h = d.getUTCHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mon}-${String(d.getUTCDate()).padStart(2,"0")}, ${h}:${String(d.getUTCMinutes()).padStart(2,"0")} ${ap}`;
}

const insert = db.prepare(
  "INSERT INTO journal(ts,month,kind,strategy,symbol,side,price,r_value,text,detail) " +
  "VALUES(?,?,?,?,?,?,?,?,?,?)"
);

export function logEvent(e) {
  const ts = e.ts ?? now();
  insert.run(ts, monthKey(ts), e.kind, e.strategy ?? null, e.symbol ?? null,
             e.side ?? null, e.price ?? null, e.r ?? null, e.text ?? null,
             e.detail ? JSON.stringify(e.detail) : null);
}

// --- статусы в терминах Golden ----------------------------------------------
// Названия совпадают с golden-signals-all.csv, чтобы обе базы анализировались
// одним скриптом. Русские подписи — только для чата.
export function goldenStatus(p) {
  if (p.close_reason === "stop") return "Stop Loss hit";
  if (p.close_reason === "cancelled") return "Cancelled";
  if (p.close_reason === "broken") return "Strategy broken";
  if (p.close_reason === "manual") return "Closed manually";
  if (p.tp_hit > 0) return `Target ${p.tp_hit}`;
  return "Closed";
}
const RU = {
  "Stop Loss hit": "Стоп",
  "Cancelled": "Отменён",
  "Strategy broken": "Слом стратегии",
  "Closed manually": "Закрыт вручную",
  "Closed": "Закрыт",
};
export const ruStatus = (s) => RU[s] ?? s.replace(/^Target (\d)$/, "Цель $1");

const ICON = {
  "Stop Loss hit": "🔴", "Cancelled": "⚪️",
  "Strategy broken": "🟠", "Closed manually": "⚫️", "Closed": "⚫️",
};
const icon = (s) => ICON[s] ?? (s.startsWith("Target") ? "🟢" : "⚫️");

/** 1 сделка · 2 сделки · 5 сделок */
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const deals = (n) => `${n} ${plural(n, ["сделка", "сделки", "сделок"])}`;

// --- выборки ----------------------------------------------------------------
export const closedBetween = (from, to) =>
  db.prepare(
    "SELECT * FROM positions WHERE status='closed' AND closed_at>=? AND closed_at<? " +
    "ORDER BY closed_at"
  ).all(from, to);

export const closedInMonth = (m) => {
  const from = Math.floor(Date.parse(m + "-01T00:00:00Z") / 1000);
  const [y, mo] = m.split("-").map(Number);
  const to = Math.floor(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) / 1000);
  return closedBetween(from, to);
};

// --- карточка сигнала, как в приложении -------------------------------------
export function card(p) {
  const st = goldenStatus(p);
  const dir = p.side === "long" ? "LONG" : "SHORT";
  // У отменённого сигнала результата нет — и цифры 0.00R быть не должно.
  const cancelled = p.close_reason === "cancelled";
  const r = cancelled || p.r_result == null ? "" :
    ` · <b>${p.r_result > 0 ? "+" : ""}${p.r_result.toFixed(2)}R</b>`;
  const levels = cancelled ? "сигнал снят до входа"
    : `Вход ${fmtPrice(p.entry)} · Стоп ${fmtPrice(p.sl)}${r}`;
  return [
    `${icon(st)} <b>${ruStatus(st)}</b>  ${dir} ${p.symbol}`,
    levels,
    `<i>${goldenTime(p.closed_at)} · ${p.strategy}</i>`,
  ].join("\n");
}

const TF_RU = { "15m": "15м", "1h": "1ч", "4h": "4ч", "1d": "1д" };

/** Карточка нового сигнала — то, на что жмут «Взял» или «Пропустил». */
const v1 = (x) => x == null ? "—" : x.toFixed(1) + "%";

/** ⟨1г 4.9% · 3м 6.3% · 2н 8.1%⟩ — средний дневной ход монеты. */
function volBlock(vol) {
  const v = typeof vol === "string" ? (() => { try { return JSON.parse(vol); } catch { return null; } })() : vol;
  if (!v) return "";
  // Монета моложе года — говорим об этом тильдой, а не выдаём
  // неполное окно за годовое.
  const y = v.n != null && v.n < 365 && v.y != null ? "~" + v1(v.y) : v1(v.y);
  return ` ⟨1г ${y} · 3м ${v1(v.q)} · 2н ${v1(v.w)}⟩ `;
}

/** Насколько остальные стратегии близки к тому же выводу. */
function agreeBlock(raw) {
  const a = typeof raw === "string"
    ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
    : raw;
  if (!Array.isArray(a) || !a.length) return "";
  const rows = a.map(z => {
    const full = z.hit === z.all;
    const bar = "▰".repeat(z.hit) + "▱".repeat(Math.max(0, z.all - z.hit));
    const miss = full ? "" :
      `\n   <i>нет: ${z.miss.slice(0, 2).join(", ")}` +
      `${z.miss.length > 2 ? ` и ещё ${z.miss.length - 2}` : ""}</i>`;
    return `${full ? "✅" : "▫️"} ${bar} <b>${z.hit}/${z.all}</b> ${z.id}${miss}`;
  });
  return `\n\n<b>Согласие стратегий</b>\n${rows.join("\n")}`;
}

/** Время бара сигнала в поясе владельца: «14:00 28.08 (UTC+3)». */
function signalTime(s) {
  const t = s.barTime ?? s.bar_time;
  if (!t) return null;
  const tz = num("tz");
  const d = new Date((t + tz * 3600) * 1000).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}.${d.slice(5, 7)} (UTC+${tz})`;
}

export function signalCard(s) {
  const long = s.side === "long";
  const pct = Math.abs(s.sl - s.entry) / s.entry * 100;
  const when = signalTime(s);
  return [
    `${long ? "📈" : "📉"} <b>${long ? "LONG" : "SHORT"}</b> ${s.symbol}` +
      volBlock(s.vol) + `  <i>${s.strategy} · ${TF_RU[s.tf] ?? s.tf}</i>`,
    `Вход <b>${fmtPrice(s.entry)}</b> · Стоп <b>${fmtPrice(s.sl)}</b> (${pct.toFixed(2)}%)` +
      (when ? ` · ⏱ ${when}` : ""),
    `Цели ${s.targets.map(fmtPrice).join(" · ")}`,
    s.figuresText ? `Фигура: ${s.figuresText}` : null,
    s.reason ? `<i>${s.reason}</i>` : null,
  ].filter(Boolean).join("\n") + agreeBlock(s.agree);
}

export function digest(rows, title) {
  if (!rows.length) return `<b>${title}</b>\n\nЗакрытых сигналов нет.`;
  const newestFirst = [...rows].sort((a, b) => b.closed_at - a.closed_at);
  return `<b>${title}</b>\n\n` +
         newestFirst.map(card).join("\n\n") +
         `\n\n———\n${summaryLine(stats(rows))}`;
}

// --- статистика -------------------------------------------------------------
export function stats(rows) {
  const done = rows.filter(r => r.close_reason !== "cancelled");
  const byStatus = {};
  for (const r of rows) {
    const s = goldenStatus(r);
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const rs = done.map(r => r.r_result ?? 0);
  const sum = rs.reduce((a, b) => a + b, 0);
  const wins = done.filter(r => (r.r_result ?? 0) > 0).length;
  const byStrategy = {};
  for (const r of done) {
    const k = r.strategy;
    byStrategy[k] ??= { n: 0, r: 0, wins: 0 };
    byStrategy[k].n++;
    byStrategy[k].r += r.r_result ?? 0;
    if ((r.r_result ?? 0) > 0) byStrategy[k].wins++;
  }
  return {
    total: rows.length, done: done.length, byStatus, byStrategy,
    sumR: sum, avgR: done.length ? sum / done.length : 0,
    winrate: done.length ? wins / done.length : 0,
  };
}

export function summaryLine(s) {
  if (!s.done) return "<i>Сделок, дошедших до результата, нет.</i>";
  return `${deals(s.done)} · винрейт ${(s.winrate * 100).toFixed(0)}% · ` +
         `итог <b>${s.sumR > 0 ? "+" : ""}${s.sumR.toFixed(2)}R</b> ` +
         `(среднее ${s.avgR > 0 ? "+" : ""}${s.avgR.toFixed(2)}R)`;
}

export function monthReport(m) {
  const rows = closedInMonth(m);
  const s = stats(rows);
  if (!rows.length) return `<b>Итоги ${m}</b>\n\nЗакрытых сигналов за месяц нет.`;

  const order = ["Target 5","Target 4","Target 3","Target 2","Target 1",
                 "Strategy broken","Stop Loss hit","Closed manually","Cancelled"];
  const lines = order.filter(k => s.byStatus[k]).map(k => {
    const n = s.byStatus[k];
    const pct = (n / s.total * 100).toFixed(0);
    return `${icon(k)} ${ruStatus(k)} — <b>${n}</b> (${pct}%)`;
  });

  const strat = Object.entries(s.byStrategy)
    .sort((a, b) => b[1].r - a[1].r)
    .map(([k, v]) =>
      `• ${k}: ${deals(v.n)}, ${(v.wins / v.n * 100).toFixed(0)}%, ` +
      `${v.r > 0 ? "+" : ""}${v.r.toFixed(2)}R`);

  return [
    `<b>Итоги ${m}</b>`, "",
    ...lines, "",
    summaryLine(s), "",
    "<b>По стратегиям</b>", ...strat,
  ].join("\n");
}

// --- выгрузка в файлы -------------------------------------------------------
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * CSV ровно в колонках golden-signals-all.csv плюс наши четыре.
 * Значит месячный файл бота можно просто подклеить к базе Golden
 * и анализировать одним скриптом.
 */
export function exportMonthCsv(m) {
  const rows = closedInMonth(m);
  const head = ["Closed","Type","Pair","Status","Target_Reached",
                "Entry_price","Stop_Loss","Strategy","Opened","R","Timeframe"];
  const body = rows.map(p => [
    goldenTime(p.closed_at),
    p.side === "long" ? "LONG" : "SHORT",
    p.symbol,
    goldenStatus(p),
    p.tp_hit ?? 0,
    p.close_reason === "cancelled" ? "" : p.entry,
    p.close_reason === "cancelled" ? "" : p.sl,
    p.strategy,
    goldenTime(p.opened_at),
    p.r_result ?? "",
    p.tf,
  ].map(csvCell).join(","));

  const path = join(DIR, `${m}.csv`);
  writeFileSync(path, [head.join(","), ...body].join("\n") + "\n", "utf8");
  return { path, count: rows.length };
}

/** Полная лента событий месяца — то, что не влезает в CSV сделок. */
export function exportMonthLog(m) {
  const ev = db.prepare(
    "SELECT * FROM journal WHERE month=? ORDER BY ts").all(m);
  const lines = ev.map(e => {
    const head = `${goldenTime(e.ts)}  [${e.kind}]`;
    const who = [e.symbol, e.side ? e.side.toUpperCase() : null, e.strategy]
      .filter(Boolean).join(" ");
    const px = e.price != null ? ` @ ${fmtPrice(e.price)}` : "";
    const r = e.r_value != null ? ` (${e.r_value > 0 ? "+" : ""}${e.r_value.toFixed(2)}R)` : "";
    return `${head}  ${who}${px}${r}${e.text ? " — " + e.text : ""}`;
  });
  const path = join(DIR, `${m}.log.txt`);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { path, count: ev.length };
}

export function availableMonths() {
  return db.prepare("SELECT DISTINCT month FROM journal ORDER BY month DESC")
           .all().map(r => r.month);
}
