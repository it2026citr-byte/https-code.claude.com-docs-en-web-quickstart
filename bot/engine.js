import { db, now, openPositions } from "./db.js";
import { cfg, log } from "./config.js";
import { topPairs } from "./data/tradingview.js";
import { fetchKlines, TF_SEC } from "./data/mexc.js";
import { candles, mapLimit } from "./candles.js";
import { dailyVolatility } from "./indicators.js";
import { logEvent } from "./journal.js";
import { num } from "./runtime.js";
import { symbols as watchSymbols, paramsFor } from "./watchlist.js";
import { refresh as refreshFunding } from "./data/funding.js";
import { rejectReason, ready as tradableReady } from "./data/tradable.js";
import { refreshMarket, rejectSignal } from "./gate.js";
import { detect as detectFigures, figuresLine, strongFor } from "./patterns.js";

/** Ограничитель параллельности — чтобы не долбить биржу и не греть телефон. */
const insertSignal = db.prepare(
  "INSERT OR IGNORE INTO signals" +
  "(strategy,symbol,side,tf,entry,sl,targets,reason,created_at,bar_time,status,vol,agree,shares) " +
  "VALUES(?,?,?,?,?,?,?,?,?,?,'new',?,?,?)"
);

/**
 * Защитная лесенка. Стратегии рисуют классическую геометрию — стоп по
 * своей логике и пять целей с шагом 0,5R. Здесь она перестраивается:
 * стоп в полтора раза дальше, первая цель на 0,15R с фиксацией половины
 * позиции, дальние цели шире.
 *
 * Смысл: минус случается, когда цена не дошла до первой цели. Близкий
 * якорь переводит сделку в безубыток почти сразу, а дальние цели
 * сохраняют хвост прибыли. Замер на 765 сигналах с отбором: минусов 11%
 * вместо 30%, средний R +0,066 против +0,127 — реже, но мельче; выбор
 * за настройкой. Агрессивный якорь 0,10R давал 7%, но при плохом
 * исполнении (комиссия 0,05% + проскальзывание 0,05%) разваливался до
 * 19%, тогда как 0,15R деградирует до 14% — поэтому 0,15R.
 */
