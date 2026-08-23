import { sma, cci, atr, structure } from "../indicators.js";

/**
 * MA-Cross-CCI. Синяя MA30, красная MA60, снизу CCI(14) — та связка,
 * что видна на графике MEXC. Таймфрейм — **час**.
 *
 * Главное отличие от очевидного прочтения: вход делается НЕ ПОСЛЕ
 * пересечения средних, а ДО него. Средние сходятся, скорость сближения
 * известна — значит момент встречи можно посчитать. Входим, когда до
 * него остаётся не больше двух баров.
 *
 * Так поймана большая часть движения: к моменту самого креста цена уже
 * ушла, и вход после него берёт хвост. Проверено — до последней цели
 * доходят 18% сделок против 10% при входе после креста.
 *
 *   ЛОНГ  — MA30 идёт на встречу с MA60 снизу вверх и встретится
 *           в ближайшие два часа · цена уже выше обеих средних ·
 *           CCI ниже нуля и разворачивается вверх.
 *
 *   ШОРТ  — зеркально.
 *
 * Условие на цену обязательно: без него матожидание падает вчетверо
 * (+0,049 против +0,202). Оно и отделяет подтверждённое движение
 * от простого схождения линий.
 */

const DEFAULTS = {
  fast: 30,
  slow: 60,
  cciLen: 14,
  // За сколько баров до встречи средних входим. Проверено по 29 парам
  // и 125 дням часовой истории: устойчивая полка от 1,5 до 4 баров,
  // всюду +0,17…+0,25R. Взята середина, а не лучшая точка.
  leadBars: 2,
  slopeBars: 3,        // на скольких барах меряем скорость сближения
  // Порог CCI. При входе ДО креста работает буквальное «за серединой»:
  // ноль даёт +0,202R, а ужесточение до ±20 и ±40 только режет выборку.
  cciEdge: 0,
  atrLen: 14,
  swingLen: 10,
  swingPad: 0.25,
  minStopAtr: 1.0,
  maxStopAtr: 2.5,
  minStopPct: 0.2,
};

/**
 * Средние ещё не пересеклись, но сходятся. Возвращает сторону будущего
 * креста, если до него не больше leadBars. Скорость берётся за три бара,
 * чтобы не ловить дрожь одного.
 */
function crossAhead(fast, slow, i, P) {
  if (fast[i] == null || slow[i] == null || fast[i - P.slopeBars] == null) return 0;
  const gapNow = fast[i] - slow[i];
  const gapWas = fast[i - P.slopeBars] - slow[i - P.slopeBars];
  if (gapNow === 0) return 0;
  const speed = (gapNow - gapWas) / P.slopeBars;
  if (speed === 0) return 0;
  const bars = -gapNow / speed;                 // через сколько встретятся
  if (bars <= 0 || bars > P.leadBars) return 0; // уже пересеклись или ещё далеко
  return gapNow < 0 ? 1 : -1;                   // снизу вверх / сверху вниз
}

export const TUNABLE = {
  leadBars: [1.5, 2, 3, 4],
  cciEdge:  [0, 20, 40],
};

export function make(over = {}) {
  const P = { ...DEFAULTS, ...over };
  return {
  id: "MA-Cross-CCI",
  title: "MA30/MA60 + CCI, вход до креста",
  timeframe: "1h",
  warmup: 220,

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

  /** Разложенные условия — и для входа, и для показа близости. */
  conditions(c, x, i) {
    const a = x.atr[i];
    if (a == null || x.cci[i] == null || x.cci[i - 1] == null) return null;
    const dir = crossAhead(x.fast, x.slow, i, P);
    const px = c[i].c;
    const cciUp = x.cci[i] > x.cci[i - 1];
    return {
      long: [
        { n: `крест снизу вверх ≤${P.leadBars} ч`, ok: dir === 1 },
        { n: "цена над обеими MA", ok: px > x.fast[i] && px > x.slow[i] },
        { n: "CCI ниже нуля",      ok: x.cci[i] < -P.cciEdge },
        { n: "CCI разворот вверх", ok: cciUp },
      ],
      short: [
        { n: `крест сверху вниз ≤${P.leadBars} ч`, ok: dir === -1 },
        { n: "цена под обеими MA", ok: px < x.fast[i] && px < x.slow[i] },
        { n: "CCI выше нуля",      ok: x.cci[i] > P.cciEdge },
        { n: "CCI заваливается",   ok: !cciUp },
      ],
    };
  },

  evaluate(c, x, i) {
    const cond = this.conditions(c, x, i);
    if (!cond) return null;
    const long = cond.long.every(z => z.ok);
    const short = cond.short.every(z => z.ok);
    if (!long && !short) return null;

    const a = x.atr[i];
    const px = c[i].c;
    const cciUp = x.cci[i] > x.cci[i - 1];
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

    const gap = Math.abs(x.fast[i] - x.slow[i]);
    return {
      side: long ? "long" : "short",
      entry, sl, targets,
      reason: `Средние сходятся: MA30 встретит MA60 ${long ? "снизу" : "сверху"} ` +
              `в ближайшие ${P.leadBars} ч · цена ${long ? "над" : "под"} обеими · ` +
              `CCI ${x.cci[i].toFixed(0)} ${cciUp ? "разворот вверх" : "заваливается"}`,
      detail: { atr: a, stopAtr: +(dist / a).toFixed(2), gapAtr: +(gap / a).toFixed(2) },
    };
  },

  invalidated(c, x, i, pos) {
    const long = pos.side === "long";
    const gap = (k) => (x.fast[k] == null || x.slow[k] == null)
      ? null : x.fast[k] - x.slow[k];

    // Сближение, ради которого входили, развернулось: линии снова расходятся.
    const g0 = gap(i), g1 = gap(i - 1), g2 = gap(i - 2);
    if (g0 != null && g1 != null && g2 != null &&
        (long ? g0 < g1 && g1 < g2 : g0 > g1 && g1 > g2))
      return { reason: "opposite", label: "Встречный сигнал стратегии",
               detail: "средние снова расходятся, схождение не состоялось" };

    const lvl = long ? x.str.lastLow[i] : x.str.lastHigh[i];
    if (lvl != null && (long ? c[i].c < lvl : c[i].c > lvl))
      return { reason: "choch", label: "Слом структуры",
               detail: `цена ушла ${long ? "ниже" : "выше"} свингового уровня`,
               level: lvl };

    const wrong = (k) => x.fast[k] != null && x.slow[k] != null &&
      (long ? c[k].c < x.fast[k] && c[k].c < x.slow[k]
            : c[k].c > x.fast[k] && c[k].c > x.slow[k]);
    if (wrong(i) && wrong(i - 1))
      return { reason: "momentum", label: "Цена потеряла средние",
               detail: `два бара ${long ? "под" : "над"} MA30 и MA60` };

    return null;
  },
};
}

export default make();
