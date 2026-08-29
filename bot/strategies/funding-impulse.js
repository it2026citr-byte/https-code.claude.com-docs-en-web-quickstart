import { atr, ema } from "../indicators.js";
import { rateOf } from "../data/funding.js";

/**
 * Funding-Impulse — единственная стратегия, которая смотрит не на цену.
 *
 * Ставка финансирования говорит, за какую сторону рынок готов доплачивать.
 * Расхожее мнение — что высокая ставка означает перекос и скорый разворот.
 * Проверка это не подтвердила: на 59 ликвидных парах MEXC за семь месяцев
 * после ставки выше 0,03% средний ход за двое суток оказался ВЫШЕ, а не
 * ниже случайного. То есть ставка здесь — признак живого импульса, а не
 * толпы, которую сейчас вынесут.
 *
 * Замер (128 сигналов, предел жизни 48 ч, лесенка с безубытком):
 *
 *   стратегия          +0,197R на сделку, в плюс 63%
 *   случайный вход     −0,039R
 *   превосходство      +0,236R, и оно держится на всех третях периода
 *                      (+0,04 · +0,01 · +0,51)
 *
 * Отбор устроен в два этапа, потому что ставка пересчитывается раз в
 * восемь часов и спусковым крючком быть не может:
 *
 *   1. наблюдение — ставка ушла выше порога, монета взята на прицел;
 *   2. вход — цена подтвердила: держится выше EMA50 и обновила
 *      двенадцатичасовой максимум.
 *
 * Без второго этапа превосходство падает с +0,236 до +0,058: сама по
 * себе ставка направление даёт, а момент входа — нет.
 *
 * Цели считаются от среднедневного хода монеты, а не от стопа. Так они
 * укладываются в двое суток по построению: у монеты с ходом 5% в день
 * пятая цель — один дневной ход, а не абстрактные 2,5R, до которых
 * половина монет доползает неделю.
 *
 * Чего эта стратегия не умеет: работать в шорт (проверялся только лонг),
 * работать без фьючерса на паре и работать в спокойные месяцы — разброс
 * по месяцам от −0,29R до +0,48R, и это её природа, а не изъян.
 */

const DEFAULTS = {
  fundMin: 0.03,      // порог ставки, %
  trendLen: 50,       // фильтр направления
  highBars: 12,       // окно максимума для подтверждения
  atrLen: 14,
  stopAtr: 1.5,       // стоп в ATR
  tgtDay: 0.2,        // шаг цели в долях среднедневного хода
  dayWin: 30,         // сколько дней усредняем ход
  minStopPct: 0.15,
};

/** Что перебирать при подгонке под монету. */
export const TUNABLE = {
  fundMin:  [0.02, 0.03, 0.05],
  highBars: [8, 12, 24],
  tgtDay:   [0.15, 0.2, 0.35],
};

/** Среднедневной ход: размах суточного окна, усреднённый по dayWin дням. */
function dailyRange(c, days) {
  const out = new Array(c.length).fill(null);
  const win = [], cap = days * 24;
  for (let i = 0; i < c.length; i++) {
    if (i < 24) continue;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - 23; k <= i; k++) {
      if (c[k].h > hi) hi = c[k].h;
      if (c[k].l < lo) lo = c[k].l;
    }
    win.push((hi - lo) / c[i].c * 100);
    if (win.length > cap) win.shift();
    if (win.length >= cap / 3) out[i] = win.reduce((a, b) => a + b, 0) / win.length;
  }
  return out;
}

export function make(over = {}) {
  const P = { ...DEFAULTS, ...over };
  return {
  id: "Funding-Impulse",
  title: "Funding-Impulse",
  timeframe: "1h",
  warmup: 260,
  needsFutures: true,          // без бессрочного контракта ставки нет

  prepare(c, symbol) {
    return {
      atr: atr(c, P.atrLen),
      ema: ema(c.map(y => y.c), P.trendLen),
      day: dailyRange(c, P.dayWin),
      rate: symbol ? rateOf(symbol) : null,
      symbol,
    };
  },

  /** Условия входа — они же показываются в «согласии стратегий». */
  conditions(c, x, i) {
    const rate = x.rate;
    const e = x.ema[i];
    if (e == null || x.day[i] == null) return null;
    let hi = -Infinity;
    for (let k = Math.max(0, i - P.highBars); k < i; k++) if (c[k].h > hi) hi = c[k].h;
    return {
      long: [
        { n: `ставка > ${P.fundMin}%`, ok: rate != null && rate > P.fundMin },
        { n: "цена над EMA50",         ok: c[i].c > e },
        { n: `максимум за ${P.highBars} ч`, ok: c[i].c > hi },
      ],
      // Шорт не проверялся, поэтому честно показываем, что его нет.
      short: [{ n: "шорт не поддержан", ok: false }],
    };
  },

  /**
   * Первый этап: ставка ушла выше порога и направление не против нас.
   * Это ещё не вход — только повод взять монету на прицел.
   */
  watching(c, x, i) {
    if (x.rate == null || x.rate <= P.fundMin) return null;
    const e = x.ema[i];
    if (e == null || c[i].c < e) return null;
    let hi = -Infinity;
    for (let k = Math.max(0, i - P.highBars); k < i; k++) if (c[k].h > hi) hi = c[k].h;
    const away = (hi - c[i].c) / c[i].c * 100;
    return { rate: x.rate, need: hi, awayPct: away, dayPct: x.day[i] };
  },

  evaluate(c, x, i) {
    const cond = this.conditions(c, x, i);
    if (!cond || !cond.long.every(z => z.ok)) return null;

    const a = x.atr[i], d = x.day[i], entry = c[i].c;
    if (a == null || !(d > 0)) return null;
    const dist = P.stopAtr * a;
    if (dist / entry * 100 < P.minStopPct) return null;

    const unit = entry * d / 100 * P.tgtDay;
    if (!(unit > 0)) return null;

    return {
      side: "long",
      entry,
      sl: entry - dist,
      targets: [1, 2, 3, 4, 5].map(n => entry + unit * n),
      reason: `ставка финансирования ${x.rate.toFixed(3)}% · цена над EMA50 · ` +
              `максимум за ${P.highBars} ч · дневной ход ${d.toFixed(1)}%`,
      detail: { rate: x.rate, dayPct: +d.toFixed(2), stopAtr: P.stopAtr },
    };
  },

  /**
   * Сигнал живёт двое суток: замер делался именно на этом пределе, а
   * импульс, не отработавший за это время, обычно уже угас.
   */
  invalidated(c, x, i, pos) {
    // Срок жизни теперь общий для всех стратегий и проверяется в monitor.js.
    // Своя проверка здесь давала бы второе сообщение о том же.
    // Форма ответа — как у всех: { reason, label, detail }. Монитор
    // печатает label и detail; поле text он не знает, и с ним тревога
    // приходила пользователю как «undefined» — поймано аудитом 30.08.
    const e = x.ema[i];
    if (e != null && c[i].c < e)
      return { reason: "тренд", label: "Импульс угас",
               detail: "цена ушла под EMA50" };
    if (x.rate != null && x.rate < 0)
      return { reason: "ставка", label: "Ставка развернулась",
               detail: `ставка финансирования ушла в минус (${x.rate.toFixed(3)}%)` };
    return null;
  },
};
}

export default make();
