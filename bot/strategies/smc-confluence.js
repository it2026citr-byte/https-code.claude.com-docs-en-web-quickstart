import { atr, cci, squeeze, utBot, ema } from "../indicators.js";
import { structureBias, zonePos, BULL, BEAR } from "../smc.js";

/**
 * SMC-Confluence: UT Bot + Squeeze Momentum + Smart Money Concepts.
 *
 * Тот же спусковой крючок, что у Golden-Reverse, но добавлено согласие
 * структуры по LuxAlgo: смещение должно совпадать и на внутренних ногах
 * (5 баров), и на свинговых (50). То есть покупаем только когда и мелкая,
 * и крупная структура смотрят вверх.
 *
 * Замер по 25 парам и 125 дням часовой истории:
 *
 *   без структуры (это Golden-Reverse)  414 сделок, 71%, +0,191R
 *   + внутренняя структура              343 сделки, 73%, +0,240R
 *   + свинговая структура               284 сделки, 73%, +0,227R
 *   + обе                               239 сделок, 74%, +0,248R  ← здесь
 *
 * Фильтр отсекает 42% входов и поднимает матожидание на треть.
 * Стратегия оставлена отдельной, а не влита в первую, чтобы /stats
 * сравнил их на живых сделках, а не только на истории.
 *
 * Что из SMC проверено и НЕ вошло:
 *   зона дискаунт/премиум — 88 сделок и +0,282R, но выборка втрое меньше;
 *   касание ордер-блока   — всего 4 сделки за 125 дней, ловить нечего.
 */

const P = {
  atrLen: 14, utKey: 1, utAtr: 10, trendLen: 200,
  cciMin: 100, sqzWindow: 6,
  legsInternal: 5, legsSwing: 50,
  minStopAtr: 1.0, maxStopAtr: 2.5, swingPad: 0.25, minStopPct: 0.15,
};

export default {
  id: "SMC-Confluence",
  title: "UT Bot + Squeeze + структура SMC",
  timeframe: "1h",
  warmup: 260,

  prepare(c) {
    return {
      atr: atr(c, P.atrLen),
      cci: cci(c, 20),
      sqz: squeeze(c),
      ut: utBot(c, { keyValue: P.utKey, atrPeriod: P.utAtr }),
      ema: ema(c.map(y => y.c), P.trendLen),
      si: structureBias(c, P.legsInternal),
      ss: structureBias(c, P.legsSwing),
    };
  },

  /** Разложенные условия — нужны и для входа, и для показа близости. */
  conditions(c, x, i) {
    const a = x.atr[i];
    if (a == null || x.cci[i] == null || x.sqz.mom[i] == null || x.ema[i] == null)
      return null;
    const px = c[i].c;
    const momUp = x.sqz.mom[i] > x.sqz.mom[i - 1];
    const trendUp = px > x.ema[i];
    const sqzRecent = x.sqz.on.slice(Math.max(0, i - P.sqzWindow), i + 1).some(Boolean);

    return {
      long: [
        { n: "флип UT Bot вверх",     ok: x.ut.buy[i] === true },
        { n: `CCI > ${P.cciMin}`,     ok: x.cci[i] > P.cciMin },
        { n: "моментум растёт",       ok: momUp && x.sqz.mom[i] > 0 },
        { n: "цена над EMA200",       ok: trendUp },
        { n: "недавнее сжатие",       ok: sqzRecent },
        { n: "внутр. структура вверх", ok: x.si.bias[i] === BULL },
        { n: "свинг-структура вверх",  ok: x.ss.bias[i] === BULL },
      ],
      short: [
        { n: "флип UT Bot вниз",      ok: x.ut.sell[i] === true },
        { n: `CCI < −${P.cciMin}`,    ok: x.cci[i] < -P.cciMin },
        { n: "моментум падает",       ok: !momUp && x.sqz.mom[i] < 0 },
        { n: "цена под EMA200",       ok: !trendUp },
        { n: "недавнее сжатие",       ok: sqzRecent },
        { n: "внутр. структура вниз", ok: x.si.bias[i] === BEAR },
        { n: "свинг-структура вниз",  ok: x.ss.bias[i] === BEAR },
      ],
    };
  },

  evaluate(c, x, i) {
    const cond = this.conditions(c, x, i);
    if (!cond) return null;
    const long = cond.long.every(z => z.ok);
    const short = cond.short.every(z => z.ok);
    if (!long && !short) return null;

    const a = x.atr[i], entry = c[i].c;
    const src = x.ss;
    const lvl = long ? src.swingLow[i] : src.swingHigh[i];
    const dStr = lvl == null ? null
      : (long ? entry - lvl : lvl - entry) + P.swingPad * a;
    const dist = dStr == null || dStr <= 0
      ? 1.5 * a
      : Math.min(Math.max(dStr, P.minStopAtr * a), P.maxStopAtr * a);
    if (dist / entry * 100 < P.minStopPct) return null;

    const sl = long ? entry - dist : entry + dist;
    const targets = [1, 2, 3, 4, 5].map(n =>
      long ? entry + 0.5 * n * dist : entry - 0.5 * n * dist);

    const z = zonePos(entry, x.ss.top[i], x.ss.bottom[i]);
    return {
      side: long ? "long" : "short",
      entry, sl, targets,
      reason: `Структура согласна на обоих масштабах · UT Bot ${long ? "вверх" : "вниз"} · ` +
              `CCI ${x.cci[i].toFixed(0)}` +
              (z == null ? "" : ` · цена на ${(z * 100).toFixed(0)}% диапазона`),
      detail: { atr: a, stopAtr: +(dist / a).toFixed(2), zone: z == null ? null : +z.toFixed(2) },
    };
  },

  invalidated(c, x, i, pos) {
    const long = pos.side === "long";

    if (long ? x.ut.sell[i] : x.ut.buy[i])
      return { reason: "opposite", label: "Встречный сигнал стратегии",
               detail: `UT Bot развернулся ${long ? "вниз" : "вверх"}` };

    // Для этой стратегии слом структуры — это смена смещения по LuxAlgo,
    // а не просто пробой уровня.
    if (long ? x.si.bias[i] === BEAR : x.si.bias[i] === BULL)
      return { reason: "choch", label: "Слом структуры",
               detail: `внутренняя структура развернулась ${long ? "вниз" : "вверх"}`,
               level: long ? x.ss.swingLow[i] : x.ss.swingHigh[i] };

    const m = x.sqz.mom, prev = m[i - 1];
    if (m[i] != null && prev != null &&
        (long ? m[i] < 0 && prev < 0 : m[i] > 0 && prev > 0))
      return { reason: "momentum", label: "Разворот моментума",
               detail: "два бара подряд против позиции" };

    return null;
  },
};
