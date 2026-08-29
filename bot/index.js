import { log, codeVersion } from "./config.js";
import { acquireLock } from "./lock.js";
import { db, now, getSetting, setSetting, openPositions, upsertUser, setRole } from "./db.js";
import { api, send, broadcast, broadcastDoc, startPolling, esc } from "./telegram.js";
import { topPairs } from "./data/tradingview.js";
import { prices, lastPrice, deepHistory } from "./data/mexc.js";
import { monitorTick, alertOnce, rAt } from "./monitor.js";
import { candles, mapLimit } from "./candles.js";
import { atr } from "./indicators.js";
import { num } from "./runtime.js";
import * as ZN from "./zones.js";
import { rejectReason, ready as tradableReady } from "./data/tradable.js";
import { loadStrategies } from "./strategies/index.js";
import { scanMarket } from "./engine.js";
import { setStrategyCount } from "./gate.js";
import { leadLag } from "./scanners.js";
import { startLoops, startReports } from "./scheduler.js";
import { fmtPrice, fmtPct, fmtAgo, fmtTime, startOfDayUtc } from "./format.js";
import { TAKE_KB, rTxt } from "./texts.js";
import {
  logEvent, closedBetween, digest, signalCard, monthReport,
  exportMonthCsv, exportMonthLog,
} from "./journal.js";
import * as CMD from "./commands.js";

const VER = codeVersion();
let STRATEGIES = [];

// --- состояние рынка --------------------------------------------------------
async function marketSnapshot() {
  const top = await topPairs();
  setSetting("last_market_seen", now());
  setSetting("universe_size", top.length);
  return top;
}

// --- такты ------------------------------------------------------------------
async function onSignal(sig) {
  await broadcast(signalCard(sig), TAKE_KB(sig.id));
  log(`сигнал #${sig.id}: ${sig.side} ${sig.symbol} @ ${sig.entry}`);
}

/**
 * Повторный сигнал по монете, которая уже в работе.
 *
 * Прислать его как обычную карточку — значит позвать перезайти в то,
 * где ты уже стоишь. Поэтому вместо приглашения идёт правка к открытой
 * сделке: подтверждение с новым стопом или предупреждение о развороте.
 * Одно сообщение на бар — ключ гашения содержит время бара.
 */

async function onUpdate(f, pos) {
  const same = f.side === pos.side;
  const key = `${same ? "confirm" : "against"}@${f.strategy}@${f.barTime}`;
  if (!alertOnce(pos.id, "info", key, "")) return false;

  const long = pos.side === "long";
  const px = await lastPrice(pos.symbol).catch(() => null) ?? f.entry;
  const head =
    `<b>${esc(pos.symbol)}</b> ${long ? "LONG" : "SHORT"} · в работе ${fmtAgo(now() - pos.opened_at)}\n` +
    `Вход ${fmtPrice(pos.entry)} · стоп ${fmtPrice(pos.sl_current)} · ` +
    `целей взято ${pos.tp_hit}/5 · сейчас <b>${rTxt(rAt(pos, px))}</b>`;

  if (!same) {
    logEvent({ kind: "note", symbol: pos.symbol,
               text: `встречный сигнал ${f.strategy} против открытой сделки` });
    await broadcast(
      `⚠️ <b>Встречный сигнал</b> · ${esc(f.strategy)}\n${head}\n\n` +
      `Стратегия развернулась и даёт вход в другую сторону.\n` +
      `<i>${esc(f.reason)}</i>\n\n` +
      `Перезаходить не нужно — это повод решить по открытой сделке.`,
      [[{ text: "🚪 Закрыть сейчас", callback_data: `close:${pos.id}` },
        { text: "🤝 Держу", callback_data: "noop" }]]);
    return true;
  }

  // Стоп двигаем только к цене: это уменьшает риск. Уводить его дальше
  // ради «запаса» — как раз то, чем сливают.
  const better = long ? f.sl > pos.sl_current : f.sl < pos.sl_current;
  const safe = long ? f.sl < px : f.sl > px;
  const kb = better && safe
    ? [[{ text: `🛡 Стоп → ${fmtPrice(f.sl)}`, callback_data: `tsl:${pos.id}:${f.sl}` },
        { text: "🤝 Оставить", callback_data: "noop" }]]
    : null;

  await broadcast(
    `🔄 <b>Сигнал повторился</b> · ${esc(f.strategy)}\n${head}\n\n` +
    `Стратегия снова даёт вход: ${fmtPrice(f.entry)}, стоп ${fmtPrice(f.sl)}.\n` +
    `<i>${esc(f.reason)}</i>\n\n` +
    (better && safe
      ? `Стоп можно подтянуть — риск станет меньше на ` +
        `${(Math.abs(f.sl - pos.sl_current) / Math.abs(pos.entry - pos.sl) * 100).toFixed(0)}% от исходного.`
      : `Стоп трогать незачем, текущий лучше. Просто подтверждение.`) +
    `\n<b>Перезаходить не нужно.</b>`, kb);
  return true;
}

