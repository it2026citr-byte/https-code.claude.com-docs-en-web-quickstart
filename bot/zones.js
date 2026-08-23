import { db, now } from "./db.js";
import { log } from "./config.js";
import { atr } from "./indicators.js";
import { structureBias, BULL, BEAR } from "./smc.js";

/**
 * Зоны интереса — уровни, у которых ждём цену.
 *
 * Проверка показала, что механический вывод уровней из структуры не даёт
 * преимущества: выбор уровней и есть суть метода, а он не кодируется.
 * Поэтому здесь разделение труда: бот предлагает кандидатов при
 * добавлении монеты, решение остаётся за человеком, а дальше бот
 * караулит цену круглосуточно, чего человек не может.
 *
 * Зона — это диапазон, а не цена: у авторов разборов всегда
 * «0,01810–0,01661», потому что импульсные проколы реальны.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS zones (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol    TEXT NOT NULL,
  side      TEXT NOT NULL,            -- long | short
  lo        REAL NOT NULL,
  hi        REAL NOT NULL,
  note      TEXT,
  source    TEXT NOT NULL DEFAULT 'manual',   -- manual | auto
  created_at INTEGER NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1,
  near_at   INTEGER,                  -- когда предупредили о подходе
  fired_at  INTEGER                   -- когда выдали сигнал
);
CREATE INDEX IF NOT EXISTS zones_sym ON zones(symbol, active);
`);

export const all = () =>
  db.prepare("SELECT * FROM zones WHERE active=1 ORDER BY symbol, side, lo").all();
export const forSymbol = (s) =>
  db.prepare("SELECT * FROM zones WHERE symbol=? AND active=1 ORDER BY side, lo").all(s);
export const get = (id) =>
  db.prepare("SELECT * FROM zones WHERE id=?").get(id);
export const remove = (id) =>
  db.prepare("UPDATE zones SET active=0 WHERE id=?").run(id).changes > 0;
export const removeSymbol = (s) =>
  db.prepare("UPDATE zones SET active=0 WHERE symbol=?").run(s).changes;

export function add({ symbol, side, lo, hi, note, source = "manual" }) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  return Number(db.prepare(
    "INSERT INTO zones(symbol,side,lo,hi,note,source,created_at) VALUES(?,?,?,?,?,?,?)"
  ).run(symbol, side, a, b, note ?? null, source, now()).lastInsertRowid);
}

export function edit(id, { lo, hi, note }) {
  const z = get(id);
  if (!z) return false;
  const a = lo ?? z.lo, b = hi ?? z.hi;
  db.prepare("UPDATE zones SET lo=?, hi=?, note=?, near_at=NULL, fired_at=NULL WHERE id=?")
    .run(Math.min(a, b), Math.max(a, b), note ?? z.note, id);
  return true;
}

/** Сбросить отметки, чтобы зона снова могла сработать. */
export const rearm = (id) =>
  db.prepare("UPDATE zones SET near_at=NULL, fired_at=NULL WHERE id=?").run(id);

/**
 * Кандидаты в зоны по истории.
 *
 * Берём подтверждённые свинговые уровни и пробитые структуры: именно они
 * в разборах называются «уровнями-ловушками». Человек потом решает,
 * какие оставить.
 */
/** Консолидации: окна, где цена держалась в узкой полосе. */
function boxes(c, win = 12, maxPct = 3) {
  const raw = [];
  for (let i = win; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - win; j < i; j++) {
      if (c[j].h > hi) hi = c[j].h;
      if (c[j].l < lo) lo = c[j].l;
    }
    if ((hi - lo) / ((hi + lo) / 2) * 100 <= maxPct) raw.push({ a: i - win, b: i, hi, lo });
  }
  const out = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b) {
      last.b = r.b; last.hi = Math.max(last.hi, r.hi); last.lo = Math.min(last.lo, r.lo);
    } else out.push({ ...r });
  }
  return out;
}

function swings(c, len = 5) {
  const out = [];
  for (let i = len; i < c.length - len; i++) {
    let hi = true, lo = true;
    for (let j = i - len; j <= i + len; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) hi = false;
      if (c[j].l <= c[i].l) lo = false;
    }
    if (hi) out.push(c[i].h);
    if (lo) out.push(c[i].l);
  }
  return out;
}

