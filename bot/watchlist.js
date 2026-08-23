import { db, now } from "./db.js";
import { log } from "./config.js";
import { deepHistory, pairExists } from "./data/mexc.js";
import { num } from "./runtime.js";

db.exec(`
CREATE TABLE IF NOT EXISTS watchlist (
  symbol    TEXT PRIMARY KEY,
  added_at  INTEGER NOT NULL,
  stats     TEXT
);
`);

export const list = () =>
  db.prepare("SELECT * FROM watchlist ORDER BY symbol").all();
export const has = (s) =>
  Boolean(db.prepare("SELECT 1 FROM watchlist WHERE symbol=?").get(s));
export const remove = (s) =>
  db.prepare("DELETE FROM watchlist WHERE symbol=?").run(s).changes > 0;
export const add = (s, stats) =>
  db.prepare("INSERT OR REPLACE INTO watchlist(symbol,added_at,stats) VALUES(?,?,?)")
    .run(s, now(), stats ? JSON.stringify(stats) : null);
export const symbols = () => list().map(r => r.symbol);

/** ZEC · zec/usdt · ZECUSDT — всё приводим к одному виду. */
export function normalize(raw) {
  let s = String(raw || "").trim().toUpperCase()
    .replace(/[\/\-_ ]/g, "").replace(/\.P$/, "");
  if (!s) return null;
  if (!s.endsWith("USDT")) s += "USDT";
  return /^[A-Z0-9]{5,20}$/.test(s) ? s : null;
}

/**
 * Разбор монеты по истории: сколько сигналов дала каждая стратегия
 * и сколько из них оказались прибыльными.
 *
 * Считается той же лесенкой, что и в бою: 20% на каждой из пяти целей,
 * стоп в безубыток по текущей настройке.
 */
function simulate(c, i, long, entry, dist, hold, beAt) {
  const tg = [1,2,3,4,5].map(n => long ? entry + .5*n*dist : entry - .5*n*dist);
  const beLevel = beAt < 0.5 ? (long ? entry + beAt*dist : entry - beAt*dist) : null;
  let hit = 0, left = 1, banked = 0, be = false;
  let stop = long ? entry - dist : entry + dist;

  for (let j = i + 1; j < Math.min(c.length, i + 1 + hold); j++) {
    const b = c[j];
    if (long ? b.l <= stop : b.h >= stop)
      return { r: banked + left * ((long ? stop - entry : entry - stop) / dist),
               hit, stopped: hit === 0 && !be };
    if (beLevel != null && !be && (long ? b.h >= beLevel : b.l <= beLevel)) {
      be = true; stop = entry;
    }
    while (hit < 5 && (long ? b.h >= tg[hit] : b.l <= tg[hit])) {
      hit++; banked += 0.2 * 0.5 * hit; left -= 0.2;
      if (hit === 1) stop = entry;
    }
    if (hit === 5) return { r: banked, hit, stopped: false };
  }
  const last = c[Math.min(c.length, i + 1 + hold) - 1].c;
  return { r: banked + left * ((long ? last - entry : entry - last) / dist),
           hit, stopped: false };
}

const BARS_PER_DAY = { "5m": 288, "15m": 96, "1h": 24, "4h": 6, "1d": 1 };

/** Сколько дней монета вообще торгуется. */
export async function ageDays(symbol) {
  const d = await deepHistory(symbol, "1d", 400).catch(() => []);
  if (d.length < 2) return 0;
  return Math.round((d.at(-1).t - d[0].t) / 86400);
}

/**
 * Молодой монете родного таймфрейма не хватает: за месяц жизни часовых
 * свечей всего 720, а на прогрев индикаторов нужно 260 плюс запас.
 * Поэтому спускаемся по лесенке — час, пятнадцать минут, пять, — пока
 * не наберётся достаточно баров.
 *
 * Числа с мелких свечей с часовыми напрямую не сравнивать: стратегии
 * настраивались на часе, и на пяти минутах преимущество другое.
 */
const WANT_BARS = 3000;          // столько баров хватает на осмысленную выборку

function pickTf(native, age) {
  for (const tf of [native, "15m", "5m"]) {
    if (!BARS_PER_DAY[tf]) continue;
    if (age * BARS_PER_DAY[tf] >= WANT_BARS) return tf;
  }
  return "5m";
}

export async function analyze(symbol, strategies, months = 6) {
  const beAt = num("be_at") / 100;
  const out = [];
  const byTf = new Map();
  const age = await ageDays(symbol);

  for (const s of strategies) {
    // Старше трёх месяцев — считаем как обычно, на родном таймфрейме.
    // Моложе — спускаемся к мелким свечам: на часе у месячной монеты
    // выходит один-два сигнала, и это не статистика, а совпадение.
    const tf = age >= 90 ? s.timeframe : pickTf(s.timeframe, age);

    if (!byTf.has(tf)) {
      const want = Math.min(9000, Math.round(months * 30 * BARS_PER_DAY[tf]) + 300);
      byTf.set(tf, await deepHistory(symbol, tf, want).catch(() => []));
    }
    const c = byTf.get(tf);
    // Бывает, что пара торгуется, а свечей биржа не отдаёт — например
    // у металлов. Пустой массив тогда роняет расчёт, если не проверить.
    if (!c || c.length < s.warmup + 100) {
      const days = c && c.length > 1 ? (c.at(-1).t - c[0].t) / 86400 : 0;
      out.push({ id: s.id, short: true, days, bars: c ? c.length : 0, tf, age });
      continue;
    }
    // Держим одинаковое время, а не одинаковое число баров.
    const hold = Math.round(48 / (24 / BARS_PER_DAY[tf]));
    const x = s.prepare(c);
    let n = 0, win = 0, stops = 0, sumR = 0, t5 = 0;
    for (let i = s.warmup; i < c.length - 1 - hold; i++) {
      const sig = s.evaluate(c, x, i);
      if (!sig) continue;
      const r = simulate(c, i, sig.side === "long", sig.entry,
                         Math.abs(sig.entry - sig.sl), hold, beAt);
      n++; sumR += r.r;
      if (r.r > 0) win++;
      if (r.stopped) stops++;
      if (r.hit === 5) t5++;
    }
    const days = (c.at(-1).t - c[0].t) / 86400;
    out.push({ id: s.id, n, win, stops, t5, days, tf, age,
               native: tf === s.timeframe,
               avgR: n ? sumR / n : 0, perWeek: n ? n / days * 7 : 0 });
  }
  return out;
}

export async function check(symbol) {
  if (!await pairExists(symbol)) return "нет такой пары на MEXC";
  // Молодую монету не отсекаем — её разберём на мелких свечах.
  // Отказываем только если свечей нет вовсе.
  const probe = await deepHistory(symbol, "5m", 500).catch(() => []);
  if (probe.length < 300) return "пара есть, но биржа не отдаёт по ней свечи";
  return null;
}

/** Совсем ли нечего считать: ни одна стратегия не набрала истории. */
export const noHistory = (res) => res.every(r => r.short);

log(`список монет: ${list().length}`);