/**
 * Первый этап сигнала: монета взята на прицел, входа ещё нет.
 * Шлём по одному разу на монету в сутки — это контекст, а не команда.
 */
async function onWatching(list) {
  if (!list?.length) return 0;
  let sent = 0;
  for (const w of list) {
    const key = `watch:${w.symbol}:${w.strategy}`;
    const was = Number(getSetting(key, 0));
    if (now() - was < 24 * 3600) continue;
    setSetting(key, now());
    const openNow = openPositions().some(p => p.symbol === w.symbol);
    if (openNow) continue;                       // по этой монете уже стоим
    await broadcast(
      `👀 <b>Взял на прицел</b> · ${esc(w.strategy)}\n` +
      `<b>${esc(w.symbol)}</b> · сейчас ${fmtPrice(w.price)} · ` +
      `${new Date((w.barTime + num("tz") * 3600) * 1000).toISOString().slice(11, 16)} (UTC+${num("tz")})\n` +
      `Ставка финансирования <b>${w.rate.toFixed(3)}%</b> — рынок доплачивает ` +
      `за лонги, это признак живого импульса.\n` +
      `Жду подтверждения: цена должна пробить <b>${fmtPrice(w.need)}</b> ` +
      `(${w.awayPct.toFixed(1)}% отсюда).\n` +
      `<i>Это ещё не сигнал. Войду и напишу, когда цена подтвердит.</i>`);
    sent++;
    if (sent >= 5) break;                        // не заливаем чат
  }
  return sent;
}

/**
 * Сканер отстающих. Работает поверх стратегий: ищет не сигнал в одной
 * монете, а пару «лидер и повторяющий его с задержкой».
 */
async function leadLagTick(symbols) {
  if (num("leadlag_on") !== 1) return 0;
  let found;
  try { found = await leadLag(symbols); }
  catch (e) { log("сканер отстающих сорвался:", e.message); return 0; }

  let sent = 0;
  for (const f of found) {
    // Та же связка не повторяется, пока не пройдёт остыв.
    const key = `ll:${f.leader}:${f.symbol}`;
    if (now() - Number(getSetting(key, 0)) < 8 * 3600) continue;
    if (openPositions().some(p => p.symbol === f.symbol)) continue;
    setSetting(key, now());

    const name = `Отстающий за ${f.leader.replace("USDT", "")}`;
    const reason =
      `${f.leader.replace("USDT", "")} прошёл ${f.leaderMove > 0 ? "+" : ""}` +
      `${f.leaderMove.toFixed(1)}% за 2 часа · график совпадает на ` +
      `${(f.corr * 100).toFixed(0)}% со сдвигом ${f.lagMin} мин · ` +
      `сама пока ${f.ownMove > 0 ? "+" : ""}${f.ownMove.toFixed(1)}%`;

    const r = db.prepare(
      "INSERT OR IGNORE INTO signals(strategy,symbol,side,tf,entry,sl,targets," +
      "reason,created_at,bar_time,status) VALUES(?,?,?,'15m',?,?,?,?,?,?,'new')"
    ).run(name, f.symbol, f.side, f.entry, f.sl, JSON.stringify(f.targets),
          reason, now(), f.barTime);
    if (!r.changes) continue;
    const id = Number(r.lastInsertRowid);
    logEvent({ kind: "signal", strategy: "Отстающий", symbol: f.symbol,
               side: f.side, price: f.entry, text: reason });
    await broadcast(signalCard({
      id, symbol: f.symbol, side: f.side, tf: "15m", strategy: name,
      entry: f.entry, sl: f.sl, targets: f.targets, reason,
    }), TAKE_KB(id));
    sent++;
    if (sent >= 3) break;                 // не заливаем чат
  }
  return sent;
}

