// Smart Money Concepts: детектор ног, слом структуры, зоны и ордер-блоки.
// Перенос логики LuxAlgo (CC BY-NC-SA 4.0) с Pine на JS: ноги считаются
// тем же способом — бар, отстоящий на size, сравнивается с окном из
// последних size баров.

const rollHigh = (v, n) => {
  const out = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (v[j] > m) m = v[j];
    out[i] = m;
  }
  return out;
};
const rollLow = (v, n) => {
  const out = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    let m = Infinity;
    for (let j = i - n + 1; j <= i; j++) if (v[j] < m) m = v[j];
    out[i] = m;
  }
  return out;
};

export const BULL = 1, BEAR = -1;

/**
 * Ноги и подтверждённые свинги.
 *
 * Свинг подтверждается через size баров после своего появления — это цена
 * за отсутствие ложных экстремумов, ровно как в оригинале.
 */
export function legs(c, size) {
  const hs = c.map(x => x.h), ls = c.map(x => x.l);
  const rh = rollHigh(hs, size), rl = rollLow(ls, size);

  const leg = new Array(c.length).fill(0);
  const swingHigh = new Array(c.length).fill(null);  // уровень, известный на баре i
  const swingLow = new Array(c.length).fill(null);

  let curHigh = null, curLow = null;
  for (let i = 0; i < c.length; i++) {
    const src = i - size;
    if (src < 0 || rh[i] == null) { leg[i] = i ? leg[i - 1] : 0; }
    else {
      const newHigh = hs[src] > rh[i];
      const newLow = ls[src] < rl[i];
      leg[i] = newHigh ? 0 : newLow ? 1 : leg[i - 1];
      if (leg[i] === 0 && leg[i - 1] !== 0) curHigh = hs[src];   // начало медвежьей ноги
      if (leg[i] === 1 && leg[i - 1] !== 1) curLow = ls[src];    // начало бычьей ноги
    }
    swingHigh[i] = curHigh;
    swingLow[i] = curLow;
  }
  return { leg, swingHigh, swingLow };
}

/**
 * Слом структуры. Пробой последнего свинга даёт BOS, если он в сторону
 * прежнего смещения, и CHoCH, если против — то есть разворот.
 */
export function structureBias(c, size) {
  const { swingHigh, swingLow } = legs(c, size);
  const bias = new Array(c.length).fill(0);
  const event = new Array(c.length).fill(null);   // "BOS" | "CHoCH"
  const top = new Array(c.length).fill(null);
  const bottom = new Array(c.length).fill(null);

  let b = 0, hiCrossed = true, loCrossed = true;
  let lastHi = null, lastLo = null;
  // Скользящие экстремумы: диапазон для зон должен идти за ценой,
  // иначе на длинных ногах он остаётся в прошлом и премиум с дискаунтом
  // теряют смысл. В оригинале это trailingExtremes.
  let trailTop = c[0].h, trailBot = c[0].l;

  for (let i = 0; i < c.length; i++) {
    if (swingHigh[i] !== lastHi) { lastHi = swingHigh[i]; hiCrossed = false; }
    if (swingLow[i] !== lastLo) { lastLo = swingLow[i]; loCrossed = false; }

    trailTop = Math.max(trailTop, c[i].h);
    trailBot = Math.min(trailBot, c[i].l);

    if (lastHi != null && !hiCrossed && c[i].c > lastHi) {
      event[i] = b === BEAR ? "CHoCH" : "BOS";
      b = BULL; hiCrossed = true;
      trailBot = c[i].l;                       // низ диапазона переезжает вверх
    } else if (lastLo != null && !loCrossed && c[i].c < lastLo) {
      event[i] = b === BULL ? "CHoCH" : "BOS";
      b = BEAR; loCrossed = true;
      trailTop = c[i].h;                       // верх переезжает вниз
    }
    bias[i] = b;
    top[i] = trailTop;
    bottom[i] = trailBot;
  }
  return { bias, event, top, bottom, swingHigh, swingLow };
}

/**
 * Где цена внутри диапазона свингов: 0 — у нижней границы, 1 — у верхней.
 * Ниже 0,5 — дискаунт, выше — премиум. Покупать в премиуме и продавать
 * в дискаунте — ровно то, чего SMC велит не делать.
 */
export function zonePos(price, top, bottom) {
  if (top == null || bottom == null || top <= bottom) return null;
  return (price - bottom) / (top - bottom);
}

/**
 * Ордер-блок: последняя свеча против движения перед сломом структуры.
 * Ищем назад не дальше lookback баров.
 *
 * Ни одной стратегией пока не используется — это кирпич для своих,
 * описанный в СТРАТЕГИИ.md. Поэтому и живёт, хотя вызовов нет.
 */
export function orderBlocks(c, str, lookback = 30) {
  const ob = new Array(c.length).fill(null);   // { lo, hi, side } действующий на баре i
  let active = null;

  for (let i = 0; i < c.length; i++) {
    const ev = str.event[i];
    if (ev) {
      const bull = str.bias[i] === BULL;
      let found = null;
      for (let j = i; j > Math.max(0, i - lookback); j--) {
        const bear = c[j].c < c[j].o;
        if (bull ? bear : !bear) { found = c[j]; break; }
      }
      if (found) active = { lo: found.l, hi: found.h, side: bull ? BULL : BEAR, bar: i };
    }
    // Блок сгорает, если цена прошла его насквозь против замысла.
    if (active) {
      const dead = active.side === BULL ? c[i].c < active.lo : c[i].c > active.hi;
      if (dead) active = null;
    }
    ob[i] = active;
  }
  return ob;
}

/** Касается ли цена ордер-блока сейчас. */
export const inBlock = (px, b) => b != null && px >= b.lo && px <= b.hi;
