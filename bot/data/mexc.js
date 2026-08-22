import { db } from "../db.js";
import { log } from "../config.js";

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

/** Последняя цена по паре. */
export async function lastPrice(symbol) {
  const res = await fetch(`${BASE}/ticker/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`MEXC цена ${symbol}: HTTP ${res.status}`);
  return +(await res.json()).price;
}

/**
 * Цены по списку пар.
 *
 * Запрос без параметра отдаёт ВСЕ ~2800 пар, около 150 КБ. В режиме фокуса
 * это каждые 10 секунд — больше гигабайта в сутки, для телефона неприемлемо.
 * Поэтому при небольшом списке спрашиваем поштучно: ответ на пару ~50 байт.
 */
export async function prices(symbols) {
  const list = [...new Set(symbols)];
  const out = {};

  if (list.length <= 12) {
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