async function scanTick() {
  const t0 = Date.now();
  const r = await scanMarket(STRATEGIES, onSignal, onUpdate);
  setSetting("last_market_seen", now());
  setSetting("universe_size", r.pairs);
  const watched = await onWatching(r.watching).catch(() => 0);
  const lag = await leadLagTick(r.symbols ?? []).catch(() => 0);
  log(`скан: ${r.pairs} пар, кандидатов ${r.candidates}, отбор снял ${r.gated ?? 0}, выдано ${r.signals}, ` +
      `правок по открытым ${r.updates ?? 0}, на прицеле ${watched}, ` +
      `отстающих ${lag}, ${((Date.now() - t0) / 1000).toFixed(1)}с`);
}

/** Пульс: короткая сводка по рынку, живёт своим интервалом. */
async function pulseTick() {
  const top = await topPairs(3);
  const pos = openPositions().length;
  await broadcast(
    `📊 ${top.map(x => `${x.symbol.replace("USDT","")} ${fmtPrice(x.close)} (${fmtPct(x.change)})`).join(" · ")}` +
    `\n<i>вселенная ${getSetting("universe_size","—")} пар · в работе ${pos}</i>`);
}

/**
 * Среднедневной размах монеты, в процентах. Кешируется на шесть часов:
 * величина медленная, а дёргать биржу на каждом такте незачем.
 */
const dayVol = new Map();
async function dailyVol(symbol) {
  const hit = dayVol.get(symbol);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.v;
  let v = null;
  try {
    const d = await deepHistory(symbol, "1d", 40);
    if (d.length >= 10) {
      const s = d.slice(-30);
      v = s.reduce((a, c) => a + (c.h - c.l) / c.c, 0) / s.length * 100;
    }
  } catch { /* без волатильности возьмём запасной порог */ }
  dayVol.set(symbol, { at: Date.now(), v });
  return v;
}