const ANCHOR_T = [0.15, 0.5, 1.0, 1.8, 2.8];
const ANCHOR_SHARE = [0.5, 0.15, 0.15, 0.1, 0.1];
function anchorGeometry(f) {
  const long = f.side === "long";
  const dist = Math.abs(f.entry - f.sl) * 1.5;
  return {
    ...f,
    sl: long ? f.entry - dist : f.entry + dist,
    targets: ANCHOR_T.map(x => long ? f.entry + x * dist : f.entry - x * dist),
    shares: ANCHOR_SHARE,
  };
}

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
  const raw = [...auto, ...manual.filter(s => !seen.has(s)).map(s => ({ symbol: s }))];
  if (!raw.length) { log("сканировать нечего: список пуст и автоподбор выключен"); return { pairs: 0, signals: 0 }; }
  const tfs = [...new Set(strategies.map(s => s.timeframe))];
  const found = [];
  const watching = [];

  // Список контрактов нужен и стратегии на ставке, и отсеву пар:
  // торгуем только бессрочные фьючерсы криптовалют.
  await refreshFunding();
  // Списки для отсева пар. Пока их нет, rejectReason отказывает всем,
  // поэтому тянуть их надо до отсева, а не после.
  await tradableReady();
  // Погода по биткоину нужна отбору ниже: одно обращение на такт.
  await refreshMarket();

  // Автоподбор фьючерсы уже отфильтровал, а монеты из моего списка —
  // нет: пару могли добавить давно или снять с фьючерсов после.
  const dropped = [];
  const pairs = raw.filter(p => {
    const why = rejectReason(p.symbol);
    if (why) { dropped.push(`${p.symbol} — ${why}`); return false; }
    return true;
  });
  if (dropped.length)
    log(`не по фьючерсам, пропускаю ${dropped.length}: ${dropped.slice(0, 3).join("; ")}` +
        (dropped.length > 3 ? " и др." : ""));
  if (!pairs.length) { log("после отсева не осталось пар"); return { pairs: 0, signals: 0 }; }

  await mapLimit(pairs, 6, async (p) => {
    const fired = [];       // сработавшие стратегии по этой паре
    const cond = [];        // условия всех стратегий, для показа близости
    let lastCandles = null, lastIndex = 0;

    // Если под монету подобраны свои параметры — работаем ими.
    const tuned = paramsFor(p.symbol);

    for (const tf of tfs) {
      // Через кеш: первый обход тянет по 300 свечей, дальше только хвост.
      const c = await candles(p.symbol, tf, 300);
      if (c.length < 160) return;
      const i = c.length - 2;                       // последний закрытый бар
      lastCandles = c; lastIndex = i;               // отбору нужен тот же ряд
      for (const base of strategies) {
        if (base.timeframe !== tf) continue;
        const own = tuned?.[base.id];
        const s = own && base.make ? base.make(own) : base;
        const x = s.prepare(c, p.symbol);
        const cc = s.conditions ? s.conditions(c, x, i) : null;
        if (cc) cond.push({ id: s.id, cc });
        const sig = s.evaluate(c, x, i);
        if (sig) fired.push({ ...sig, strategy: s.id, tf, barTime: c[i].t,
                              tuned: Boolean(own), gateExempt: Boolean(s.gateExempt) });
        // Первый этап без второго — монета на прицеле, но входа ещё нет.
        else if (s.watching) {
          const w = s.watching(c, x, i);
          if (w) watching.push({ symbol: p.symbol, strategy: s.id, price: c[i].c,
                                 barTime: c[i].t, ...w });
        }
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

      // Фигура графика на тех же свечах, что видела стратегия.
      // Считается один раз на сигнал: детектор дешёвый, но не бесплатный.
      let figures = [];
      try { figures = detectFigures(lastCandles, lastIndex); } catch { /* без фигур */ }

      found.push({
        ...best,
        // Слитый сигнал минует гейт, только если ВСЕ сошедшиеся стратегии
        // от него освобождены: обычной строгости не убавляем.
        gateExempt: same.every(x => x.gateExempt),
        figures,
        gateCandles: lastCandles,
        gateIndex: lastIndex,
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

  // Отбор: стратегия сказала «вход есть», здесь решаем, показывать ли.
  // Отсев считается отдельно — молчание должно быть объяснимым.
  const anchor = num("anchor") === 1;
  const gateOut = [];
  const passed = found.filter(f => {
    const why = rejectSignal(f, f.gateCandles, f.gateIndex);
    if (why) { gateOut.push(`${f.symbol} ${f.side}: ${why}`); return false; }
    return true;
  });
  if (gateOut.length)
    log(`отбор отклонил ${gateOut.length}: ${gateOut.slice(0, 2).join("; ")}` +
        (gateOut.length > 2 ? " и др." : ""));

  let sent = 0, updated = 0;
  for (let f of passed) {
    if (anchor) f = anchorGeometry(f);
    f.figuresText = figuresLine(f.figures, f.side);
    // Снайперская пометка живёт на сигнале, а не в отборе: в положении
    // «вместе с основными» ничего не режется, но жирный сигнал видно.
    f.sniper = num("f_sniper") >= 1 && strongFor(f.figures, f.side);
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
      f.agree ? JSON.stringify(f.agree) : null,
      f.shares ? JSON.stringify(f.shares) : null);
    if (!r.changes) continue;                       // уже был такой — не дублируем
    const id = Number(r.lastInsertRowid);
    f.vol = vol;
    logEvent({ kind: "signal", strategy: f.strategy, symbol: f.symbol,
               side: f.side, price: f.entry, text: f.reason });
    await onSignal({ id, ...f });
    sent++;
  }

  return { pairs: pairs.length, candidates: found.length, signals: sent,
           updates: updated, watching, gated: gateOut.length,
           symbols: pairs.map(p => p.symbol) };
}

export { TF_SEC };
