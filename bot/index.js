import { cfg, log, codeVersion } from "./config.js";
import {
  db, now, getSetting, setSetting, upsertUser, openPositions,
  getUser, setRole, listUsers, getMode, setMode, MODE_SCAN, MODE_FOCUS,
} from "./db.js";
import { api, send, sendLong, sendDoc, broadcast, broadcastDoc, editText,
         answerCallback, startPolling, esc } from "./telegram.js";
import { topPairs } from "./data/tradingview.js";
import { prices, lastPrice } from "./data/mexc.js";
import { monitorTick, closePosition, rAt } from "./monitor.js";
import { PARAMS, GROUPS, paramsOf, num, setNum, fmtVal, reportHourUtc } from "./runtime.js";
import * as WL from "./watchlist.js";
import { checkAll, renderHealth } from "./health.js";
import { cacheSize } from "./candles.js";
import { loadStrategies } from "./strategies/index.js";
import { scanMarket } from "./engine.js";
import { startLoops, startReports } from "./scheduler.js";
import { fmtPrice, fmtPct, fmtUsd, fmtAgo, fmtTime } from "./format.js";
import {
  logEvent, monthKey, closedBetween, closedInMonth, digest, stats, signalCard, plural,
  goldenTime,
  summaryLine, monthReport, exportMonthCsv, exportMonthLog, availableMonths,
} from "./journal.js";

const STARTED = now();
const VER = codeVersion();
let STRATEGIES = [];

const TAKE_KB = (id) => [[
  { text: "✅ Взял", callback_data: `take:${id}` },
  { text: "🚫 Пропустил", callback_data: `skip:${id}` },
]];

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

async function scanTick() {
  const t0 = Date.now();
  const r = await scanMarket(STRATEGIES, onSignal);
  setSetting("last_market_seen", now());
  setSetting("universe_size", r.pairs);
  log(`скан: ${r.pairs} пар, кандидатов ${r.candidates}, выдано ${r.signals}, ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}с`);

}

/** Пульс: короткая сводка по рынку, живёт своим интервалом. */
async function pulseTick() {
  const top = await topPairs(3);
  const pos = openPositions().length;
  await broadcast(
    `📊 ${top.map(x => `${x.symbol.replace("USDT","")} ${fmtPrice(x.close)} (${fmtPct(x.change)})`).join(" · ")}` +
    `\n<i>вселенная ${getSetting("universe_size","—")} пар · в работе ${pos}</i>`);
}

