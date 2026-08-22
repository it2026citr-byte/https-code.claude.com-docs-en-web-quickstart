import { db, now } from "./db.js";
import { cfg, log } from "./config.js";
import { topPairs } from "./data/tradingview.js";
import { fetchKlines, TF_SEC } from "./data/mexc.js";
import { dailyVolatility } from "./indicators.js";
import { logEvent } from "./journal.js";

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
  "(strategy,symbol,side,tf,entry,sl,targets,reason,created_at,bar_time,status,vol) " +
  "VALUES(?,?,?,?,?,?,?,?,?,?,'new',?)"
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
export async function scanMarket(strategies, onSignal) {
  if (!strategies.length) return { pairs: 0, signals: 0 };
  const pairs = await topPairs();
  const tfs = [...new Set(strategies.map(s => s.timeframe))];
  const found = [];

  await mapLimit(pairs, 6, async (p) => {
    for (const tf of tfs) {
      const c = await fetchKlines(p.symbol, tf, 300);
      if (c.length < 160) return;
      const i = c.length - 2;                       // последний закрытый бар
      for (const s of strategies) {
        if (s.timeframe !== tf) continue;
        const x = s.prepare(c);
        const sig = s.evaluate(c, x, i);
        if (sig) found.push({ ...sig, strategy: s.id, symbol: p.symbol, tf, barTime: c[i].t });
      }
    }
  });

  // Свежие — вперёд; при потоке сигналов важнее те, где стоп ближе.
  found.sort((a, b) => Math.abs(a.sl - a.entry) / a.entry - Math.abs(b.sl - b.entry) / b.entry);

  let sent = 0;
  for (const f of found) {
    if (cfg.maxSignalsPerScan && sent >= cfg.maxSignalsPerScan) break;
    const vol = await volatility(f.symbol);
    const r = insertSignal.run(f.strategy, f.symbol, f.side, f.tf, f.entry, f.sl,
      JSON.stringify(f.targets), f.reason, now(), f.barTime,
      vol ? JSON.stringify(vol) : null);
    if (!r.changes) continue;                       // уже был такой — не дублируем
    const id = Number(r.lastInsertRowid);
    f.vol = vol;
    logEvent({ kind: "signal", strategy: f.strategy, symbol: f.symbol,
               side: f.side, price: f.entry, text: f.reason });
    await onSignal({ id, ...f });
    sent++;
  }

  return { pairs: pairs.length, candidates: found.length, signals: sent };
}

/** Индикаторы по одной паре — для монитора позиций. */
export async function contextFor(strategy, symbol) {
  const c = await fetchKlines(symbol, strategy.timeframe, 300);
  if (c.length < 160) return null;
  return { c, x: strategy.prepare(c), i: c.length - 2 };
}

export { TF_SEC };
