import { atr, cci } from "../indicators.js";
import { structureBias, BULL, BEAR } from "../smc.js";

/**
 * Zone-Retest — возврат к пробитому уровню.
 *
 * Метод, по которому работают разборы из телеграм-каналов: дождаться
 * закрепления выше структуры, отметить пробитый уровень как новую
 * поддержку и войти НЕ вдогонку, а лимиткой при возврате цены в эту зону.
 *
 * Отличие от остальных наших стратегий принципиальное. Те смотрят
 * текущий бар: сигнал есть или нет. Эта помнит уровень, пробитый
 * неделю назад, и ждёт, когда цена к нему вернётся. Состояние при этом
 * не хранится — зона каждый раз восстанавливается из истории, поэтому
 * стратегия остаётся проверяемой на бэктесте.
 *
 * Смысл в стопе: вход у границы зоны позволяет ставить стоп сразу за
 * ней, а не в двух ATR. То же движение приносит больше R.
 */

const DEFAULTS = {
  legs: 50,            // длина ног для структуры старшего масштаба
  zonePad: 0.5,        // половина ширины зоны, в ATR
  maxWait: 200,        // сколько баров уровень считается живым
  minWait: 3,          // сразу после пробоя не входим — даём цене уйти
  minRun: 2.5,         // насколько цена должна уйти от уровня, в ATR,
                       // иначе это не возврат, а топтание на месте
  cciLen: 20,
  atrLen: 14,
  stopPad: 0.5,        // отступ стопа за границу зоны, в ATR
  minStopAtr: 1.5,   // узкий стоп у зоны съедается шумом — проверено
  maxStopAtr: 2.5,
  minStopPct: 0.15,
  needReaction: 1,     // 1 — требовать разворотную свечу, 0 — нет
};

export const TUNABLE = {
  zonePad: [0.2, 0.35, 0.5],
  minRun:  [1.0, 1.5, 2.5],
  maxWait: [100, 200, 400],
};

export function make(over = {}) {
  const P = { ...DEFAULTS, ...over };
  return {
  id: "Zone-Retest",
  // Выключена по итогам проверки: на 24 парах за 125 дней лучший вариант
  // дал +0,048R против +0,159 у Golden-Reverse и +0,286 у MA-Cross-CCI,
  // при пятнадцати сигналах в сутки. Включить — поменять на true.
  enabled: false,
  title: "Возврат к пробитому уровню",
  timeframe: "1h",
  warmup: 260,

  prepare(c) {
    return {
      atr: atr(c, P.atrLen),
      cci: cci(c, P.cciLen),
      str: structureBias(c, P.legs),
    };
  },

  /** Последний пробой структуры и зона, которую он оставил. */
  zoneAt(c, x, i) {
    for (let j = i - P.minWait; j > Math.max(0, i - P.maxWait); j--) {
      if (!x.str.event[j]) continue;
      const bull = x.str.bias[j] === BULL;
      // Пробитый уровень: экстремум, который цена прошла на баре j.
      const lvl = bull ? x.str.swingHigh[j - 1] : x.str.swingLow[j - 1];
      if (lvl == null) return null;
      const a = x.atr[j];
      if (a == null) return null;
      return { side: bull ? BULL : BEAR, lvl, pad: P.zonePad * a, bar: j };
    }
    return null;
  },

  /** Внутри зоны ли бар k. */
  touches(c, k, z) {
    const b = c[k];
    return z.side === BULL
      ? b.l <= z.lvl + z.pad && b.c >= z.lvl - z.pad
      : b.h >= z.lvl - z.pad && b.c <= z.lvl + z.pad;
  },

  conditions(c, x, i) {
    const a = x.atr[i];
    if (a == null || x.cci[i] == null || x.cci[i - 1] == null) return null;
    const z = this.zoneAt(c, x, i);
    const b = c[i];
    const cciUp = x.cci[i] > x.cci[i - 1];

    // Сигнал даётся в МОМЕНТ входа в зону, а не всё время, пока цена
    // в ней стоит. Иначе одна зона выдаёт десятки сигналов подряд.
    const first = z != null && this.touches(c, i, z) && !this.touches(c, i - 1, z);

    // И это должен быть именно возврат: между пробоем и сейчас цена
    // обязана была уйти от уровня хотя бы на minRun ATR.
    let ran = false;
    if (z != null) {
      let far = 0;
      for (let j = z.bar; j < i; j++) {
        const d = z.side === BULL ? c[j].h - z.lvl : z.lvl - c[j].l;
        if (d > far) far = d;
      }
      ran = far >= P.minRun * a;
    }

    return {
      long: [
        { n: "был пробой вверх", ok: z != null && z.side === BULL },
        { n: `цена ушла на ${P.minRun} ATR`, ok: ran },
        { n: "вернулась в зону сейчас", ok: first },
        { n: "смещение всё ещё вверх", ok: x.str.bias[i] === BULL },
        { n: "разворотная свеча", ok: !P.needReaction || (b.c > b.o && cciUp) },
      ],
      short: [
        { n: "был пробой вниз", ok: z != null && z.side === BEAR },
        { n: `цена ушла на ${P.minRun} ATR`, ok: ran },
        { n: "вернулась в зону сейчас", ok: first },
        { n: "смещение всё ещё вниз", ok: x.str.bias[i] === BEAR },
        { n: "разворотная свеча", ok: !P.needReaction || (b.c < b.o && !cciUp) },
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
    const z = this.zoneAt(c, x, i);
    if (!z) return null;

    // Стоп за дальней границей зоны — в этом весь смысл входа от уровня.
    const edge = long ? z.lvl - z.pad - P.stopPad * a
                      : z.lvl + z.pad + P.stopPad * a;
    let dist = Math.abs(entry - edge);
    dist = Math.min(Math.max(dist, P.minStopAtr * a), P.maxStopAtr * a);
    if (dist / entry * 100 < P.minStopPct) return null;

    const sl = long ? entry - dist : entry + dist;
    const targets = [1, 2, 3, 4, 5].map(n =>
      long ? entry + 0.5 * n * dist : entry - 0.5 * n * dist);
    const waited = i - z.bar;

    return {
      side: long ? "long" : "short",
      entry, sl, targets,
      reason: `Возврат к уровню ${z.lvl.toPrecision(6)}, пробитому ${waited} ч назад · ` +
              `зона ±${(z.pad / a).toFixed(1)} ATR · стоп ${(dist / a).toFixed(2)} ATR`,
      detail: { atr: a, stopAtr: +(dist / a).toFixed(2), level: z.lvl, waited },
    };
  },

  invalidated(c, x, i, pos) {
    const long = pos.side === "long";

    if (long ? x.str.bias[i] === BEAR : x.str.bias[i] === BULL)
      return { reason: "opposite", label: "Встречный сигнал стратегии",
               detail: "смещение структуры развернулось" };

    const lvl = long ? x.str.swingLow[i] : x.str.swingHigh[i];
    if (lvl != null && (long ? c[i].c < lvl : c[i].c > lvl))
      return { reason: "choch", label: "Слом структуры",
               detail: `цена ушла ${long ? "ниже" : "выше"} свингового уровня`,
               level: lvl };

    const m = x.cci, prev = m[i - 1];
    if (m[i] != null && prev != null &&
        (long ? m[i] < -100 && prev < -100 : m[i] > 100 && prev > 100))
      return { reason: "momentum", label: "Разворот моментума",
               detail: "CCI два бара против позиции" };

    return null;
  },
};
}

export default make();
