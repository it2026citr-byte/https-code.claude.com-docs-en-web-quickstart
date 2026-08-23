import { num } from "./runtime.js";

/**
 * Подбор параметров под конкретную монету.
 *
 * Главная опасность здесь — обмануть себя. Если перебирать значения
 * по всей истории и брать лучшее, результат всегда выйдет красивым:
 * достаточно совпадений, чтобы любая случайность выглядела правилом.
 *
 * Поэтому история делится надвое. Подбор идёт по первым 70%, а проверка —
 * по последним 30%, которых подбор не видел. Настройка принимается только
 * если на этой невидимой части она обошла значения по умолчанию.
 * Иначе остаются умолчания, и об этом честно сообщается.
 *
 * Сетки перебора нарочно мелкие — три значения на параметр. Чем больше
 * степеней свободы, тем легче подогнать шум.
 */

const SPLIT = 0.7;
const MIN_SIGNALS = 6;      // меньше — не статистика, подбирать не по чему

function simulate(c, i, long, entry, dist, hold, beAt) {
  const tg = [1,2,3,4,5].map(n => long ? entry + .5*n*dist : entry - .5*n*dist);
  const beLevel = beAt < 0.5 ? (long ? entry + beAt*dist : entry - beAt*dist) : null;
  let hit = 0, left = 1, banked = 0, be = false;
  let stop = long ? entry - dist : entry + dist;
  for (let j = i + 1; j < Math.min(c.length, i + 1 + hold); j++) {
    const b = c[j];
    if (long ? b.l <= stop : b.h >= stop)
      return { r: banked + left * ((long ? stop - entry : entry - stop) / dist),
               stopped: hit === 0 && !be };
    if (beLevel != null && !be && (long ? b.h >= beLevel : b.l <= beLevel)) { be = true; stop = entry; }
    while (hit < 5 && (long ? b.h >= tg[hit] : b.l <= tg[hit])) {
      hit++; banked += 0.2 * 0.5 * hit; left -= 0.2;
      if (hit === 1) stop = entry;
    }
    if (hit === 5) return { r: banked, stopped: false };
  }
  const last = c[Math.min(c.length, i + 1 + hold) - 1].c;
  return { r: banked + left * ((long ? last - entry : entry - last) / dist), stopped: false };
}

/** Прогон одного варианта стратегии на отрезке [from, to). */
function score(strat, c, x, from, to, hold, beAt) {
  let n = 0, win = 0, sumR = 0, stops = 0;
  for (let i = from; i < to; i++) {
    const s = strat.evaluate(c, x, i);
    if (!s) continue;
    const r = simulate(c, i, s.side === "long", s.entry, Math.abs(s.entry - s.sl), hold, beAt);
    n++; sumR += r.r;
    if (r.r > 0) win++;
    if (r.stopped) stops++;
  }
  return { n, win, stops, sumR, avgR: n ? sumR / n : 0,
           rate: n ? win / n : 0 };
}

const combos = (grid) => {
  const keys = Object.keys(grid);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of out) for (const v of grid[k]) next.push({ ...base, [k]: v });
    out = next;
  }
  return out;
};

export async function tuneStrategy(strategy, candles, hold, symbol) {
  const beAt = num("be_at") / 100;
  const c = candles;
  const warm = strategy.warmup;
  const usable = c.length - 1 - hold;
  if (!strategy.make || !strategy.tunable || usable - warm < 400) return null;

  const edge = Math.floor(warm + (usable - warm) * SPLIT);
  const base = strategy;
  const baseX = base.prepare(c, symbol);
  const baseTrain = score(base, c, baseX, warm, edge, hold, beAt);
  const baseTest = score(base, c, baseX, edge, usable, hold, beAt);

  let best = null;
  for (const p of combos(strategy.tunable)) {
    const v = strategy.make(p);
    const x = v.prepare(c, symbol);
    const tr = score(v, c, x, warm, edge, hold, beAt);
    if (tr.n < MIN_SIGNALS) continue;
    if (!best || tr.sumR > best.train.sumR) best = { params: p, train: tr, variant: v, x };
  }
  if (!best) return { chosen: false, why: "мало сигналов для подбора", baseTest, baseTrain };

  const test = score(best.variant, c, best.x, edge, usable, hold, beAt);
  const better = test.sumR > baseTest.sumR && test.n >= 3;

  return {
    chosen: better,
    params: best.params,
    train: best.train,
    test,
    baseTrain, baseTest,
    why: better ? null : "на проверочной части не обошла умолчания",
  };
}
