import { fetchKlines } from "./data/mexc.js";
import { log } from "./config.js";

/**
 * Обход списка с ограничением на число одновременных задач.
 *
 * Живёт здесь, потому что почти всегда ограничивают именно поход за
 * свечами. Шестьдесят одновременных запросов к бирже проходят на
 * быстром канале и намертво встают на телефоне через мобильный
 * интернет — а биржа вдобавок вправе отбить пачку целиком.
 */
export async function mapLimit(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const { value, done } = it.next();
      if (done) return;
      try { await fn(value); } catch (e) { log("задача сорвалась:", e.message); }
    }
  });
  await Promise.all(workers);
}

/**
 * Кеш свечей в памяти.
 *
 * В режиме фокуса структура пересчитывается каждые 10 секунд, а тянуть
 * ради этого 300 свечей — 11 КБ на запрос, почти 100 МБ в сутки на одну
 * позицию. Поэтому историю держим в памяти, а с биржи забираем только
 * хвост: три последние свечи весят около полутора килобайт вместе
 * с заголовками, то есть 12 МБ в сутки.
 *
 * Пары в кеше вытесняются: вселенная пересобирается по обороту каждый
 * скан, и монета, вылетевшая из неё, иначе осталась бы в памяти
 * навсегда. Одна пара занимает около 47 КБ, за месяц набегало бы
 * порядка тридцати мегабайт — на телефоне это заметно.
 */
const cache = new Map();          // "SYMBOL|tf" → { arr, at }
const TAIL = 3;
const KEEP_MS = 6 * 3600_000;     // не трогали столько — выбрасываем
const MAX_KEYS = 600;             // жёсткий потолок на всякий случай

/** Выбросить давно не нужное. Дёшево: проход по ключам без копирования. */
function evict() {
  const now = Date.now();
  for (const [k, v] of cache)
    if (now - v.at > KEEP_MS) cache.delete(k);

  // Если и после этого много — убираем самые старые по обращению.
  if (cache.size > MAX_KEYS) {
    const byAge = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < byAge.length - MAX_KEYS; i++) cache.delete(byAge[i][0]);
  }
}
let sinceEvict = 0;

export async function candles(symbol, tf, limit = 300) {
  if (++sinceEvict >= 500) { sinceEvict = 0; evict(); }

  const key = `${symbol}|${tf}`;
  const hit = cache.get(key);

  if (!hit || hit.arr.length < limit * 0.8) {
    const arr = await fetchKlines(symbol, tf, limit);
    cache.set(key, { arr, at: Date.now() });
    return arr;
  }
  hit.at = Date.now();

  let tail;
  try { tail = await fetchKlines(symbol, tf, TAIL); }
  catch (e) { log(`хвост ${symbol} не пришёл:`, e.message); return hit.arr; }

  // Хвост всегда свежее всего, что лежит, поэтому ищем с конца и
  // дописываем в конец: порядок сохраняется сам, пересортировка
  // трёхсот свечей на каждом обновлении была бы работой впустую.
  const arr = hit.arr;
  for (const c of tail) {
    let i = arr.length - 1;
    while (i >= 0 && arr[i].t > c.t) i--;
    if (i >= 0 && arr[i].t === c.t) arr[i] = c;   // формирующаяся обновилась
    else arr.splice(i + 1, 0, c);                 // родилась новая
  }
  if (arr.length > limit + 60) arr.splice(0, arr.length - limit);
  return arr;
}

export const cacheSize = () => cache.size;
