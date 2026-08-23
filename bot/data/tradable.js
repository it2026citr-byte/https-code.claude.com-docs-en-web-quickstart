import { log } from "../config.js";
import { perpetuals } from "./tradingview.js";

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
 */

const STOCK = /STOCK/i;
const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDE|USDP|PYUSD|EURT|EURS|USD1|USDD|XAUT|PAXG)USDT$/;

let perp = null;

/** Причина отказа или null, если пара годится. Требует свежего списка. */
export function rejectReason(symbol) {
  if (STOCK.test(symbol)) return "это токенизированная акция, а не криптовалюта";
  if (STABLE.test(symbol)) return "это стейблкоин, ходить там нечему";
  if (!perp || perp.size < 100) return null;   // списка нет — не запрещаем вслепую
  if (!perp.has(symbol)) return "нет бессрочного фьючерса на MEXC";
  return null;
}

/** То же, но сперва подтягивает список фьючерсных пар. */
export async function checkTradable(symbol) {
  try { perp = await perpetuals(); } catch { /* решим по прежнему списку */ }
  return rejectReason(symbol);
}

export const isTradable = (symbol) => rejectReason(symbol) === null;
export const futuresKnown = () => perp?.size ?? 0;

log("проверка пригодности пар подключена");
