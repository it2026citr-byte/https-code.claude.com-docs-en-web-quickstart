import { sma, cci, atr, structure } from "../indicators.js";

/**
 * MA-Cross + CCI. Стратегия с графика MEXC: синяя MA30, красная MA60,
 * снизу CCI(14). Таймфрейм 4 часа — тот, на котором она смотрелась.
 *
 * Замысел: пересечение средних задаёт сторону, CCI ловит момент входа
 * НЕ на самом разгоне, а на откате внутри уже подтверждённого движения.
 *
 *   ЛОНГ  — MA30 пересекла MA60 снизу вверх, пересечение оказалось
 *           ниже свечей (цена выше обеих средних), а CCI при этом
 *           ниже нуля и разворачивается вверх. То есть тренд подтверждён,
 *           но входим на провале, а не вдогонку.
 *
 *   ШОРТ  — зеркально: пересечение сверху вниз, оно выше свечей
 *           (цена ниже обеих средних), CCI выше нуля и заваливается.
 *
 * Про «пересекаются выше/ниже графика»: это условие на положение цены
 * относительно средних. Если крест случился ниже свечей — цена уже ведёт,
 * движение подтверждено. Если выше — цена под средними, и это давление вниз.
 */

const P = {
  fast: 30,
  slow: 60,
  cciLen: 14,
  // «CCI за серединой» — насколько именно за. Проверено по 60 парам,
  // 500 четырёхчасовых баров, удержание 4 суток:
  //     0  → 121 сигнал, винрейт 64%, +0,049R  (буквально «за нулём»)
  //    60  →  41 сигнал, винрейт 78%, +0,181R  ← стоит сейчас
  //   100  →  13 сигналов, винрейт 85%, +0,317R (выборка уже мала)
  // Ноль — это ровно то, что описано словами, но после комиссий он
  // в ноль и уходит. Шестьдесят — тот же замысел, только требование
  // к откату строже.
  cciEdge: 60,
  crossWindow: 8,      // сколько баров крест считается свежим
  atrLen: 14,
  swingLen: 10,
  swingPad: 0.25,
  minStopAtr: 1.0,
  maxStopAtr: 2.5,
  minStopPct: 0.3,     // на 4 часах шум крупнее, чем на часе
};

const crossUp = (a, b, i) =>
  a[i] != null && b[i] != null && a[i - 1] != null &&
  a[i] > b[i] && a[i - 1] <= b[i - 1];

/** Был ли крест в последние N баров и в какую сторону. */
function recentCross(fast, slow, i, win) {
  for (let j = i; j > Math.max(0, i - win); j--) {
    if (crossUp(fast, slow, j)) return { dir: 1, bar: j };
    if (crossUp(slow, fast, j)) return { dir: -1, bar: j };
  }
  return null;
}

export default {
  id: "MA-Cross-CCI",
  title: "MA30/MA60 + CCI",
  timeframe: "4h",
  warmup: 200,

  prepare(c) {
    const close = c.map(x => x.c);
    return {
      fast: sma(close, P.fast),
      slow: sma(close, P.slow),
      cci: cci(c, P.cciLen),
      atr: atr(c, P.atrLen),
      str: structure(c, P.swingLen),
    };
  },

  evaluate(c, x, i) {
    const a = x.atr[i];
    if (a == null || x.fast[i] == null || x.slow[i] == null ||
        x.cci[i] == null || x.cci[i - 1] == null) return null;

    const cross = recentCross(x.fast, x.slow, i, P.crossWindow);
    if (!cross) return null;

    const px = c[i].c;
    const above = px > x.fast[i] && px > x.slow[i];   // крест ниже свечей
    const below = px < x.fast[i] && px < x.slow[i];   // крест выше свечей
    const cciUp = x.cci[i] > x.cci[i - 1];

    const long  = cross.dir ===  1 && above && x.cci[i] < -P.cciEdge && cciUp;
    const short = cross.dir === -1 && below && x.cci[i] >  P.cciEdge && !cciUp;
    if (!long && !short) return null;

    const entry = px;
    const lvl = long ? x.str.lastLow[i] : x.str.lastHigh[i];
    const dStr = lvl == null ? null
      : (long ? entry - lvl : lvl - entry) + P.swingPad * a;
    const dist = dStr == null || dStr <= 0
      ? 1.5 * a
      : Math.min(Math.max(dStr, P.minStopAtr * a), P.maxStopAtr * a);

    if (dist / entry * 100 < P.minStopPct) return null;

    const sl = long ? entry - dist : entry + dist;
    const targets = [1, 2, 3, 4, 5].map(n =>
      long ? entry + 0.5 * n * dist : entry - 0.5 * n * dist);

    const ago = i - cross.bar;
    return {
      side: long ? "long" : "short",
      entry, sl, targets,
      reason: `MA30 ${long ? "выше" : "ниже"} MA60 (крест ${ago === 0 ? "на этом баре" : ago + " бара назад"}) · ` +
              `цена ${long ? "над" : "под"} обеими · CCI ${x.cci[i].toFixed(0)} ${cciUp ? "разворот вверх" : "заваливается"}`,
      detail: { atr: a, stopAtr: +(dist / a).toFixed(2), crossAgo: ago },
    };
  },

  invalidated(c, x, i, pos) {
    const long = pos.side === "long";

    // Средние разошлись обратно — замысел отменён.
    if (long ? crossUp(x.slow, x.fast, i) : crossUp(x.fast, x.slow, i))
      return { reason: "opposite", label: "Встречный сигнал стратегии",
               detail: `MA30 вернулась ${long ? "под" : "над"} MA60` };

    const lvl = long ? x.str.lastLow[i] : x.str.lastHigh[i];
    if (lvl != null && (long ? c[i].c < lvl : c[i].c > lvl))
      return { reason: "choch", label: "Слом структуры",
               detail: `цена ушла ${long ? "ниже" : "выше"} свингового уровня`,
               level: lvl };

    // Цена вернулась не на ту сторону средних два бара подряд.
    const wrong = (k) => x.fast[k] != null && x.slow[k] != null &&
      (long ? c[k].c < x.fast[k] && c[k].c < x.slow[k]
            : c[k].c > x.fast[k] && c[k].c > x.slow[k]);
    if (wrong(i) && wrong(i - 1))
      return { reason: "momentum", label: "Цена потеряла средние",
               detail: `два бара ${long ? "под" : "над"} MA30 и MA60` };

    return null;
  },
};
