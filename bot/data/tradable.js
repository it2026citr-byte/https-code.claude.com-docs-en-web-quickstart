import { log } from "../config.js";
import { perpetuals } from "./tradingview.js";
import { futuresGet } from "./funding.js";

/**
 * Годится ли пара для сигналов.
 *
 * Требование одно: торгуем только бессрочные фьючерсы криптовалют.
 * Отсюда четыре отказа.
 *
 * Нет бессрочного контракта. Сигнал по паре, которой нет на фьючерсах,
 * исполнить нечем: спот на MEXC — другой рынок с другой ликвидностью,
 * а половина стратегий рассчитана на плечо.
 *
 * Контракт есть, но закрыт. Часть контрактов биржа держит в «зоне
 * инноваций»: они торгуются и отдают свечи, однако в обычном поиске
 * приложения их нет, и открыть по ним позицию человек не может.
 * Поймано на CASHCATUSDT — сканер выдал сигнал, а найти пару на
 * фьючерсах не удалось. У всех таких контрактов стоит apiAllowed:false,
 * и таких ровно столько же, сколько помеченных зоной инноваций
 * (31 из 1146 на 25 августа), — признак совпадает один в один.
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
 * ── Почему два источника ──
 *
 * Наличие контракта берём из TradingView, а не из имён контрактов
 * биржи: на фьючерсах они другие. Спотовая PUMPUSDT живёт там как
 * PUMPFUN_USDT, TRUMPUSDT как TRUMPOFFICIAL_USDT, FILUSDT как
 * FILECOIN_USDT, а дешёвые монеты идут с приставкой 1000 или 1000000.
 * Сверка имён в лоб отвергала бы вполне торгуемые пары.
 *
 * А вот закрытость берём прямо с биржи: скринер про ограничения
 * доступа не знает и такие контракты отдаёт наравне с остальными.
 * Сверяем по базовой монете, и пара с непривычным именем в списке не
 * найдётся — значит останется разрешённой. Перекос в сторону
 * «пропустить» намеренный: из-за расхождения имён нельзя отвергать то,
 * что реально торгуется.
 *
 * ── Почему отказ по умолчанию ──
 *
 * Пока списки не загружены, пригодной не считается ни одна пара.
 * Прежде было наоборот — без списка разрешали всё, — и ровно поэтому
 * отсев молча не работал: наполнял списки только асинхронный путь,
 * а спрашивал синхронный. Для фильтра, чья работа не пускать,
 * безопасное поведение — молчать, а не пропускать непроверенное.
 * Молчание видно в /status, ошибочный сигнал — нет.
 */

const STOCK = /STOCK/i;
const STABLE = /^(USDC|FDUSD|TUSD|DAI|BUSD|USDE|USDP|PYUSD|EURT|EURS|USD1|USDD|XAUT|PAXG)USDT$/;
const DETAIL = "https://contract.mexc.com/api/v1/contract/detail";
const TTL_MS = 6 * 3600_000;

const base = (symbol) => symbol.replace(/USDT$/, "").toUpperCase();

/** Пары с бессрочным контрактом и монеты, чей контракт закрыт. */
let perp = null;
let closed = null;
let at = 0;
let loading = null;

async function loadClosed() {
  const j = JSON.parse(await futuresGet(DETAIL));
  const list = j?.data;
  if (!Array.isArray(list) || !list.length) throw new Error("неожиданный ответ биржи");
  const set = new Set();
  for (const c of list) {
    if (!c?.baseCoin) continue;
    if (c.state !== 0 || c.apiAllowed === false) set.add(String(c.baseCoin).toUpperCase());
  }
  log(`контрактов закрыто для обычной торговли: ${set.size} из ${list.length}`);
  return set;
}

async function refresh() {
  // Источники независимы: если отвалился один, второй всё равно
  // обновится, а прежнее значение упавшего останется в силе.
  const [p, c] = await Promise.allSettled([perpetuals(), loadClosed()]);
  if (p.status === "fulfilled" && p.value?.size > 100) perp = p.value;
  else log("список фьючерсов не обновился:", p.reason?.message ?? "пустой ответ");
  if (c.status === "fulfilled") closed = c.value;
  else log("список контрактов не обновился:", c.reason?.message ?? "пустой ответ");
  if (perp && closed) at = Date.now();
}

/**
 * Подтянуть списки, если они устарели. Единственный вход: звать перед
 * любым разбором пар. Параллельные вызовы ждут один запрос, а не шлют
 * свой каждый — на такте таких вызовов несколько.
 */
export async function ready() {
  if (perp && closed && Date.now() - at < TTL_MS) return true;
  loading ??= refresh().finally(() => { loading = null; });
  await loading;
  return perp != null && closed != null;
}

/**
 * Причина отказа или null, если пара годится.
 *
 * Синхронная: её зовут в тесных циклах по сотне пар. Требует, чтобы
 * ready() уже отработал, — иначе честно отказывает всем.
 */
export function rejectReason(symbol) {
  if (STOCK.test(symbol)) return "это токенизированная акция, а не криптовалюта";
  if (STABLE.test(symbol)) return "это стейблкоин, ходить там нечему";
  if (!perp || !closed) return "список фьючерсов ещё не загружен";
  if (closed.has(base(symbol)))
    return "фьючерс есть, но закрыт для обычной торговли — в поиске MEXC его нет";
  if (!perp.has(symbol)) return "нет бессрочного фьючерса на MEXC";
  return null;
}

/** Разбор одной пары с гарантией свежих списков. */
export async function checkTradable(symbol) {
  await ready();
  return rejectReason(symbol);
}

/** Для /status: загружены ли списки и насколько они велики. */
export const listsState = () => ({
  perp: perp?.size ?? 0,
  closed: closed?.size ?? 0,
  ageMin: at ? Math.round((Date.now() - at) / 60_000) : null,
});

log("проверка пригодности пар подключена");
