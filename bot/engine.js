import { db, now, openPositions } from "./db.js";
import { cfg, log } from "./config.js";
import { topPairs } from "./data/tradingview.js";
import { fetchKlines, TF_SEC } from "./data/mexc.js";
import { candles } from "./candles.js";
import { dailyVolatility } from "./indicators.js";
import { logEvent } from "./journal.js";
import { num } from "./runtime.js";
import { symbols as watchSymbols, paramsFor } from "./watchlist.js";

/** Ограничитель параллельности — чтобы не долбить биржу и не греть телефон. */
async function mapLimit(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const { value, done } = it.next();
      if (done) return;
      try { await fn(value); } catch (e) { log("задача сорвалась:", e.message); }
    }
  });
  await Promise.all(workers);
}

const insertSignal = db.prepare(
  "INSERT OR IGNORE INTO signals" +
  "(strategy,symbol,side,tf,entry,sl,targets,reason,created_at,bar_time,status,vol,agree) " +
  "VALUES(?,?,?,?,?,?,?,?,?,?,'new',?,?)"
);

/**
 * Средний дневной ход за год, 3 месяца и 2 недели.
 * Дневные свечи тянем только по парам, где сигнал уже нашёлся, —
 * тащить их по всем 68 парам каждые 15 минут незачем.
 */
const volCache = new Map();
async function volatility(symbol) {
  const hit = volCache.get(symbol);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.v;
  try {
    const d = await fetchKlines(symbol, "1d", 400);
    const v = {
      y: dailyVolatility(d, 365),
      q: dailyVolatility(d, 90),
      w: dailyVolatility(d, 14),
      n: d.length,          // сколько дней истории реально есть
    };
    volCache.set(symbol, { at: Date.now(), v });
    return v;
  } catch (e) {
    log(`волатильность ${symbol} не посчиталась:`, e.message);
    return null;
  }
}

/**
 * Один проход по рынку. Стратегии считаются на последнем ЗАКРЫТОМ баре —
 * текущий ещё формируется, по нему решения не принимаются.
 */
export async function scanMarket(strategies, onSignal, onUpdate) {
  if (!strategies.length) return { pairs: 0, signals: 0 };

  // Монеты из моего списка сканируются всегда, независимо от оборота.
  // Настройка «только мой список» отключает автоподбор совсем.
  const manual = watchSymbols();
  const onlyList = num("only_list") === 1;
  const auto = onlyList ? [] : await topPairs();
  const seen = new Set(auto.map(p => p.symbol));
  const pairs = [...auto, ...manual.filter(s => !seen.has(s)).map(s => ({ symbol: s }))];
  if (!pairs.length) { log("сканировать нечего: список пуст и автоподбор выключен"); return { pairs: 0, signals: 0 }; }
  const tfs = [...new Set(strategies.map(s => s.timeframe))];
  const found = [];

  await mapLimit(pairs, 6, async (p) => {
    const fired = [];       // сработавшие стратегии по этой паре
    const cond = [];        // условия всех стратегий, для показа близости

    // Если под монету подобраны свои параметры — работаем ими.
    const tuned = paramsFor(p.symbol);

    for (const tf of tfs) {
      // Через кеш: первый обход тянет по 300 свечей, дальше только хвост.
      const c = await candles(p.symbol, tf, 300);
      if (c.length < 160) return;
      const i = c.length - 2;                       // последний закрытый бар
      for (const base of strategies) {
        if (base.timeframe !== tf) continue;
        const own = tuned?.[base.id];
        const s = own && base.make ? base.make(own) : base;
        const x = s.prepare(c);
        const cc = s.conditions ? s.conditions(c, x, i) : null;
        if (cc) cond.push({ id: s.id, cc });
        const sig = s.evaluate(c, x, i);
        if (sig) fired.push({ ...sig, strategy: s.id, tf, barTime: c[i].t, tuned: Boolean(own) });
      }
    }
    if (!fired.length) return;

    // Одна пара — один сигнал на сторону. Стратегии, сошедшиеся на входе,
    // сливаются: берём НАИБОЛЬШЕЕ расстояние до стопа, значит и самые
    // дальние цели. Позиция при этом меньше — риск на сделку тот же.
    for (const side of ["long", "short"]) {
      const same = fired.filter(f => f.side === side);
      if (!same.length) continue;

      const best = same.reduce((a, b) =>
        Math.abs(b.sl - b.entry) > Math.abs(a.sl - a.entry) ? b : a);

      const agree = cond.map(({ id, cc }) => {
        const list = cc[side] ?? [];
        return {
          id,
          hit: list.filter(z => z.ok).length,
          all: list.length,
          miss: list.filter(z => !z.ok).map(z => z.n),
        };
      }).sort((a, b) => (b.hit / b.all) - (a.hit / a.all));

      found.push({
        ...best,
        symbol: p.symbol,
        strategy: same.map(f => f.strategy).sort().join(" + "),
        parts: same.map(f => f.strategy),
        reason: same.map(f => f.reason).join("\n"),
        agree,
      });
    }
  });

  // Свежие — вперёд; при потоке сигналов важнее те, где стоп ближе.
  found.sort((a, b) => Math.abs(a.sl - a.entry) / a.entry - Math.abs(b.sl - b.entry) / b.entry);

  // Монета, уже взятая в работу, не должна звать зайти второй раз.
  // Повторный сигнал по ней — это уточнение к открытой сделке, а не
  // приглашение перезайти, и уходит он другой дорогой.
  const open = new Map(openPositions().map(p => [p.symbol, p]));

  let sent = 0, updated = 0;
  for (const f of found) {
    const held = open.get(f.symbol);
    if (held) {
      if (onUpdate && await onUpdate(f, held)) updated++;
      continue;
    }
    if (cfg.maxSignalsPerScan && sent >= cfg.maxSignalsPerScan) break;
    const vol = await volatility(f.symbol);
    const r = insertSignal.run(f.strategy, f.symbol, f.side, f.tf, f.entry, f.sl,
      JSON.stringify(f.targets), f.reason, now(), f.barTime,
      vol ? JSON.stringify(vol) : null,
      f.agree ? JSON.stringify(f.agree) : null);
    if (!r.changes) continue;                       // уже был такой — не дублируем
    const id = Number(r.lastInsertRowid);
    f.vol = vol;
    logEvent({ kind: "signal", strategy: f.strategy, symbol: f.symbol,
               side: f.side, price: f.entry, text: f.reason });
    await onSignal({ id, ...f });
    sent++;
  }

  return { pairs: pairs.length, candidates: found.length, signals: sent, updates: updated };
}

/** Индикаторы по одной паре — для монитора позиций. */
export async function contextFor(strategy, symbol) {
  const c = await fetchKlines(symbol, strategy.timeframe, 300);
  if (c.length < 160) return null;
  return { c, x: strategy.prepare(c), i: c.length - 2 };
}

export { TF_SEC };
