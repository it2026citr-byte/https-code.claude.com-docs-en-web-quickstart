import { log } from "./config.js";

/**
 * Фигуры графика — что цена нарисовала перед сигналом.
 *
 * Окно — последние ~80 баров. Каждый детектор отвечает парой
 * { name, dir }: имя фигуры и направление, которое она обещает
 * (+1 вверх, −1 вниз, 0 — сжатие без стороны).
 *
 * ── Замер ──
 *
 * Те же 3355 сигналов, 41 пара, 46 недель. Хоть одна фигура находится
 * у 68% сигналов. Исход зависит от отношения фигуры к стороне входа:
 *
 *   фигура ЗА сигнал      2171 шт   +0.107R
 *   фигуры нет            1076 шт   +0.021R
 *   фигура ПРОТИВ           53 шт   −0.046R
 *
 * Главное — прибавка не растворяется в остальном отборе: поверх трёх
 * условий gate.js требование «фигура за» поднимает средний R с +0.144
 * до +0.181, и прибавка положительна во всех пяти срезах (обе половины
 * монет, все трети периода). То есть фигура меряет не то же самое, что
 * биткоин и тренд.
 *
 * По именам (когда фигура за сигнал): пробой диапазона вниз +0.179,
 * двойная вершина +0.130, восходящий треугольник +0.135, двойное дно
 * +0.092, голова и плечи +0.180 (42 шт), перевёрнутые +0.317 (36 шт).
 * Единственная фигура с минусом — нисходящий треугольник (−0.059 на
 * 89 шт): пробитая вниз плоская поддержка на нашем горизонте чаще
 * выкупается. Флаги встречаются слишком редко, чтобы судить (22 шт).
 *
 * Пороги внутри детекторов меряются в ATR, а не в процентах: «равные
 * вершины» у BTC и у мемкоина — разные проценты, но одинаковые ATR.
 */

/** Свинги: локальные экстремумы с крылом w баров в обе стороны. */
function swings(c, a, b, w = 3) {
  const hi = [], lo = [];
  for (let i = a + w; i <= b - w; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= w; k++) {
      if (c[i].h < c[i - k].h || c[i].h < c[i + k].h) isH = false;
      if (c[i].l > c[i - k].l || c[i].l > c[i + k].l) isL = false;
    }
    if (isH) hi.push({ i, v: c[i].h });
    if (isL) lo.push({ i, v: c[i].l });
  }
  return { hi, lo };
}

const atrAt = (c, i, n = 14) => {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(c[k].h - c[k].l,
      Math.abs(c[k].h - c[k - 1].c), Math.abs(c[k].l - c[k - 1].c));
  return s / n;
};

