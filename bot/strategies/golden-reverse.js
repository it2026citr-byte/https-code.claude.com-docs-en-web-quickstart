import { atr, cci, squeeze, utBot, structure, ema } from "../indicators.js";

/**
 * Golden-Reverse.
 *
 * Геометрия выходов восстановлена из базы приложения Crypto Signals Golden:
 * 415 сигналов, отношение «до T1» / «до стопа» = ровно 0,500 в 23 случаях
 * из 23. Их стоп ≈ 1,5 × ATR(1ч); правило входа разгадать не удалось,
 * поэтому вход наш — флип UT Bot с подтверждением CCI и моментума.
 *
 * Ключевое отличие от оригинала: у них риск 30% депозита на сделку,
 * что при 27% стопов уносит счёт четырьмя неудачами подряд. У нас 1%.
 */

// Пороги подобраны прогоном по истории: 60 пар, ~500 часов, удержание 96 ч.
// Смягчение любого из них роняет матожидание вдвое и больше — проверено.
const P = {
  atrLen: 14,
  swingLen: 10,
  swingPad: 0.25,      // отступ за экстремум, в ATR
  utKey: 1,
  utAtr: 10,
  trendLen: 200,       // фильтр направления
  cciMin: 100,         // убеждённость: слабые флипы отсеиваются
  sqzWindow: 6,        // сжатие должно было быть в последние 6 баров
  // Стоп зажат в диапазон, наблюдавшийся у Golden: k = SL/ATR(1ч) = 0,81…2,68.
  minStopAtr: 1.0,
  maxStopAtr: 2.5,
  minStopPct: 0.15,    // уже — шум, комиссия съест
};

export default {
  id: "Golden-Reverse",
  title: "Golden-Reverse",
  timeframe: "1h",
  warmup: 120,

  /** Состояние индикаторов на закрытом баре i. Считается один раз на пару. */
  prepare(c) {
    return {
      atr: atr(c, P.atrLen),
      cci: cci(c, 20),
      sqz: squeeze(c),
      ut: utBot(c, { keyValue: P.utKey, atrPeriod: P.utAtr }),
      str: structure(c, P.swingLen),
      ema: ema(c.map(y => y.c), P.trendLen),
    };
  },

  /** Разложенные условия — и для входа, и для показа близости. */
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
        { n: "флип UT Bot вверх", ok: x.ut.buy[i] === true },
        { n: `CCI > ${P.cciMin}`, ok: x.cci[i] > P.cciMin },
        { n: "моментум растёт",   ok: momUp && x.sqz.mom[i] > 0 },
        { n: "цена над EMA200",   ok: trendUp },
        { n: "недавнее сжатие",   ok: sqzRecent },
      ],
      short: [
        { n: "флип UT Bot вниз",  ok: x.ut.sell[i] === true },
        { n: `CCI < −${P.cciMin}`, ok: x.cci[i] < -P.cciMin },
        { n: "моментум падает",   ok: !momUp && x.sqz.mom[i] < 0 },
        { n: "цена под EMA200",   ok: !trendUp },
        { n: "недавнее сжатие",   ok: sqzRecent },
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
    const entryPx = c[i].c;
    const momUp = x.sqz.mom[i] > x.sqz.mom[i - 1];
    const trendUp = entryPx > x.ema[i];
    const side = long ? "long" : "short";
    const entry = entryPx;

    // Стоп: за структурным экстремумом, но зажатый в диапазон Golden.
    // Чистый ATR их стопы не объяснял, чистая структура — тоже;
    // зажатая структура воспроизводит наблюдавшийся разброс k.
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

    return {
      side, entry, sl, targets,
      reason: `UT Bot флип ${long ? "вверх" : "вниз"} · CCI ${x.cci[i].toFixed(0)} · ` +
              `моментум ${momUp ? "растёт" : "падает"} · ` +
              `тренд ${trendUp ? "вверх" : "вниз"} · после сжатия`,
      detail: { atr: a, stopAtr: +(dist / a).toFixed(2),
                byStructure: dStr != null && dStr > P.minStopAtr * a },
    };
  },

  /**
   * Три проверки, выбранные пользователем. Таймаута сознательно нет:
   * позиция висит, пока жива посылка.
   */
  invalidated(c, x, i, pos) {
    const long = pos.side === "long";

    // Причина возвращается разобранной: заголовок отдельно, подробность
    // отдельно, уровень числом. Оформлением занимается тот, кто выводит.
    if (long ? x.ut.sell[i] : x.ut.buy[i])
      return { reason: "opposite", label: "Встречный сигнал стратегии",
               detail: `UT Bot развернулся ${long ? "вниз" : "вверх"}` };

    const lvl = long ? x.str.lastLow[i] : x.str.lastHigh[i];
    if (lvl != null && (long ? c[i].c < lvl : c[i].c > lvl))
      return { reason: "choch", label: "Слом структуры",
               detail: `цена ушла ${long ? "ниже" : "выше"} свингового уровня`,
               level: lvl };

    const m = x.sqz.mom, prev = m[i - 1];
    if (m[i] != null && prev != null &&
        (long ? m[i] < 0 && prev < 0 : m[i] > 0 && prev > 0))
      return { reason: "momentum", label: "Разворот моментума",
               detail: "два бара подряд против позиции" };

    return null;
  },
};
