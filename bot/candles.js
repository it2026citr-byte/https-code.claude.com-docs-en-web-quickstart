import { fetchKlines } from "./data/mexc.js";
import { log } from "./config.js";

/**
 * Кеш свечей в памяти.
 *
 * В режиме фокуса структура пересчитывается каждые 10 секунд, а тянуть
 * ради этого 300 свечей — 11 КБ на запрос, почти 100 МБ в сутки на одну
 * позицию. Поэтому историю держим в памяти, а с биржи забираем только
 * хвост: три последние свечи весят около полутора килобайт вместе
 * с заголовками, то есть 12 МБ в сутки.
 */
const cache = new Map();          // "SYMBOL|tf" → { arr }
const TAIL = 3;

export async function candles(symbol, tf, limit = 300) {
  const key = `${symbol}|${tf}`;
  const hit = cache.get(key);

  if (!hit || hit.arr.length < limit * 0.8) {
    const arr = await fetchKlines(symbol, tf, limit);
    cache.set(key, { arr });
    return arr;
  }

  let tail;
  try { tail = await fetchKlines(symbol, tf, TAIL); }
  catch (e) { log(`хвост ${symbol} не пришёл:`, e.message); return hit.arr; }

  const arr = hit.arr;
  for (const c of tail) {
    const i = arr.findIndex(x => x.t === c.t);
    if (i >= 0) arr[i] = c;                       // формирующаяся свеча обновилась
    else arr.push(c);                             // родилась новая
  }
  arr.sort((a, b) => a.t - b.t);
  if (arr.length > limit + 60) arr.splice(0, arr.length - limit);
  return arr;
}

export const forget = (symbol, tf) => cache.delete(`${symbol}|${tf}`);
export const cacheSize = () => cache.size;