/** Все фигуры, видимые на баре i. Пустой список — фигур нет. */
export function detect(c, i) {
  const a = Math.max(20, i - 80), out = [];
  if (!c || i - a < 30 || i >= c.length) return out;
  const A = atrAt(c, i);
  if (!(A > 0)) return out;
  const { hi, lo } = swings(c, a, i);
  const px = c[i].c;
  const near = (x, y) => Math.abs(x - y) <= 0.6 * A;

  // Двойное дно / вершина: два равных экстремума не ближе 8 баров,
  // между ними откат ≥1.5 ATR, второй — недавний, подтверждение —
  // цена уже прошла половину отката.
  const L = lo.slice(-4), H = hi.slice(-4);
  for (let x = 0; x < L.length - 1; x++)
    for (let y = x + 1; y < L.length; y++) {
      const p = L[x], q = L[y];
      if (q.i - p.i < 8 || !near(p.v, q.v)) continue;
      const peak = Math.max(...c.slice(p.i, q.i + 1).map(b => b.h));
      if (peak - Math.max(p.v, q.v) >= 1.5 * A && q.i >= i - 25 && px > (p.v + peak) / 2)
        out.push({ name: "двойное дно", dir: +1 });
    }
  for (let x = 0; x < H.length - 1; x++)
    for (let y = x + 1; y < H.length; y++) {
      const p = H[x], q = H[y];
      if (q.i - p.i < 8 || !near(p.v, q.v)) continue;
      const trough = Math.min(...c.slice(p.i, q.i + 1).map(b => b.l));
      if (Math.min(p.v, q.v) - trough >= 1.5 * A && q.i >= i - 25 && px < (p.v + trough) / 2)
        out.push({ name: "двойная вершина", dir: -1 });
    }

  // Голова и плечи: средний пик выше крайних на ≥0.8 ATR, крайние
  // примерно равны, цена уже у линии шеи. Обратная — зеркально.
  if (H.length >= 3) {
    const [l, h, r] = H.slice(-3).map(x => x.v);
    if (h - l >= 0.8 * A && h - r >= 0.8 * A && Math.abs(l - r) <= A) {
      const neck = Math.min(...c.slice(H.at(-3).i, H.at(-1).i + 1).map(b => b.l));
      if (px < neck + 0.3 * A) out.push({ name: "голова и плечи", dir: -1 });
    }
  }
  if (L.length >= 3) {
    const [l, h, r] = L.slice(-3).map(x => x.v);
    if (l - h >= 0.8 * A && r - h >= 0.8 * A && Math.abs(l - r) <= A) {
      const neck = Math.max(...c.slice(L.at(-3).i, L.at(-1).i + 1).map(b => b.h));
      if (px > neck - 0.3 * A) out.push({ name: "перевёрнутые голова и плечи", dir: +1 });
    }
  }

  // Треугольники по трём последним свингам каждой стороны.
  // Нисходящий по замеру убыточен, но детектор честно его называет:
  // решает отбор и человек, а не молчание детектора.
  if (hi.length >= 3 && lo.length >= 3) {
    const h3 = hi.slice(-3), l3 = lo.slice(-3);
    const hFlat = near(h3[0].v, h3[2].v) && near(h3[1].v, h3[2].v);
    const lFlat = near(l3[0].v, l3[2].v) && near(l3[1].v, l3[2].v);
    const hDown = h3[0].v - h3[2].v >= 0.8 * A && h3[1].v >= h3[2].v;
    const lUp = l3[2].v - l3[0].v >= 0.8 * A && l3[1].v <= l3[2].v;
    if (hFlat && lUp) out.push({ name: "восходящий треугольник", dir: +1 });
    else if (lFlat && hDown) out.push({ name: "нисходящий треугольник", dir: -1 });
    else if (hDown && lUp) out.push({ name: "сжатие (симметричный треугольник)", dir: 0 });
  }

  // Флаг: импульс ≥3 ATR за 10 баров, затем узкая короткая пауза.
  for (const dir of [+1, -1]) {
    for (let s0 = i - 18; s0 <= i - 6; s0++) {
      if (s0 - 10 < a) continue;
      const move = (c[s0].c - c[s0 - 10].c) * dir;
      if (move < 3 * A) continue;
      const cons = c.slice(s0, i + 1);
      if (cons.length < 3 || cons.length > 9) continue;
      const w = Math.max(...cons.map(b => b.h)) - Math.min(...cons.map(b => b.l));
      const drift = (c[i].c - c[s0].c) * dir;
      if (w <= 2 * A && drift > -1.5 * A) {
        out.push({ name: dir > 0 ? "бычий флаг" : "медвежий флаг", dir });
        break;
      }
    }
  }

  // Пробой диапазона 40 баров (без трёх последних — иначе пробой
  // сравнивался бы сам с собой).
  const rngHi = Math.max(...c.slice(i - 43, i - 3).map(b => b.h));
  const rngLo = Math.min(...c.slice(i - 43, i - 3).map(b => b.l));
  if (px > rngHi + 0.1 * A) out.push({ name: "пробой диапазона вверх", dir: +1 });
  if (px < rngLo - 0.1 * A) out.push({ name: "пробой диапазона вниз", dir: -1 });

  return out;
}

/** Строка для карточки: фигуры и их отношение к стороне входа. */
export function figuresLine(figs, side) {
  if (!figs?.length) return null;
  const want = side === "long" ? 1 : -1;
  const mark = (f) => f.dir === 0 ? `${f.name} · без стороны`
    : f.dir === want ? `${f.name} — за вход` : `${f.name} — ПРОТИВ входа`;
  return figs.map(mark).join("; ");
}

log("разбор фигур графика подключён");