async function zoneTick() {
  const syms = ZN.symbols();
  if (!syms.length) return;
  let px;
  try { px = await prices(syms); } catch { return; }

  // Порог подхода — доля среднедневного размаха монеты, а не общий
  // процент: иначе резвую монету бот заливает сообщениями, а по
  // спокойной опаздывает.
  // Считаем по всем монетам разом: по очереди это столько ожиданий
  // сети, сколько монет, и первый такт после запуска растягивается.
  const vol = {};
  await mapLimit(syms, 6, async (s) => {
    const v = await dailyVol(s).catch(() => null);
    if (v) vol[s] = v;
  });
  const far = num("zone_far_share") / 100, near = num("zone_near_share") / 100;

  // Присмотр идёт и в фокусе, когда скан не работает, — списки для
  // отсева здесь свои, а не унаследованные от такта сканирования.
  await tradableReady();

  // Собираем события по монете: три уровня по одной монете не должны
  // приходить тремя сообщениями подряд.
  const events = ZN.check(px, { vol, farShare: far, nearShare: near })
    .filter(ev => {
      // Зона могла быть заведена до того, как пара лишилась фьючерса.
      const why = rejectReason(ev.zone.symbol);
      if (why) { log(`зона ${ev.zone.symbol} пропущена: ${why}`); return false; }
      return true;
    });

  // Подходы к зонам — одним сообщением на монету. Входы разбираем по
  // отдельности: там сигнал со своими кнопками.
  const nears = new Map();
  for (const ev of events) {
    if (ev.kind !== "near" && ev.kind !== "close") continue;
    const k = ev.zone.symbol;
    if (!nears.has(k)) nears.set(k, []);
    nears.get(k).push(ev);
  }
  for (const [sym, list] of nears) {
    const soon = list.some(e => e.kind === "close");
    const lines = list
      .sort((a, b) => a.distPct - b.distPct)
      .map(e => {
        const z = e.zone, long = z.side === "long";
        const share = e.dayPct ? ` — ${(e.share * 100).toFixed(0)}% дневного хода` : "";
        return `${long ? "🟢" : "🔴"} ${fmtPrice(z.lo)}–${fmtPrice(z.hi)} · ` +
               `до границы ${e.distPct.toFixed(2)}%${share}` +
               `${z.armed ? "" : " · <i>не принята</i>"}`;
      });
    const day = list.find(e => e.dayPct)?.dayPct;
    await broadcast(
      `${soon ? "🟠" : "🟡"} <b>${soon ? "Цена вплотную к зоне" : "Цена подходит к зоне"}</b>\n` +
      `<b>${esc(sym)}</b> · ${fmtPrice(list[0].price)}` +
      `${day ? ` · дневной ход ${day.toFixed(1)}%` : ""}\n` +
      lines.join("\n"));
  }

  const openBySymbol = new Map(openPositions().map(p => [p.symbol, p]));
  for (const ev of events) {
    if (ev.kind !== "enter") continue;
    const z = ev.zone;
    const long = z.side === "long";
    // Монета уже в работе — зона не должна звать зайти второй раз.
    const held = openBySymbol.get(z.symbol);
    if (held) {
      if (alertOnce(held.id, "info", `zone@${z.id}`, "")) {
        const long = held.side === "long";
        const px = ev.price;          // цену уже взяли одним запросом выше
        await broadcast(
          `🎯 <b>Цена в зоне</b> ${fmtPrice(z.lo)}–${fmtPrice(z.hi)}\n` +
          `<b>${esc(z.symbol)}</b> ${long ? "LONG" : "SHORT"} · уже в работе · ` +
          `сейчас <b>${rTxt(rAt(held, px))}</b>\n` +
          `<i>${esc(z.note ?? "уровень")}</i>\n\n` +
          (z.side === held.side
            ? `Зона за тебя — уровень под сделкой. Перезаходить не нужно.`
            : `Зона против сделки: здесь цену обычно разворачивает.`));
      }
      continue;
    }

    // Непринятая зона — только пометка. Проверка на истории показала,
    // что построенный ботом уровень не лучше случайного, поэтому звать
    // в сделку по нему нельзя. Принятая человеком — другое дело.
    if (!z.armed) {
      await broadcast(
        `🟡 <b>Цена в предложенной зоне</b>\n` +
        `${esc(z.symbol)} · ${long ? "лонг" : "шорт"} ` +
        `${fmtPrice(z.lo)}–${fmtPrice(z.hi)} · сейчас ${fmtPrice(ev.price)}\n` +
        `<i>${esc(z.note ?? "уровень")}</i>\n\n` +
        `Зону я построил сам, ты её не подтверждал — сигналом не считаю.`,
        [[{ text: "✅ Принять зону", callback_data: `zok:${z.id}` },
          { text: "🗑 Убрать", callback_data: `zdel:${z.id}` }]]);
      continue;
    }

    // Цена вошла в зону — это уже сигнал.
    let a = null;
    try {
      const c = await candles(z.symbol, "1h", 300);
      a = atr(c, 14).at(-2);
    } catch { /* посчитаем от ширины зоны */ }
    const t = ZN.tradeFrom(z, ev.price, a);

    const r = db.prepare(
      "INSERT OR IGNORE INTO signals(strategy,symbol,side,tf,entry,sl,targets," +
      "reason,created_at,bar_time,status) VALUES(?,?,?,'1h',?,?,?,?,?,?,'new')"
    ).run(`Зона ${fmtPrice(z.lo)}–${fmtPrice(z.hi)}`, z.symbol, z.side,
          t.entry, t.sl, JSON.stringify(t.targets),
          `Цена вошла в зону · ${z.note ?? "уровень"}`, now(), Math.floor(now() / 3600) * 3600);
    if (!r.changes) continue;
    const id = Number(r.lastInsertRowid);
    logEvent({ kind: "signal", strategy: "Зона", symbol: z.symbol,
               side: z.side, price: ev.price, text: "вход в зону" });
    await broadcast(signalCard({
      id, symbol: z.symbol, side: z.side, tf: "1h",
      strategy: `Зона ${fmtPrice(z.lo)}–${fmtPrice(z.hi)}`,
      entry: t.entry, sl: t.sl, targets: t.targets,
      reason: `Цена вошла в зону ${fmtPrice(z.lo)}–${fmtPrice(z.hi)}\n${z.note ?? ""}`,
    }), TAKE_KB(id));
    log(`зона сработала: ${z.symbol} ${z.side} @ ${ev.price}`);
  }
}

async function watchTick({ focus }) {
  const r = await monitorTick({ strategies: STRATEGIES, focus, notify: postUpdate });
  await zoneTick().catch(e => log("зоны не проверились:", e.message));
  setSetting("last_market_seen", now());
  if (r.events)
    log(`присмотр${focus ? " (фокус)" : ""}: ${r.checked} позиций, событий ${r.events}`);
}

/**
 * Событие по сделке — ответом на карточку сигнала. Так в чате
 * складывается нитка по каждой позиции, а не лента вперемешку.
 */
export async function postUpdate(positionId, text, keyboard = null) {
  const p = db.prepare("SELECT * FROM positions WHERE id = ?").get(positionId);
  if (!p) return null;
  return send(p.chat_id, text, keyboard, p.msg_id || null);
}

