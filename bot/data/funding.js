import { log } from "../config.js";

/**
 * Ставка финансирования по бессрочным фьючерсам MEXC.
 *
 * Это единственные данные в боте, которых нет в свечах: они говорят не
 * о цене, а о том, за какую сторону рынок готов доплачивать. Проверка
 * на 59 ликвидных парах за семь месяцев показала, что повышенная ставка
 * работает не как признак перекоса (вопреки расхожему мнению), а как
 * признак живого импульса: после ставки выше 0,03% средний ход за двое
 * суток заметно выше случайного.
 *
 * Ставка пересчитывается раз в восемь часов, поэтому как спусковой
 * крючок она медленная — годится только как условие первого этапа,
 * а вход даёт уже цена.
 */

const CACHE_MS = 20 * 60_000;        // ставка меняется втрое реже
let cache = { at: 0, map: new Map() };
let loading = null;

const toContract = (s) => s.endsWith("USDT") ? `${s.slice(0, -4)}_USDT` : s;

const URL = "https://contract.mexc.com/api/v1/contract/ticker";

/**
 * Фьючерсный узел биржи отвечает не всем клиентам одинаково: обычный
 * запрос из Node с некоторых адресов получает отказ, а curl проходит.
 * Поэтому сначала пробуем как есть, а при отказе — через curl.
 * На телефоне обычно хватает первого пути.
 */
export async function futuresGet(url = URL) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (r.ok) return await r.text();
    log(`фьючерсный узел ответил ${r.status}, пробую через curl`);
  } catch (e) {
    log(`фьючерсный узел недоступен (${e.message}), пробую через curl`);
  }
  const { execFile } = await import("node:child_process");
  return new Promise((ok, no) => {
    execFile("curl", ["-s", "-m", "25", "-A", "Mozilla/5.0", url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, out) => {
        if (err) return no(new Error(`curl не сработал: ${err.message}`));
        if (!out) return no(new Error("пустой ответ"));
        ok(out);
      });
  });
}

async function pull() {
  // Биржа отдаёт все контракты одним запросом — по одному было бы
  // больше тысячи обращений на такт.
  const body = await futuresGet();
  let j;
  try { j = JSON.parse(body); }
  catch { throw new Error("ответ не разобрался как JSON"); }
  const list = j?.data;
  if (!Array.isArray(list)) throw new Error("неожиданный ответ биржи");
  const map = new Map();
  for (const x of list) {
    if (!x?.symbol) continue;
    const spot = String(x.symbol).replace("_USDT", "USDT");
    map.set(spot, {
      rate: Number(x.fundingRate) * 100,      // в процентах
      oi: Number(x.holdVol) || null,          // открытый интерес
      last: Number(x.lastPrice) || null,
    });
  }
  return map;
}

/** Свежая карта ставок. Ошибку не роняем — стратегия просто промолчит. */
export async function refresh() {
  if (Date.now() - cache.at < CACHE_MS) return cache.map;
  if (loading) return loading;
  loading = pull()
    .then((map) => {
      cache = { at: Date.now(), map };
      log(`ставки финансирования: ${map.size} контрактов`);
      return map;
    })
    .catch((e) => {
      log("ставки финансирования не обновились:", e.message);
      return cache.map;                        // отдаём прошлые, если были
    })
    .finally(() => { loading = null; });
  return loading;
}

/** Ставка по паре в процентах. null — данных нет. */
export const rateOf = (symbol) => cache.map.get(symbol)?.rate ?? null;
export const infoOf = (symbol) => cache.map.get(symbol) ?? null;
export const known = () => cache.map.size;
export const stale = () => Date.now() - cache.at > 2 * CACHE_MS;

export { toContract };
