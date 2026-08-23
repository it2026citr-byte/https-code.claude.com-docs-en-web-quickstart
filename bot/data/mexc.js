import { db } from "../db.js";
import { cfg, log } from "../config.js";

const BASE = "https://api.mexc.com/api/v3";

// MEXC отдаёт свечи спота. Перпетуал (contract.mexc.com) закрыт их CDN — 403,
// но расхождение цены в десятых процента, для ATR и структуры несущественно.
const TF_MAP = { "1m":"1m", "5m":"5m", "15m":"15m", "30m":"30m", "1h":"60m", "4h":"4h", "1d":"1d" };
export const TF_SEC = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600, "4h":14400, "1d":86400 };

const ins = db.prepare(
  "INSERT INTO candles(symbol,tf,open_time,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?) " +
  "ON CONFLICT(symbol,tf,open_time) DO UPDATE SET " +
  "h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v"
);

/** Свечи с биржи + запись в кеш. Возвращает массив от старых к новым. */
export async function fetchKlines(symbol, tf, limit = 300) {
  const iv = TF_MAP[tf];
  if (!iv) throw new Error(`неизвестный таймфрейм ${tf}`);
  const url = `${BASE}/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MEXC ${symbol} ${tf}: HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error(`MEXC ${symbol}: неожиданный ответ`);

  const out = raw.map(k => ({
    t: Math.floor(k[0] / 1000),
    o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
  }));
  const tx = db.prepare("BEGIN"); // ручная транзакция — заметно быстрее
  try {
    tx.run();
    for (const c of out) ins.run(symbol, tf, c.t, c.o, c.h, c.l, c.c, c.v);
    db.prepare("COMMIT").run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    log("кеш свечей не записан:", e.message);
  }
  return out;
}

/**
 * Глубокая история: биржа отдаёт максимум 500 свечей за раз, поэтому
 * идём окнами назад по времени. Нужна для разбора монеты при добавлении
 * в список — полгода часовых свечей это примерно 4400 баров.
 */
export async function deepHistory(symbol, tf, want) {
  const iv = TF_MAP[tf];
  if (!iv) throw new Error(`неизвестный таймфрейм ${tf}`);
  const sec = TF_SEC[tf];
  const out = [];
  let end = Date.now();

  while (out.length < want) {
    const start = end - 500 * sec * 1000;
    const url = `${BASE}/klines?symbol=${symbol}&interval=${iv}` +
                `&startTime=${start}&endTime=${end}&limit=500`;
    const res = await fetch(url);
    if (!res.ok) break;
    const raw = await res.json();
    if (!Array.isArray(raw) || !raw.length) break;
    const part = raw.map(k => ({
      t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
    }));
    out.unshift(...part);
    if (part.length < 400) break;              // история кончилась
    end = part[0].t * 1000 - 1;
  }

  const seen = new Set(), uniq = [];
  for (const c of out) if (!seen.has(c.t)) { seen.add(c.t); uniq.push(c); }
  uniq.sort((a, b) => a.t - b.t);
  return uniq.slice(-want);
}

/** Есть ли такая пара на бирже. */
export async function pairExists(symbol) {
  try {
    const r = await fetch(`${BASE}/ticker/price?symbol=${symbol}`);
    if (!r.ok) return false;
    return Boolean((await r.json()).price);
  } catch { return false; }
}

/** Последняя цена по паре. */
export async function lastPrice(symbol) {
  const res = await fetch(`${BASE}/ticker/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`MEXC цена ${symbol}: HTTP ${res.status}`);
  return +(await res.json()).price;
}

/**
 * Цены по списку пар.
 *
 * Запрос без параметра отдаёт ВСЕ ~2800 пар: 17,5 КБ на проводе после gzip.
 * В фокусе, каждые 10 секунд, это 151 МБ в сутки независимо от числа
 * открытых сделок. Поштучный запрос весит 829 б — но из них 790 занимают
 * заголовки HTTP, а полезных данных всего 39 байт.
 *
 * Отсюда равновесие: 17497 / 829 = 21,1 пары. Меньше — дешевле поштучно,
 * больше — выгоднее один общий запрос.
 *
 * Если открытых сделок станет много, правильный ответ не в подборе порога,
 * а в подписке на поток MEXC по WebSocket: там заголовки платятся один раз.
 */
export async function prices(symbols) {
  const list = [...new Set(symbols)];
  const out = {};

  if (list.length < cfg.bulkPriceThreshold) {
    await Promise.all(list.map(async (s) => {
      try { out[s] = await lastPrice(s); }
      catch (e) { log(`цена ${s}:`, e.message); }
    }));
    return out;
  }

  const res = await fetch(`${BASE}/ticker/price`);
  if (!res.ok) throw new Error(`MEXC цены: HTTP ${res.status}`);
  const want = new Set(list);
  for (const r of await res.json()) if (want.has(r.symbol)) out[r.symbol] = +r.price;
  return out;
}
