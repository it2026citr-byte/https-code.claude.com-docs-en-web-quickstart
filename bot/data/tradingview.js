import { cfg, log } from "../config.js";
import { num } from "../runtime.js";

const URL = "https://scanner.tradingview.com/crypto/scan";

// Content-Type обязан быть text/plain: в access-control-allow-headers
// у TradingView только Referer и Accept, поэтому application/json
// вызвал бы предзапрос CORS. Тело при этом разбирается как JSON.
async function scan(body) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TradingView: HTTP ${res.status}`);
  return res.json();
}

/**
 * Список пар, у которых есть бессрочный контракт.
 *
 * Скринер по умолчанию отдаёт спот, и без этой проверки бот выдавал
 * сигналы по монетам, которых на фьючерсах нет вовсе — поймано
 * на SEDAUSDT. Ранжирование при этом остаётся спотовым: у перпетуалов
 * объём считается в контрактах, и оборот в долларах по нему не восстановить.
 */
let perpCache = { at: 0, set: null };
async function perpetuals() {
  if (perpCache.set && Date.now() - perpCache.at < 6 * 3600_000) return perpCache.set;
  try {
    const j = await scan({
      filter: [
        { left: "exchange", operation: "equal", right: "MEXC" },
        { left: "type", operation: "equal", right: "swap" },
      ],
      columns: ["name"],
      range: [0, 3000],
    });
    const set = new Set((j.data || []).map(r => String(r.d[0]).replace(/\.P$/, "")));
    if (set.size > 100) { perpCache = { at: Date.now(), set }; log(`фьючерсных пар: ${set.size}`); }
    return perpCache.set ?? set;
  } catch (e) {
    log("список фьючерсов не пришёл:", e.message);
    return perpCache.set;          // работаем на прежнем, если он был
  }
}

const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDE|USDP|PYUSD|EURT|EURS|USD1|USDD|XAUT|PAXG)USDT$/;

/**
 * Топ пар MEXC/USDT по обороту В ДОЛЛАРАХ.
 * Колонка volume у крипты — объём в базовой валюте, поэтому сортировка
 * скринера выносит наверх микро-токены, а BTC проваливается. Готовой
 * колонки оборота в долларах нет — считаем volume × close сами.
 */
export async function topPairs(limit = null) {
  const cap = limit ?? num("top_pairs");

  // Колонка volume у TradingView обнуляется в полночь UTC и копится
  // в течение суток. В 00:20 UTC «суточный оборот» BTC показывает
  // 3,5 млн вместо 546 млн, и порог в миллион проходят четыре пары
  // вместо семидесяти — бот слепнет на полночи.
  //
  // Поэтому порог масштабируется по доле прошедших суток. Нижняя
  // граница в 2% нужна, чтобы в первые минуты после полуночи он
  // не схлопнулся в ноль.
  const dayFrac = Math.max(0.02, (Date.now() % 86_400_000) / 86_400_000);
  const minUsd = num("min_turn_k") * 1000 * dayFrac;
  const j = await scan({
    filter: [
      { left: "exchange", operation: "equal", right: "MEXC" },
      { left: "name", operation: "match", right: "USDT$" },
    ],
    columns: ["name", "close", "volume", "change"],
    sort: { sortBy: "volume", sortOrder: "desc" },
    range: [0, 2000],
  });

  const perp = await perpetuals();
  const rows = [];
  const all = [];
  let noFut = 0;
  for (const r of j.data || []) {
    const [name, close, volume, change] = r.d;
    if (!name || !close || !volume) continue;
    if (STABLE.test(name)) continue;
    if (/\d+(L|S)USDT$/.test(name)) continue;       // плечевые токены
    // Торгуем фьючерсами — спотовые пары без контракта нам не нужны.
    if (perp && !perp.has(name)) { noFut++; continue; }
    const volUsd = volume * close;
    all.push({ symbol: name, close, volUsd, change });
    if (volUsd < minUsd) continue;
    rows.push({ symbol: name, close, volUsd, change });
  }
  rows.sort((a, b) => b.volUsd - a.volUsd);

  // Страховка: если после фильтра осталась горстка, берём верхушку
  // списка как есть. Лучше торговать по чуть менее ликвидным парам,
  // чем не видеть рынок вовсе.
  let out = rows.slice(0, cap);
  let note = "";
  if (out.length < Math.min(20, cap)) {
    out = all.sort((a, b) => b.volUsd - a.volUsd).slice(0, cap);
    note = " (порог снят, слишком мало прошло)";
  }

  log(`TradingView: ${j.totalCount} пар · без фьючерса ${noFut} · ` +
      `порог ${(minUsd/1000).toFixed(0)} тыс $ (${(dayFrac*100).toFixed(0)}% суток UTC) → ` +
      `прошло ${rows.length}, берём ${out.length}${note}`);
  return out;
}
