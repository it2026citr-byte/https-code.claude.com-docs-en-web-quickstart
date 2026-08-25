import { log } from "../config.js";
import { perpetuals } from "./tradingview.js";
import { futuresGet } from "./funding.js";

/**
 * Годится ли пара для сигналов.
 *
 * Требование одно: торгуем только бессрочные фьючерсы криптовалют.
 * Отсюда три отказа.
 *
 * Нет бессрочного контракта. Сигнал по паре, которой нет на фьючерсах,
 * исполнить нечем: спот на MEXC — другой рынок с другой ликвидностью,
 * а половина стратегий рассчитана на плечо.
 *
 * Токенизированные акции (COFSTOCK, AZNSTOCK и прочие). Они торгуются
 * круглосуточно, тогда как биржа акций закрыта, и ставка финансирования
 * у них уезжает до полупроцента по причинам, никак не связанным с
 * крипторынком. В проверке Funding-Impulse их не было, значит и в
 * работе быть не должно.
 *
 * Стейблкоины и обёрнутое золото. Там нет хода, на котором можно
 * что-то заработать.
 *
 * Наличие контракта проверяем по списку TradingView, а не по именам
 * контрактов биржи: на фьючерсах они другие. Спотовая PUMPUSDT живёт
 * там как PUMPFUN_USDT, TRUMPUSDT как TRUMPOFFICIAL_USDT, FILUSDT как
 * FILECOIN_USDT, а дешёвые монеты идут с приставкой 1000 или 1000000.
 * Сверка имён в лоб отвергала бы вполне торгуемые пары.
 *
 * Но одного наличия контракта мало. Часть контрактов биржа держит в
 * «зоне инноваций»: они торгуются и отдают свечи, однако в обычном
 * поиске приложения их нет, и открыть по ним позицию человек не может.
 * Поймано на CASHCATUSDT — сканер выдал по нему сигнал, а найти пару на
 * фьючерсах не удалось. У всех таких контрактов стоит apiAllowed:false,
 * и таких на бирже ровно столько же, сколько помеченных зоной инноваций
 * (31 из 1146 на 25 августа) — признак совпадает один в один, поэтому
 * отсекаем по нему.
 */

const STOCK = /STOCK/i;
const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDE|USDP|PYUSD|EURT|EURS|USD1|USDD|XAUT|PAXG)USDT$/;

let perp = null;
/** Базовые монеты, чей контракт закрыт для обычной торговли. */
let closed = null;

/** Причина отказа или null, если пара годится. Требует свежего списка. */
export function rejectReason(symbol) {
  if (STOCK.test(symbol)) return "это токенизированная акция, а не криптовалюта";
  if (STABLE.test(symbol)) return "это стейблкоин, ходить там нечему";
  if (closed?.has(base(symbol)))
    return "фьючерс есть, но закрыт для обычной торговли — в поиске MEXC его нет";
  if (!perp || perp.size < 100) return null;   // списка нет — не запрещаем вслепую
  if (!perp.has(symbol)) return "нет бессрочного фьючерса на MEXC";
  return null;
}

const base = (symbol) => symbol.replace(/USDT$/, "").toUpperCase();

/**
 * Список закрытых контрактов — прямо с биржи, а не из TradingView:
 * скринер про ограничения доступа ничего не знает.
 *
 * Сверяем по базовой монете. Имена контрактов местами свои (FILUSDT
 * живёт как FILECOIN_USDT), и такая пара просто не найдётся в списке —
 * значит останется разрешённой. Это осознанный перекос в сторону
 * «пропустить», чтобы из-за расхождения имён не отвергнуть торгуемое.
 */
let closedAt = 0;
export async function loadClosed() {
  if (closed && Date.now() - closedAt < 6 * 3600_000) return closed;
  try {
    const j = JSON.parse(await futuresGet("https://contract.mexc.com/api/v1/contract/detail"));
    const list = j?.data;
    if (!Array.isArray(list) || !list.length) throw new Error("неожиданный ответ биржи");
    const set = new Set();
    for (const c of list) {
      if (!c?.baseCoin) continue;
      if (c.state !== 0 || c.apiAllowed === false) set.add(String(c.baseCoin).toUpperCase());
    }
    closed = set;
    closedAt = Date.now();
    log(`контрактов закрыто для обычной торговли: ${set.size} из ${list.length}`);
  } catch (e) {
    log("список контрактов не пришёл:", e.message);   // работаем на прежнем
  }
  return closed;
}

/** То же, но сперва подтягивает список фьючерсных пар. */
export async function checkTradable(symbol) {
  try { perp = await perpetuals(); } catch { /* решим по прежнему списку */ }
  if (!closed) await loadClosed();
  return rejectReason(symbol);
}

export const isTradable = (symbol) => rejectReason(symbol) === null;
export const futuresKnown = () => perp?.size ?? 0;
export const closedKnown = () => closed?.size ?? 0;

log("проверка пригодности пар подключена");
