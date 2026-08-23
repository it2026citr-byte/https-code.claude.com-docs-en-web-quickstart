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
export function propose(c, { legs = 20, padAtr = 0.4, maxZones = 6, lookback = 600 } = {}) {
  const A = atr(c, 14);
  const i = c.length - 2;
  const px = c[i].c, pad = padAtr * A[i];
  if (!px || !A[i]) return [];
  const from = Math.max(legs, i - lookback);

  // Свинговые экстремумы: бар выше (ниже) соседей слева и справа.
  const raw = [];
  for (let j = from; j < i - legs; j++) {
    let hi = true, lo = true;
    for (let k = j - legs; k <= j + legs; k++) {
      if (k === j) continue;
      if (c[k].h >= c[j].h) hi = false;
      if (c[k].l <= c[j].l) lo = false;
    }
    if (hi) raw.push({ lvl: c[j].h, bar: j });
    if (lo) raw.push({ lvl: c[j].l, bar: j });
  }

  // Слипаем близкие в один уровень: чем больше касаний, тем он весомее —
  // ровно так уровень и выбирают глазом.
  const clusters = [];
  for (const r of raw.sort((x, y) => x.lvl - y.lvl)) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(r.lvl - last.lvl) <= pad) {
      last.lvl = (last.lvl * last.hits + r.lvl) / (last.hits + 1);
      last.hits++;
      last.bar = Math.max(last.bar, r.bar);
    } else clusters.push({ lvl: r.lvl, hits: 1, bar: r.bar });
  }

  const cand = clusters
    .map(z => ({ ...z, away: Math.abs(z.lvl - px) / px * 100,
                 side: z.lvl < px ? "long" : "short" }))
    .filter(z => z.away >= 0.4 && z.away <= 40);

  const pick = (side, n) => cand.filter(z => z.side === side)
    .sort((x, y) => (y.hits - x.hits) || (x.away - y.away))
    .sort((x, y) => x.away - y.away)
    .slice(0, n);

  const half = Math.max(1, Math.round(maxZones / 2));
  return [...pick("long", half), ...pick("short", half)]
    .map(z => ({
      side: z.side, lo: z.lvl - pad, hi: z.lvl + pad, level: z.lvl,
      away: z.away.toFixed(1), hits: z.hits,
      note: `${z.hits} ${z.hits === 1 ? "касание" : z.hits < 5 ? "касания" : "касаний"}` +
            `, последнее ${i - z.bar} ч назад`,
    }))
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

export const symbols = () =>
  [...new Set(all().map(z => z.symbol))];

log(`зон в работе: ${all().length}`);