// --- отчёты -----------------------------------------------------------------
/**
 * Напоминание, поставленное 30 августа: у Zone-Retest есть намёк на
 * встроенное условие «входить только на ноже» (финал 15 минут против
 * сделки). Счёт наблюдения 2:0 в его пользу (+0,116R на 37 сигналах
 * бэктеста, +0,323R на 5 сигналах живой недели), но 42 сделок мало.
 * Порог пересчёта — 300 сигналов стратегии; бот сам скажет, когда
 * накопится. Подробности — СТРАТЕГИИ.md, раздел 5ж.
 */
async function knifeReminder() {
  if (getSetting("knife_done", "0") === "1") return;
  const startRaw = getSetting("knife_start", "");
  if (!startRaw) { setSetting("knife_start", String(now())); return; }
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM signals WHERE strategy LIKE '%Zone-Retest%' AND created_at >= ?"
  ).get(Number(startRaw)).n;
  if (n < 300) return;
  setSetting("knife_done", "1");
  await broadcast(
    `🔪 <b>Пора пересчитать «только нож»</b>\n\n` +
    `Накопилось ${n} сигналов Zone-Retest с 15-минутками — порог из ` +
    `СТРАТЕГИИ.md (раздел 5ж) достигнут.\n\n` +
    `Напомни в чате Claude: «пересчитай условие только нож для ` +
    `Zone-Retest». Если счёт наблюдения останется в его пользу — ` +
    `условие станет встроенным, как контртренд-фильтр.`);
  log(`напоминание про «только нож» отправлено: ${n} сигналов`);
}

/**
 * Напоминание, поставленное 30 августа: минутный сонар пишется в каждый
 * сигнал, и на нём предстоит калибровать условие «тихого финала».
 * Проба на одной неделе (СТРАТЕГИИ.md, раздел 5з) дала согласный с
 * теорией намёк — vol15 ≤ 1,5 и m1 ≤ 0,1 прибавляли в обеих половинах
 * недели, — но одна неделя с одним рыночным режимом порогом не
 * становится. Порог пересчёта — 300 сигналов с записанным сонаром.
 */
async function sonarReminder() {
  if (getSetting("sonar_done", "0") === "1") return;
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM signals WHERE sonar IS NOT NULL"
  ).get().n;
  if (n < 300) return;
  setSetting("sonar_done", "1");
  await broadcast(
    `📡 <b>Пора калибровать минутный сонар</b>\n\n` +
    `Накопилось ${n} сигналов с записанным минутным слепком — порог из ` +
    `СТРАТЕГИИ.md (раздел 5з) достигнут.\n\n` +
    `Напомни в чате Claude: «откалибруй условие тихого финала по ` +
    `колонке sonar». Кандидаты с пробной недели: vol15 ≤ 1,5, m1 ≤ 0,1 — ` +
    `проверить на срезах и с контролем случайным входом.`);
  log(`напоминание про сонар отправлено: ${n} сигналов`);
}

async function onDaily(day) {
  await knifeReminder().catch(e => log("напоминание не проверилось:", e.message));
  await sonarReminder().catch(e => log("напоминание не проверилось:", e.message));
  const rows = closedBetween(startOfDayUtc(now()), now());
  if (!rows.length) return;                 // молчим, когда закрывать было нечего
  await broadcast(digest(rows, `Итоги дня ${day}`));
  log(`дневная сводка: ${rows.length} закрытых`);
}

async function onMonthly(m) {
  await broadcast(monthReport(m));
  // После первого сообщения бросать нельзя: планировщик ставит отметку
  // «отправлено» после onMonthly, и ошибка здесь заставила бы слать
  // итог заново каждую минуту. Файлы — довесок, без них не страшно.
  try {
    const csv = exportMonthCsv(m);
    const lg = exportMonthLog(m);
    if (csv.count) {
      await broadcastDoc(csv.path,
        `<b>${m}</b> — ${csv.count} сделок. Колонки как в базе Golden, можно подклеивать.`);
      await broadcastDoc(lg.path, `Полная лента событий за ${m}: ${lg.count} записей.`);
    }
    log(`месячный итог ${m}: ${csv.count} сделок`);
  } catch (e) { log("выгрузки месяца не собрались:", e.message); }
}

