// Индикаторы. Все функции возвращают массив длиной с входной,
// с null на прогреве — так индекс всегда совпадает с индексом свечи.

export function sma(v, n) {
  const out = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(v, n) {
  const out = new Array(v.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < v.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += v[j];
      prev = s / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = v[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function stdev(v, n) {
  const out = new Array(v.length).fill(null);
  const m = sma(v, n);
  for (let i = n - 1; i < v.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export const highest = (v, n, i) => {
  let m = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, v[j]);
  return m;
};
export const lowest = (v, n, i) => {
  let m = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, v[j]);
  return m;
};

/** True Range по свечам. */
export function trueRange(c) {
  return c.map((x, i) => i === 0 ? x.h - x.l
    : Math.max(x.h - x.l, Math.abs(x.h - c[i-1].c), Math.abs(x.l - c[i-1].c)));
}

/** ATR со сглаживанием Уайлдера — то же, что atr() в Pine. */
export function atr(c, n = 14) {
  const tr = trueRange(c);
  const out = new Array(c.length).fill(null);
  let prev = null;
  for (let i = 0; i < c.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += tr[j];
      prev = s / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = (prev * (n - 1) + tr[i]) / n;
      out[i] = prev;
    }
  }
  return out;
}

/** CCI(20) — индекс товарного канала. */
export function cci(c, n = 20) {
  const tp = c.map(x => (x.h + x.l + x.c) / 3);
  const m = sma(tp, n);
  const out = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    let dev = 0;
    for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
    dev /= n;
    out[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
  }
  return out;
}

/** Линейная регрессия, значение на последнем баре окна (Pine linreg(src,n,0)). */
export function linreg(v, n) {
  const out = new Array(v.length).fill(null);
  const sx = (n - 1) * n / 2;
  const sxx = (n - 1) * n * (2 * n - 1) / 6;
  const den = n * sxx - sx * sx;
  for (let i = n - 1; i < v.length; i++) {
    let sy = 0, sxy = 0;
    for (let k = 0; k < n; k++) { const y = v[i - n + 1 + k]; sy += y; sxy += k * y; }
    const slope = (n * sxy - sx * sy) / den;
    const inter = (sy - slope * sx) / n;
    out[i] = inter + slope * (n - 1);
  }
  return out;
}

/**
 * Squeeze Momentum (LazyBear). Боллинджер внутри Кельтнера = сжатие.
 * В опубликованном исходнике опечатка — в расчёте BB стоит multKC;
 * здесь исправлено, как в обновлении автора.
 */
export function squeeze(c, { bbLen = 20, bbMult = 2, kcLen = 20, kcMult = 1.5 } = {}) {
  const close = c.map(x => x.c);
  const basis = sma(close, bbLen), dev = stdev(close, bbLen);
  const ma = sma(close, kcLen), rangeMa = sma(trueRange(c), kcLen);

  const on = new Array(c.length).fill(false);
  for (let i = 0; i < c.length; i++) {
    if (basis[i] == null || ma[i] == null) continue;
    const bbU = basis[i] + bbMult * dev[i], bbL = basis[i] - bbMult * dev[i];
    const kcU = ma[i] + kcMult * rangeMa[i], kcL = ma[i] - kcMult * rangeMa[i];
    on[i] = bbL > kcL && bbU < kcU;
  }

  // Массивы верхов и низов вынесены из цикла: иначе на каждый бар
  // выделялась бы новая копия — на телефоне это заметно.
  const hs = c.map(x => x.h), ls = c.map(x => x.l);
  const src = c.map((x, i) => {
    if (ma[i] == null) return 0;
    const mid = (highest(hs, kcLen, i) + lowest(ls, kcLen, i)) / 2;
    return x.c - (mid + ma[i]) / 2;
  });
  return { on, mom: linreg(src, kcLen) };
}

/**
 * UT Bot Alerts: скользящий стоп на ATR. Флип стопа — сигнал разворота.
 */
export function utBot(c, { keyValue = 1, atrPeriod = 10 } = {}) {
  const a = atr(c, atrPeriod);
  const stop = new Array(c.length).fill(null);
  const pos = new Array(c.length).fill(0);
  for (let i = 0; i < c.length; i++) {
    if (a[i] == null) continue;
    const loss = keyValue * a[i];
    const px = c[i].c, prevPx = c[i - 1]?.c ?? px, prev = stop[i - 1];
    if (prev == null) { stop[i] = px - loss; pos[i] = 1; continue; }
    stop[i] = px > prev && prevPx > prev ? Math.max(prev, px - loss)
            : px < prev && prevPx < prev ? Math.min(prev, px + loss)
            : px > prev ? px - loss : px + loss;
    pos[i] = px > stop[i] ? 1 : -1;
  }
  const buy = c.map((_, i) => i > 0 && pos[i] === 1 && pos[i - 1] === -1);
  const sell = c.map((_, i) => i > 0 && pos[i] === -1 && pos[i - 1] === 1);
  return { stop, pos, buy, sell };
}

/**
 * Свинговые экстремумы: бар — вершина, если он выше len баров слева и справа.
 * Подтверждается только через len баров — это цена за отсутствие ложных пивотов.
 */
export function pivots(c, len = 10) {
  const ph = new Array(c.length).fill(false);
  const pl = new Array(c.length).fill(false);
  for (let i = len; i < c.length - len; i++) {
    let hi = true, lo = true;
    for (let j = i - len; j <= i + len; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) hi = false;
      if (c[j].l <= c[i].l) lo = false;
    }
    ph[i] = hi; pl[i] = lo;
  }
  return { ph, pl };
}

/**
 * Структура рынка: последние подтверждённые свинги на каждом баре.
 * Пробой последнего лоу при лонге — слом структуры (CHoCH).
 */
export function structure(c, len = 10) {
  const { ph, pl } = pivots(c, len);
  const lastHigh = new Array(c.length).fill(null);
  const lastLow = new Array(c.length).fill(null);
  let h = null, l = null;
  for (let i = 0; i < c.length; i++) {
    // Пивот на баре i становится известен только на баре i+len.
    const src = i - len;
    if (src >= 0 && ph[src]) h = c[src].h;
    if (src >= 0 && pl[src]) l = c[src].l;
    lastHigh[i] = h; lastLow[i] = l;
  }
  return { lastHigh, lastLow };
}