/** Цены, где накоплен объём: свеча разносит свой объём по своему диапазону. */
function volumeNodes(c, bins = 160, topShare = 0.25) {
  const hi = Math.max(...c.map(x => x.h)), lo = Math.min(...c.map(x => x.l));
  if (!(hi > lo)) return [];
  const step = (hi - lo) / bins, vol = new Array(bins).fill(0);
  for (const b of c) {
    const a = Math.max(0, Math.floor((b.l - lo) / step));
    const z = Math.min(bins - 1, Math.floor((b.h - lo) / step));
    for (let k = a; k <= z; k++) vol[k] += (b.v || 0) / (z - a + 1);
  }
  return [...vol.keys()].sort((x, y) => vol[y] - vol[x])
    .slice(0, Math.max(3, Math.round(bins * topShare)))
    .map(i => lo + (i + 0.5) * step);
}

function roundLevels(px) {
  const mag = Math.pow(10, Math.floor(Math.log10(px)) - 1), out = [];
  for (let k = -40; k <= 40; k++) {
    const v = Math.round(px / mag + k) * mag;
    if (v > 0) out.push(v);
  }
  return out;
}

/**
 * Кандидаты в зоны.
 *
 * Признаки и их вес выведены из 108 зон канала: каждый сравнивался
 * со случайным уровнем по тому же набору, иначе густые наборы дают
 * мнимое совпадение. Прибавка над случайностью:
 *
 *   граница консолидации  +17 пп   ← сильнейший, отсюда вес 2
 *   мелкий свинг 1ч       +14 пп
 *   узел объёма           +13 пп
 *   круглое число         +12 пп
 *
 * Ни один признак сам по себе не воспроизводит его выбор, поэтому
 * берём совпадение нескольких: уровень, за который голосуют три-четыре
 * признака, встречается у него заметно чаще случайного.
 */
export const WEIGHTS = { box: 2, swing: 1, vol: 1, round: 1, touch: 0 };

export function propose(c, opts = {}) {
  const { maxZones = 6, minScore = 2, nearPct = 0.5 } = opts;
  const W = { ...WEIGHTS, ...(opts.weights || {}) };
  const A = atr(c, 14);
  const i = c.length - 2;
  const px = c[i].c, a = A[i];
  if (!px || !a) return [];

  const bx = boxes(c);
  const sw = swings(c);
  const vn = volumeNodes(c);
  const rn = roundLevels(px);
  const near = (list, v) => list.some(x => Math.abs(x - v) / v * 100 <= nearPct);

  // Кандидаты — границы боковиков и свинговые точки.
  const cand = [];
  for (const b of bx) {
    cand.push({ lvl: b.lo, box: b, why: ["граница боковика"] });
    cand.push({ lvl: b.hi, box: b, why: ["граница боковика"] });
  }
  for (const v of sw) cand.push({ lvl: v, box: null, why: ["свинговая точка"] });

  for (const z of cand) {
    z.score = z.box ? W.box : W.swing;
    if (z.box && near(sw, z.lvl)) { z.score += W.swing; z.why.push("свинговая точка"); }
    if (near(vn, z.lvl)) { z.score += W.vol; z.why.push("узел объёма"); }
    if (near(rn, z.lvl)) { z.score += W.round; z.why.push("круглое число"); }
  }

  // Слипаем близкие, оставляя лучший балл.
  cand.sort((x, y) => x.lvl - y.lvl);
  const glue = a * 0.3, merged = [];
  for (const z of cand) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(z.lvl - last.lvl) <= glue) {
      if (z.score > last.score) Object.assign(last, z);
      last.hits = (last.hits || 1) + 1;
    } else merged.push({ ...z, hits: 1 });
  }
  // Уровень, к которому история возвращалась много раз, весомее одиночного.
  if (W.touch) for (const z of merged) z.score += W.touch * Math.min(4, z.hits - 1);

  const out = [];
  for (const z of merged) {
    if (z.score < minScore) continue;
    const side = z.lvl < px ? "long" : "short";
    const away = Math.abs(z.lvl - px) / px * 100;
    // Дальше пятнадцати процентов зона бесполезна: цена дойдёт нескоро,
    // а к тому времени структура успеет перестроиться.
    if (away < 0.4 || away > 15) continue;

    // Зона от боковика берёт его границы — так рисует и он.
    // Одиночный уровень обрастает половиной ATR.
    let lo, hi;
    if (z.box && (z.box.hi - z.box.lo) / px * 100 <= 9) { lo = z.box.lo; hi = z.box.hi; }
    else { lo = z.lvl - 0.25 * a; hi = z.lvl + 0.25 * a; }
    if (side === "long" && hi >= px) continue;
    if (side === "short" && lo <= px) continue;

    out.push({
      side, lo, hi, level: z.lvl, score: z.score,
      away: away.toFixed(1),
      width: ((hi - lo) / px * 100).toFixed(1),
      note: z.why.join(" + "),
    });
  }

  // Одинаковые и вложенные зоны схлопываем: несколько окон боковика
  // дают один и тот же диапазон.
  const uniq = [];
  for (const z of out.sort((x, y) => y.score - x.score)) {
    const dup = uniq.find(u => u.side === z.side &&
      Math.abs(u.lo - z.lo) / px * 100 < 0.5 && Math.abs(u.hi - z.hi) / px * 100 < 0.5);
    const inside = uniq.find(u => u.side === z.side && z.lo >= u.lo && z.hi <= u.hi);
    if (!dup && !inside) uniq.push(z);
  }

  // Сильные зоны важнее близких, но при равном балле берём ближнюю.
  const pick = (side, n) => uniq.filter(z => z.side === side)
    .sort((x, y) => (y.score - x.score) || (Number(x.away) - Number(y.away)))
    .slice(0, n);
  const half = Math.max(1, Math.round(maxZones / 2));
  return [...pick("long", half), ...pick("short", half)]
    .sort((x, y) => Number(x.away) - Number(y.away));
}