async function watchTick({ focus }) {
  const r = await monitorTick({ strategies: STRATEGIES, focus, notify: postUpdate });
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

// --- настройки ------------------------------------------------------------
const HINT = {
  рынок: "Чем ниже порог оборота, тем больше пар и тем хуже исполнение: " +
         "на неликвиде проскальзывание съедает выигрыш. Монеты из /coins " +
         "сканируются всегда, независимо от оборота.",
  сделки: "Чем раньше стоп уходит в безубыток, тем меньше убыточных сделок " +
          "и тем меньше прибыль. Каждые пять процентов убыточных стоят " +
          "примерно пятую часть дохода.",
  ритм: "Правка применяется со следующего такта, перезапускать не нужно.",
};

function settingsView(g) {
  const rows = paramsOf(g).map(k => `<b>${PARAMS[k].title}:</b> ${fmtVal(k)}`);
  const extra = g === "отчёты"
    ? `Дневной отчёт уходит в ${String(reportHourUtc()).padStart(2, "0")}:00 UTC.`
    : "";
  return [`⚙️ <b>${GROUPS[g]}</b>`, "", ...rows, "",
          `<i>${extra} ${HINT[g] ?? ""}</i>`].join("\n");
}

function optLabel(key, v) {
  if (key === "tz") return `+${v}`;
  if (key === "report_hour") return `${v}:00`;
  if (key === "only_list") return v ? "только список" : "оборот + список";
  if (key === "be_at") return v >= 50 ? "на цели" : `${(v / 100).toFixed(2)}R`;
  return v === 0 ? "выкл" : `${v}`;
}

function settingsKeyboard(g) {
  const kb = [];
  for (const key of paramsOf(g)) {
    const p = PARAMS[key], cur = num(key);
    kb.push([{ text: `— ${p.title} —`, callback_data: "noop" }]);
    kb.push(p.opts.map(v => ({
      text: (v === cur ? "• " : "") + optLabel(key, v),
      callback_data: `cfg:${key}:${v}:${g}`,
    })));
  }
  kb.push(Object.keys(GROUPS).map(k => ({
    text: (k === g ? "· " : "") + GROUPS[k].split(" ")[0],
    callback_data: `sec:${k}`,
  })));
  return kb;
}

// --- отчёты -----------------------------------------------------------------
const startOfDayUtc = (ts = now()) =>
  Math.floor(Date.parse(new Date(ts * 1000).toISOString().slice(0, 10)) / 1000);

async function onDaily(day) {
  const rows = closedBetween(startOfDayUtc(), now());
  if (!rows.length) return;                 // молчим, когда закрывать было нечего
  await broadcast(digest(rows, `Итоги дня ${day}`));
  log(`дневная сводка: ${rows.length} закрытых`);
}

async function onMonthly(m) {
  await broadcast(monthReport(m));
  const csv = exportMonthCsv(m);
  const lg = exportMonthLog(m);
  if (csv.count) {
    await broadcastDoc(csv.path,
      `<b>${m}</b> — ${csv.count} сделок. Колонки как в базе Golden, можно подклеивать.`);
    await broadcastDoc(lg.path, `Полная лента событий за ${m}: ${lg.count} записей.`);
  }
  log(`месячный итог ${m}: ${csv.count} сделок`);
}

// --- список монет ---------------------------------------------------------
const sig = (n) => `${n} ${plural(n, ["сигнал", "сигнала", "сигналов"])}`;
const prof = (n) => `${n} ${plural(n, ["прибыльный", "прибыльных", "прибыльных"])}`;

function analysisText(symbol, res) {
  const good = res.filter(r => !r.short);
  const lines = res.map(r => {
    if (r.short)
      return `▫️ <b>${r.id}</b>\n   <i>мало истории — ${r.days.toFixed(0)} дн, ` +
             `${r.bars ?? 0} свечей</i>`;
    const pct = r.n ? Math.round(r.win / r.n * 100) : 0;
    const mark = r.n === 0 ? "▫️" : r.avgR > 0 ? "✅" : "🔻";
    return `${mark} <b>${r.id}</b>\n` +
      `   ${sig(r.n)} · ${prof(r.win)} (${pct}%) · стопов ${r.stops}\n` +
      `   <i>ср. ${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}R · ${r.perWeek.toFixed(1)} в неделю</i>`;
  });
  const tot = good.reduce((a, r) => a + r.n, 0);
  const totWin = good.reduce((a, r) => a + r.win, 0);
  const days = good.length ? Math.round(Math.max(...good.map(r => r.days))) : 0;
  return [
    `🔎 <b>${symbol}</b> · разбор за ${days} дн`, "",
    ...lines, "",
    tot ? `<b>Итого ${sig(tot)}, ${prof(totWin)} (${Math.round(totWin / tot * 100)}%)</b>`
        : "<b>Сигналов за период не было</b>",
  ].join("\n");
}

// --- команды ----------------------------------------------------------------
const HELP = `<b>Что я умею</b>

/status — режим, что вижу на рынке, открытые сделки
/focus — бросить всё и следить только за взятыми сделками
/scan — вернуться к поиску новых монет
/pulse — включить/выключить сводку по рынку
/settings — интервалы, монеты, риск, отчёты (четыре раздела)
/coins — мой список монет
/add ZECUSDT — разобрать историю за полгода и добавить
/del ZECUSDT — убрать из списка

/positions — открытые сделки, текущий результат, закрыть вручную

<b>Журнал</b>
/results — итоги закрытых сигналов за сегодня
/log — итоги месяца плюс выгрузка файлами
/stats — статистика за всё время
/users — кто имеет доступ, выдать или отозвать
/help — это сообщение

<i>Telegram понимает только латиницу в командах, но я отзываюсь и на русские:
/статус /фокус /скан /пульс /настройки /монеты /сделки /итоги /журнал /стата /доступ /помощь</i>

<i>Сигналы приходят карточкой с кнопками «Взял» и «Пропустил».
По взятой сделке вся история — ниткой ответов под карточкой:
цели, перенос стопа в безубыток, слом стратегии, закрытие.</i>`;

async function statusText(withHealth = true) {
  const mode = getMode();
  const pos = openPositions();
  const seen = Number(getSetting("last_market_seen", "0"));
  const uni = getSetting("universe_size", "—");

  const lines = [
    `<b>Режим:</b> ${mode === MODE_FOCUS ? "🎯 фокус на сделках" : "🔍 скан рынка"}`,
    `<b>Рынок видел:</b> ${seen ? fmtAgo(now() - seen) + " назад" : "ещё нет"}`,
    `<b>Вселенная:</b> ${uni} пар MEXC/USDT дороже ${fmtUsd(cfg.minTurnoverUsd)} $ оборота`,
    `<b>Стратегий:</b> ${STRATEGIES.length ? STRATEGIES.map(s => s.id).join(", ") : "нет"}`,
    `<b>Открытых сделок:</b> ${pos.length}`,
    `<b>Работаю без перерыва:</b> ${fmtAgo(now() - STARTED)}`,
    `<b>Версия кода:</b> ${VER.hash} от ${VER.date}`,
    `<b>Скан:</b> ${fmtVal("scan_min")} · <b>пульс:</b> ${fmtVal("pulse_min")}`,
  ];
  if (pos.length) {
    lines.push("", "<b>В работе:</b>");
    for (const p of pos) {
      lines.push(`• ${p.side === "long" ? "📈" : "📉"} ${esc(p.symbol)} от ${fmtPrice(p.entry)} · ${esc(p.strategy)}`);
    }
  }

  if (withHealth) {
    lines.push("", "<b>Связь:</b>");
    lines.push(renderHealth(await checkAll()));
    lines.push(`<i>свечей в кеше: ${cacheSize()} пар</i>`);
  }
  return lines.join("\n");
}

/**
 * Закрытый доступ с заявками.
 *
 * Бот виден в поиске Telegram — спрятать его нельзя. Поэтому: владелец
 * работает сразу, любой другой получает «приватный бот», а владельцу
 * уходит заявка с кнопками. Без явного «Разрешить» чужой не увидит
 * ни одного сигнала.
 */
function ownerId() {
  const fromEnv = cfg.ownerId;
  if (fromEnv) return fromEnv;
  const stored = Number(getSetting("owner_id", "0"));
  return stored || null;
}

const ACCESS_KB = (id) => [[
  { text: "✅ Разрешить", callback_data: `grant:${id}` },
  { text: "🚫 Отказать", callback_data: `deny:${id}` },
]];

/** true — можно работать; иначе всё уже обработано (отказ или заявка). */
async function guard(msg, isStart) {
  const chatId = msg.chat.id;
  const o = ownerId();

  // Первый /start закрепляет владельца, если он не задан в .env.
  if (!o) {
    if (!isStart) return false;
    setSetting("owner_id", chatId);
    upsertUser(chatId, msg.from?.username, msg.from?.first_name, "owner");
    log(`владелец закреплён: ${chatId}`);
    return true;
  }
  if (chatId === o) {
    upsertUser(chatId, msg.from?.username, msg.from?.first_name, "owner");
    setRole(chatId, "owner");
    return true;
  }

  const u = getUser(chatId);
  if (u?.role === "approved") return true;

  if (u?.role === "denied") {
    await send(chatId, "Этот бот приватный.");
    return false;
  }

  if (u?.role === "pending") {                  // заявка уже висит
    await send(chatId, "Запрос отправлен администратору. Ожидай решения.");
    return false;
  }

  // Новая заявка — одна на человека, владельцу с кнопками.
  upsertUser(chatId, msg.from?.username, msg.from?.first_name, "pending");
  const who = msg.from?.username ? "@" + esc(msg.from.username) : esc(msg.from?.first_name || "без имени");
  log(`заявка на доступ: ${chatId} ${who}`);
  logEvent({ kind: "note", text: `заявка на доступ: ${chatId} ${who}` });
  await send(o,
    `🔐 <b>Запрос доступа</b>\n\n${who}\nid <code>${chatId}</code>\n\n` +
    `<i>Без твоего разрешения он не получит ни одного сигнала.</i>`,
    ACCESS_KB(chatId));
  await send(chatId, "Запрос отправлен администратору. Ожидай решения.");
  return false;
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");

  if (!await guard(msg, cmd === "/start")) return;

  if (cmd === "/start") {
    upsertUser(chatId, msg.from?.username, msg.from?.first_name,
               chatId === ownerId() ? "owner" : "approved");
    await send(chatId,
      `Готов работать.\n\nЯ ищу точки входа по фьючерсам MEXC, показываю сигналы и слежу за теми, что ты взял в работу. Когда стратегия ломается — предупреждаю до стопа.\n\n${HELP}`);
    return;
  }
  switch (cmd) {
    case "/help": case "/помощь":
      await send(chatId, HELP); break;

    case "/status": case "/статус":
      await send(chatId, await statusText()); break;

    case "/focus": case "/фокус": {
      setMode(MODE_FOCUS);
      const n = openPositions().length;
      await send(chatId,
        `🎯 <b>Фокус включён.</b>\n\nПоиск новых монет остановлен. Все силы на ${n} ${n === 1 ? "сделку" : "сделки"} — проверка каждые ${cfg.focusIntervalSec} секунд вместо ${cfg.scanIntervalMin} минут.\n\n<i>Вернуться: /scan</i>`);
      break;
    }
    case "/scan": case "/скан":
      setMode(MODE_SCAN);
      await send(chatId, `🔍 <b>Скан включён.</b>\n\nСнова ищу точки входа по всему рынку. Взятые сделки по-прежнему под присмотром, но проверяются раз в ${cfg.normalWatchMin} минут.`);
      break;

    case "/pulse": case "/пульс": {
      const on = num("pulse_min") > 0;
      setNum("pulse_min", on ? 0 : 60);
      await send(chatId, on
        ? "Пульс выключен. Точная настройка — /settings"
        : "Пульс включён, раз в 60 минут. Изменить — /settings");
      break;
    }

    case "/settings": case "/настройки":
      await send(chatId, settingsView("ритм"), settingsKeyboard("ритм"));
      break;
    case "/positions": case "/сделки": {
      const ps = openPositions();
      if (!ps.length) { await send(chatId, "Открытых сделок нет."); break; }
      const px = await prices([...new Set(ps.map(p => p.symbol))]).catch(() => ({}));
      for (const p of ps) {
        const cur = px[p.symbol];
        const tg = JSON.parse(p.targets);
        const r = cur == null ? null : rAt(p, cur);
        await send(chatId, [
          `${p.side === "long" ? "📈" : "📉"} <b>${p.symbol}</b> ${p.side === "long" ? "LONG" : "SHORT"} · <i>${p.strategy}</i>`,
          `Вход ${fmtPrice(p.entry)} · стоп ${fmtPrice(p.sl_current)}` +
            (p.sl_current !== p.sl ? " <i>(безубыток)</i>" : ""),
          `Целей взято ${p.tp_hit} из ${tg.length}` +
            (p.tp_hit < tg.length ? ` · следующая ${fmtPrice(tg[p.tp_hit])}` : ""),
          cur == null ? "" : `Сейчас ${fmtPrice(cur)} · <b>${r > 0 ? "+" : ""}${r.toFixed(2)}R</b>`,
          `<i>открыта ${fmtAgo(now() - p.opened_at)} назад</i>`,
        ].filter(Boolean).join("\n"),
        [[{ text: "⚫️ Закрыть вручную", callback_data: `close:${p.id}` }]]);
      }
      break;
    }

    case "/coins": case "/монеты": {
      const rows = WL.list();
      if (!rows.length) {
        await send(chatId,
          "📋 <b>Мой список пуст</b>\n\n" +
          "Сейчас бот берёт пары автоматически, по обороту.\n\n" +
          "Добавить монету: <code>/add ZECUSDT</code>\n" +
          "Перед добавлением он разберёт её историю за полгода и покажет, " +
          "сколько сигналов дала каждая стратегия и сколько из них были прибыльными.");
        break;
      }
      await send(chatId,
        `📋 <b>Мой список — ${rows.length} ${plural(rows.length, ["монета","монеты","монет"])}</b>\n` +
        `<i>Источник пар: ${fmtVal("only_list")}</i>\n\n` +
        `Добавить: <code>/add SYMBOL</code> · убрать: <code>/del SYMBOL</code>`);
      for (const r of rows) {
        let st = "";
        try {
          const a = JSON.parse(r.stats || "[]").filter(z => !z.short);
          const n = a.reduce((s, z) => s + z.n, 0);
          const w = a.reduce((s, z) => s + z.win, 0);
          if (n) st = `\n<i>по истории: ${sig(n)}, ${prof(w)} (${Math.round(w/n*100)}%)</i>`;
        } catch { /* без статистики тоже сойдёт */ }
        await send(chatId, `<b>${esc(r.symbol)}</b>${st}`,
          [[{ text: "🗑 Убрать", callback_data: `wldel:${r.symbol}` }]]);
      }
      break;
    }

    case "/add": case "/добавить": {
      const sym = WL.normalize(text.split(/\s+/)[1]);
      if (!sym) { await send(chatId, "Так: <code>/add ZECUSDT</code> или просто <code>/add zec</code>"); break; }
      if (WL.has(sym)) { await send(chatId, `<b>${esc(sym)}</b> уже в списке.`); break; }
      const bad = await WL.check(sym);
      if (bad) { await send(chatId, `<b>${esc(sym)}</b> — ${bad}`); break; }

      const wait = await send(chatId, `🔎 Разбираю <b>${esc(sym)}</b> за полгода, это секунд десять…`);
      try {
        const res = await WL.analyze(sym, STRATEGIES, 6);
        if (WL.noHistory(res)) {
          const t = `<b>${esc(sym)}</b> — истории не хватает даже на прогрев ` +
                    `индикаторов. Монета слишком молодая или биржа не отдаёт свечи.`;
          if (wait) await editText(chatId, wait.message_id, t); else await send(chatId, t);
          break;
        }
        WL.add(sym, res);
        logEvent({ kind: "note", symbol: sym, text: "монета добавлена в список" });
        const txt = analysisText(sym, res) +
          `\n\n✅ <b>Добавлена в список</b> — теперь сканируется всегда.`;
        if (wait) await editText(chatId, wait.message_id, txt);
        else await sendLong(chatId, txt);
      } catch (e) {
        await send(chatId, `Не смог разобрать <b>${esc(sym)}</b>: ${esc(e.message)}`);
      }
      break;
    }

    case "/del": case "/убрать": {
      const sym = WL.normalize(text.split(/\s+/)[1]);
      if (!sym) { await send(chatId, "Так: <code>/del ZECUSDT</code>"); break; }
      await send(chatId, WL.remove(sym)
        ? `🗑 <b>${esc(sym)}</b> убрана из списка.`
        : `<b>${esc(sym)}</b> в списке не было.`);
      break;
    }

    case "/users": case "/доступ": {
      if (chatId !== ownerId()) { await send(chatId, "Команда только для администратора."); break; }
      const us = listUsers();
      if (us.length <= 1) { await send(chatId, "Кроме тебя доступ никто не запрашивал."); break; }
      const RU = { owner: "владелец", approved: "допущен", pending: "ждёт решения", denied: "отказано" };
      for (const u of us) {
        if (u.chat_id === chatId) continue;
        const who = u.username ? "@" + esc(u.username) : esc(u.first_name || "без имени");
        const kb = u.role === "approved"
          ? [[{ text: "🚫 Отозвать доступ", callback_data: `revoke:${u.chat_id}` }]]
          : u.role === "pending" ? ACCESS_KB(u.chat_id)
          : [[{ text: "✅ Разрешить", callback_data: `grant:${u.chat_id}` }]];
        await send(chatId, `${who} · <code>${u.chat_id}</code>\n<b>${RU[u.role] ?? u.role}</b>`, kb);
      }
      break;
    }

    case "/results": case "/итоги": {
      const rows = closedBetween(startOfDayUtc(), now());
      await sendLong(chatId, digest(rows, "Итоги за сегодня"));
      break;
    }

    case "/log": case "/журнал": {
      const arg = text.split(/\s+/)[1];
      const m = /^\d{4}-\d{2}$/.test(arg || "") ? arg : monthKey();
      await sendLong(chatId, monthReport(m));
      const csv = exportMonthCsv(m);
      if (csv.count) {
        await sendDoc(chatId, csv.path,
          `<b>${m}</b> — ${csv.count} сделок. Колонки как в базе Golden.`);
        const lg = exportMonthLog(m);
        await sendDoc(chatId, lg.path, `Лента событий: ${lg.count} записей.`);
      }
      const have = availableMonths();
      if (have.length > 1)
        await send(chatId, `Есть месяцы: ${have.join(" · ")}\nДругой: <code>/log 2026-07</code>`);
      break;
    }

    case "/stats": case "/стата": {
      const months = availableMonths();
      if (!months.length) { await send(chatId, "Журнал пока пуст."); break; }
      const all = months.flatMap(m => closedInMonth(m));
      const s = stats(all);
      const byM = months.map(m => {
        const st = stats(closedInMonth(m));
        return st.done
          ? `${m}: ${st.done} · ${(st.winrate*100).toFixed(0)}% · ${st.sumR>0?"+":""}${st.sumR.toFixed(2)}R`
          : `${m}: пусто`;
      });
      const strat = Object.entries(s.byStrategy).sort((a,b)=>b[1].r-a[1].r)
        .map(([k,v]) => `• ${k}: ${v.n} · ${(v.wins/v.n*100).toFixed(0)}% · ${v.r>0?"+":""}${v.r.toFixed(2)}R`);
      await sendLong(chatId, [
        "<b>За всё время</b>", "", summaryLine(s), "",
        "<b>По месяцам</b>", ...byM,
        ...(strat.length ? ["", "<b>По стратегиям</b>", ...strat] : []),
      ].join("\n"));
      break;
    }

    default:
      await send(chatId, "Не знаю такой команды. /помощь");
  }
}

async function onCallback(q) {
  const chatId = q.message?.chat?.id;
  const [act0] = String(q.data || "").split(":");

  if (act0 === "noop") { await answerCallback(q.id); return; }

  if (act0 === "sec") {
    const g = String(q.data).split(":")[1];
    if (!GROUPS[g]) { await answerCallback(q.id); return; }
    await answerCallback(q.id);
    await editText(chatId, q.message.message_id, settingsView(g), settingsKeyboard(g));
    return;
  }

  if (act0 === "cfg") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const [, key, raw, g] = String(q.data).split(":");
    if (!PARAMS[key]) { await answerCallback(q.id, "Неизвестный параметр"); return; }
    setNum(key, Number(raw));
    logEvent({ kind: "note", text: `настройка ${key} = ${raw}` });
    const grp = GROUPS[g] ? g : PARAMS[key].g;
    await answerCallback(q.id, `${PARAMS[key].title}: ${fmtVal(key)}`);
    await editText(chatId, q.message.message_id, settingsView(grp), settingsKeyboard(grp));
    return;
  }

  if (act0 === "wldel") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const sym = String(q.data).split(":")[1];
    WL.remove(sym);
    logEvent({ kind: "note", text: `монета убрана из списка: ${sym}` });
    await answerCallback(q.id, `${sym} убрана`);
    await editText(chatId, q.message.message_id, `🗑 <b>${esc(sym)}</b> убрана из списка`);
    return;
  }

  // Решения по доступу принимает только владелец.
  if (act0 === "grant" || act0 === "deny" || act0 === "revoke") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Не тебе решать"); return; }
    const target = Number(String(q.data).split(":")[1]);
    const u = getUser(target);
    const who = u?.username ? "@" + esc(u.username) : esc(u?.first_name || String(target));
    if (act0 === "grant") {
      setRole(target, "approved");
      logEvent({ kind: "note", text: `доступ разрешён: ${target}` });
      await answerCallback(q.id, "Разрешено");
      await editText(chatId, q.message.message_id,
        `🔐 ${who} — <b>доступ разрешён</b>\n<i>id ${target}. Отозвать: /users</i>`);
      await send(target, "Доступ открыт. Сигналы будут приходить сюда.\n\n/help — что я умею");
    } else {
      setRole(target, "denied");
      logEvent({ kind: "note", text: `доступ отклонён: ${target}` });
      await answerCallback(q.id, act0 === "deny" ? "Отказано" : "Отозвано");
      await editText(chatId, q.message.message_id,
        `🔐 ${who} — <b>доступ закрыт</b>\n<i>id ${target}</i>`);
      if (act0 === "revoke") await send(target, "Доступ закрыт администратором.");
    }
    return;
  }

  const me = getUser(chatId);
  if (chatId !== ownerId() && me?.role !== "approved") {
    await answerCallback(q.id, "Приватный бот"); return;
  }

  // Решения по открытой позиции.
  if (act0 === "exit" || act0 === "stay" || act0 === "close") {
    const pid = Number(String(q.data).split(":")[1]);
    const p = db.prepare("SELECT * FROM positions WHERE id=?").get(pid);
    if (!p) { await answerCallback(q.id, "Позиция не найдена"); return; }
    if (p.status !== "open") { await answerCallback(q.id, "Сделка уже закрыта"); return; }

    if (act0 === "stay") {
      await answerCallback(q.id, "Понял, продолжаю следить");
      await postUpdate(pid, "⏳ <i>Остаёшься в сделке. Слежу дальше — стоп и цели в силе.</i>");
      return;
    }

    let px;
    try { px = await lastPrice(p.symbol); }
    catch { await answerCallback(q.id, "Цена не пришла, попробуй ещё раз"); return; }
    const reason = act0 === "exit" ? "broken" : "manual";
    const r = closePosition(p, px, reason);
    await answerCallback(q.id, "Закрыл");
    await postUpdate(pid,
      `${act0 === "exit" ? "🟠" : "⚫️"} <b>Сделка закрыта ${act0 === "exit" ? "по слому стратегии" : "вручную"}</b>\n` +
      `${p.symbol} · выход ${fmtPrice(px)} · итог <b>${r > 0 ? "+" : ""}${r.toFixed(2)}R</b>`);
    return;
  }
  const [action, idStr] = String(q.data || "").split(":");
  const id = Number(idStr);
  const sig = db.prepare("SELECT * FROM signals WHERE id = ?").get(id);

  if (!sig) { await answerCallback(q.id, "Сигнал не найден"); return; }
  if (sig.status !== "new") {
    await answerCallback(q.id, sig.status === "taken" ? "Уже в работе" : "Уже пропущен");
    return;
  }

  const view = signalCard({ ...sig, targets: JSON.parse(sig.targets) });

  if (action === "skip") {
    db.prepare("UPDATE signals SET status='skipped' WHERE id=?").run(id);
    logEvent({ kind: "skipped", strategy: sig.strategy, symbol: sig.symbol,
               side: sig.side, price: sig.entry });
    await answerCallback(q.id, "Пропущен");
    await editText(chatId, q.message.message_id, view + "\n\n🚫 <i>Пропущен</i>");
    return;
  }

  if (action === "take") {
    const t = now();
    const r = db.prepare(
      "INSERT INTO positions(signal_id,chat_id,strategy,symbol,side,tf,entry,sl," +
      "sl_current,targets,tp_hit,opened_at,status,msg_id) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,0,?,'open',?)"
    ).run(id, chatId, sig.strategy, sig.symbol, sig.side, sig.tf,
          sig.entry, sig.sl, sig.sl, sig.targets, t, q.message.message_id);
    const posId = Number(r.lastInsertRowid);

    db.prepare("UPDATE signals SET status='taken' WHERE id=?").run(id);
    logEvent({ kind: "taken", strategy: sig.strategy, symbol: sig.symbol,
               side: sig.side, price: sig.entry, text: "взят в работу" });
    await answerCallback(q.id, "Взял в работу — слежу");
    await editText(chatId, q.message.message_id,
      view + "\n\n✅ <b>В работе</b>");

    // Первое звено нитки. Всё, что случится дальше — цели, перенос стопа,
    // слом стратегии, закрытие — придёт ответами сюда же.
    await postUpdate(posId,
      `✅ <b>Взято в работу</b> · ${goldenTime(t)}\n` +
      `<i>Слежу за целями, стопом и сломом стратегии. История сделки — здесь.</i>`);
    return;
  }

  await answerCallback(q.id);
}

// --- запуск -----------------------------------------------------------------
async function main() {
  // Версию печатаем до всякой сети: если связи нет, знать её важнее всего.
  log(`версия кода ${VER.hash} от ${VER.date}`);
  const me = await api("getMe");
  const o = ownerId();
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
    { command: "positions", description: "открытые сделки" },
    { command: "results", description: "итоги сигналов за сегодня" },
    { command: "log",    description: "итоги месяца и выгрузка файлами" },
    { command: "stats",  description: "статистика за всё время" },
    { command: "users",  description: "кто имеет доступ (только админ)" },
    { command: "help",   description: "список команд" },
  ]});

  STRATEGIES = await loadStrategies();

  // Владелец известен из .env — заводим его сразу, чтобы сигналы уходили
  // ещё до первого /start.
  const owner = ownerId();
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
  await startPolling({ onMessage, onCallback });
}

process.on("SIGINT", () => { log("остановка"); db.close(); process.exit(0); });
main().catch(e => { log("фатально:", e.message); process.exit(1); });
