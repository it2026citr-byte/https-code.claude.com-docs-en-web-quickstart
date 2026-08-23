import { log } from "./config.js";
import { candles } from "./candles.js";
import { atr } from "./indicators.js";
import { rejectReason } from "./data/tradable.js";
import { num } from "./runtime.js";

/**
 * Сканер «отстающих»: график с задержкой развития.
 *
 * Идея не про одну монету, а про пару, поэтому это не стратегия —
 * обычная стратегия видит только свою пару и такое увидеть не может.
 *
 * Что ищем. Монета-лидер сделала резкий скачок. Среди остальных ищем ту,
 * чей график последних суток повторяет график лидера ДО скачка, но со
 * сдвигом от пятнадцати минут до четырёх часов, и которая сама ещё почти
 * не двинулась. Ставка в том, что она повторит движение с этим же лагом.
 *
 * Проверка на сорока ликвидных парах, два месяца пятнадцатиминутных
 * свечей, контроль — случайная монета той же геометрии:
 *
 *   на часовых свечах       превосходства нет ни в одной из 14 настроек
 *   на пятнадцатиминутных   +0,353R превосходства
 *
 * Разница не случайна: на часах лаг в один-четыре бара слишком груб для
 * сдвига, который меряется минутами. Именно поэтому сканер работает
 * только на пятнадцатиминутках.
 *
 * Геометрия взята не по лучшей клетке перебора, а по середине устойчивой
 * области: во всём прямоугольнике стопа от 1 до 1,5 ATR и цели от 0,75
 * до 2 ATR превосходство положительно и все трети периода неотрицательны.
 * Лучшая клетка давала +0,479R, но брать пик — это подгонка под шум.
 */

export const DEFAULTS = {
  tf: "15m",
  win: 96,          // окно формы: сутки пятнадцатиминутных свечей
  pumpPct: 8,       // что считаем скачком лидера
  pumpBars: 8,      // за сколько баров, 8 × 15 мин = 2 часа
  quietShare: 0.35, // ведомая должна пройти меньше этой доли скачка
  minCorr: 0.85,    // насколько похожи графики
  maxLag: 16,       // до 4 часов сдвига
  stopAtr: 1.25,
  tgtAtr: 1.5,
  maxPairs: 60,     // сколько монет держим в сравнении
  cooldownH: 8,     // не повторяем ту же связку чаще
};

/** Форма графика: окно, приведённое к первой свече, в процентах. */
function shape(c, end, win) {
  const a = end - win + 1;
  if (a < 0 || !(c[a]?.c > 0) || c[end] == null) return null;
  const base = c[a].c, out = new Array(win);
  for (let k = 0; k < win; k++) {
    const v = c[a + k]?.c;
    if (v == null) return null;
    out[k] = (v / base - 1) * 100;
  }
  return out;
}

/** Корреляция Пирсона: насколько две формы похожи внешне. */
function corr(x, y) {
  const n = x.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return (dx <= 0 || dy <= 0) ? 0 : num / Math.sqrt(dx * dy);
}

const pct = (c, from, to) =>
  (c[from]?.c > 0 && c[to]?.c != null) ? (c[to].c / c[from].c - 1) * 100 : null;

/**
 * Один проход. Возвращает найденные связки «лидер → ведомая».
 * Свечи берутся из общего кеша, поэтому второй и следующие проходы
 * тянут с биржи только хвост.
 */
/**
 * Пороги читаются на каждом проходе, а не при загрузке: правка из
 * Telegram применяется со следующего скана, перезапускать нечего.
 */
function fromSettings() {
  const lag = Math.max(1, Math.round(num("ll_lag") / 15));   // минуты → бары
  return {
    pumpPct: num("ll_pump"),
    minCorr: num("ll_corr") / 100,
    maxLag: lag,
    quietShare: num("ll_quiet") / 100,
  };
}

export async function leadLag(symbols, opts = {}) {
  let live = {};
  try { live = fromSettings(); } catch { /* до первого запуска берём умолчания */ }
  const P = { ...DEFAULTS, ...live, ...opts };
  const pairs = symbols.filter(s => !rejectReason(s)).slice(0, P.maxPairs);
  if (pairs.length < 8) return [];

  // 1. Свечи по всем парам. Одна упавшая пара не должна ронять проход.
  const data = {};
  await Promise.all(pairs.map(async (s) => {
    try {
      const c = await candles(s, P.tf, 300);
      if (c.length >= P.win + P.maxLag + P.pumpBars + 4) data[s] = c;
    } catch { /* пара просто не участвует */ }
  }));
  const have = Object.keys(data);
  if (have.length < 8) return [];

  // 2. Кто только что сделал скачок. Индекс последнего закрытого бара
  //    у каждой пары свой — свечи могли прийти неровно.
  const out = [];
  for (const A of have) {
    const ca = data[A], ia = ca.length - 2;
    const jump = pct(ca, ia - P.pumpBars, ia);
    if (jump == null || Math.abs(jump) < P.pumpPct) continue;
    const up = jump > 0;
    const sa = shape(ca, ia - P.pumpBars, P.win);   // форма ДО скачка
    if (!sa) continue;

    // 3. Кто похож на лидера до скачка и сам ещё стоит.
    let best = null;
    for (const B of have) {
      if (B === A) continue;
      const cb = data[B], ib = cb.length - 2;
      const own = pct(cb, ib - P.pumpBars, ib);
      if (own == null) continue;
      if (Math.abs(own) > Math.abs(jump) * P.quietShare) continue;
      for (let lag = 1; lag <= P.maxLag; lag++) {
        const sb = shape(cb, ib - P.pumpBars - lag, P.win);
        if (!sb) continue;
        const k = corr(sa, sb);
        if (k >= P.minCorr && (!best || k > best.corr))
          best = { symbol: B, corr: k, lag, own };
      }
    }
    if (!best) continue;

    // 4. Геометрия сделки от волатильности ведомой.
    const cb = data[best.symbol], ib = cb.length - 2;
    const a = atr(cb, 14)[ib];
    const entry = cb[ib].c;
    if (!(a > 0) || !(entry > 0)) continue;
    const dist = P.stopAtr * a;
    if (dist / entry * 100 < 0.15) continue;      // шум

    const side = up ? "long" : "short";
    const sl = up ? entry - dist : entry + dist;
    const step = P.tgtAtr * a;
    out.push({
      side,
      symbol: best.symbol,
      leader: A,
      entry, sl,
      targets: [1, 2, 3, 4, 5].map(n => up ? entry + step * n : entry - step * n),
      corr: best.corr,
      lagMin: best.lag * 15,
      leaderMove: jump,
      ownMove: best.own,
      barTime: cb[ib].t,
    });
  }

  if (out.length) log(`отстающие: найдено связок ${out.length}`);
  return out;
}