/**
 * Проверка цены по зонам.
 *   near  — цена подошла ближе чем на nearPct к границе
 *   enter — цена вошла в зону
 */
export function check(prices, { nearPct = 1.5, cooldownH = 12 } = {}) {
  const events = [];
  const t = now();
  for (const z of all()) {
    const px = prices[z.symbol];
    if (px == null) continue;

    const inside = px >= z.lo && px <= z.hi;
    const edge = z.side === "long" ? z.hi : z.lo;
    const distPct = Math.abs(px - edge) / px * 100;
    const approaching = !inside &&
      (z.side === "long" ? px > z.hi : px < z.lo) && distPct <= nearPct;

    if (inside) {
      if (z.fired_at && t - z.fired_at < cooldownH * 3600) continue;
      db.prepare("UPDATE zones SET fired_at=? WHERE id=?").run(t, z.id);
      events.push({ kind: "enter", zone: z, price: px });
    } else if (approaching) {
      if (z.near_at && t - z.near_at < cooldownH * 3600) continue;
      db.prepare("UPDATE zones SET near_at=? WHERE id=?").run(t, z.id);
      events.push({ kind: "near", zone: z, price: px, distPct });
    }
  }
  return events;
}

/**
 * Сделка от зоны: вход по текущей цене, стоп за дальней границей.
 * В этом весь смысл входа от уровня — стоп рядом, значит то же движение
 * стоит больше R.
 */
export function tradeFrom(zone, price, atrVal) {
  const long = zone.side === "long";
  const edge = long ? zone.lo : zone.hi;
  const pad = 0.5 * (atrVal || Math.abs(zone.hi - zone.lo));
  let dist = Math.abs(price - edge) + pad;
  const minD = 0.8 * (atrVal || dist), maxD = 2.5 * (atrVal || dist);
  dist = Math.min(Math.max(dist, minD), maxD);
  const sl = long ? price - dist : price + dist;
  const targets = [1, 2, 3, 4, 5].map(n =>
    long ? price + 0.5 * n * dist : price - 0.5 * n * dist);
  return { side: zone.side, entry: price, sl, targets, dist };
}

export const symbols = () =>
  [...new Set(all().map(z => z.symbol))];

log(`зон в работе: ${all().length}`);