// --- запуск -----------------------------------------------------------------
async function main() {
  // Версию печатаем до всякой сети: если связи нет, знать её важнее всего.
  log(`версия кода ${VER.hash} от ${VER.date}`);

  // Вторая копия не должна дожить до отправки сообщений.
  if (!acquireLock()) process.exit(0);
  const me = await api("getMe");
  const o = CMD.ownerId();
  log(`бот @${me.username} на связи · админ: ${o ?? "будет закреплён первым /start"}`);

  // Честный доклад о простое: пока компьютер спал, рынок никто не смотрел.
  const seen = Number(getSetting("last_market_seen", "0"));
  const gap = seen ? now() - seen : 0;
  const pos = openPositions();
  if (gap > 20 * 60 && pos.length) {
    await broadcast(
      `⏰ <b>Меня не было ${fmtAgo(gap)}</b> — с ${fmtTime(seen)}.\n` +
      `Открытых сделок: ${pos.length}. Проверяю, что с ними произошло.`);
  } else if (gap > 60 * 60) {
    await broadcast(`⏰ Снова на связи. Меня не было ${fmtAgo(gap)}.`);
  }

  // Telegram требует латиницу в именах команд; описания могут быть русскими.
  await api("setMyCommands", { commands: [
    { command: "status", description: "режим и открытые сделки" },
    { command: "focus",  description: "следить только за взятыми сделками" },
    { command: "scan",   description: "искать новые точки входа" },
    { command: "pulse",  description: "включить/выключить сводку по рынку" },
    { command: "settings", description: "интервалы, монеты, риск, отчёты" },
    { command: "coins",  description: "мой список монет" },
    { command: "add",    description: "добавить монету с разбором истории" },
    { command: "tune",   description: "заново подобрать параметры под монету" },
    { command: "zones",  description: "зоны интереса, за которыми слежу" },
    { command: "levels", description: "загрузить уровни из канала" },
    { command: "charts", description: "разборы с графиками из канала" },
    { command: "positions", description: "открытые сделки" },
    { command: "results", description: "итоги сигналов за сегодня" },
    { command: "log",    description: "итоги месяца и выгрузка файлами" },
    { command: "stats",  description: "статистика за всё время" },
    { command: "users",  description: "кто имеет доступ (только админ)" },
    { command: "help",   description: "список команд" },
  ]});

  STRATEGIES = await loadStrategies();
  // Отбору нужно знать, есть ли кому соглашаться.
  setStrategyCount(STRATEGIES.length);
  // Обработчики команд живут отдельно и получают отсюда две вещи:
  // список стратегий и способ ответить в нитку сделки. Импортировать
  // их оттуда напрямую нельзя — вышло бы кольцо.
  CMD.init({ strategies: STRATEGIES, postUpdate });

  // Владелец известен из .env — заводим его сразу, чтобы сигналы уходили
  // ещё до первого /start.
  const owner = CMD.ownerId();
  if (owner) {
    upsertUser(owner, null, null, "owner");
    setRole(owner, "owner");
  }

  // Скан сразу при запуске, не дожидаясь следующей четверти часа:
  // компьютер могли включить в 10:01, ждать до 10:15 незачем.
  // Повторные сигналы не продублируются — ключ по времени бара.
  await scanTick().catch(e => log("первый скан не удался:", e.message));
  logEvent({ kind: "note", text: `бот запущен, стратегий ${STRATEGIES.length}` });
  startLoops({ scanTick, watchTick, pulseTick });
  startReports({ onDaily, onMonthly });
  await startPolling({ onMessage: CMD.onMessage, onCallback: CMD.onCallback });
}

/**
 * Отказ обещания, который никто не поймал, в Node 22 по умолчанию
 * валит процесс. Сторож поднимет бота заново, но присмотр за сделками
 * прервётся из-за сбоя где-нибудь в отправке картинки — цена
 * несоразмерна. Поэтому пишем в лог и работаем дальше.
 *
 * С исключением иначе: после него состояние неизвестно, и продолжать
 * опаснее, чем перезапуститься. Выходим с ненулевым кодом — сторож
 * поднимет, а в логе останется запись, почему.
 */
process.on("unhandledRejection", (e) => {
  log("необработанный отказ:", e?.stack ?? e?.message ?? String(e));
});
process.on("uncaughtException", (e) => {
  log("необработанное исключение, перезапускаюсь:", e?.stack ?? String(e));
  try { db.close(); } catch { /* уже закрыта */ }
  process.exit(1);
});

process.on("SIGINT", () => { log("остановка"); db.close(); process.exit(0); });
main().catch(e => { log("фатально:", e.message); process.exit(1); });
