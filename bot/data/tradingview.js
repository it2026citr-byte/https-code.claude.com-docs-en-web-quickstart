import { cfg, log } from "../config.js";

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

const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDE|USDP|PYUSD|EURT|EURS|USD1|USDD|XAUT|PAXG)USDT$/;

/**
 * Топ пар MEXC/USDT по обороту В ДОЛЛАРАХ.
 * Колонка volume у крипты — объём в базовой валюте, поэтому сортировка
 * скринера выносит наверх микро-токены, а BTC проваливается. Готовой
 * колонки оборота в долларах нет — считаем volume × close сами.
 */
export async function topPairs(limit = cfg.topByTurnover) {
  const j = await scan({
    filter: [
      { left: "exchange", operation: "equal", right: "MEXC" },
      { left: "name", operation: "match", right: "USDT$" },
    ],
    columns: ["name", "close", "volume", "change"],
    sort: { sortBy: "volume", sortOrder: "desc" },
    range: [0, 2000],
  });

  const rows = [];
  for (const r of j.data || []) {
    const [name, close, volume, change] = r.d;
    if (!name || !close || !volume) continue;
    if (STABLE.test(name)) continue;
    if (/\d+(L|S)USDT$/.test(name)) continue;       // плечевые токены
    const volUsd = volume * close;
    if (volUsd < cfg.minTurnoverUsd) continue;
    rows.push({ symbol: name, close, volUsd, change });
  }
  rows.sort((a, b) => b.volUsd - a.volUsd);
  log(`TradingView: ${j.totalCount} пар, после фильтров ${rows.length}`);
  return rows.slice(0, limit);
}
