import { cfg, log } from "./config.js";
import {
  db, now, getSetting, setSetting, upsertUser, openPositions,
  getMode, setMode, MODE_SCAN, MODE_FOCUS,
} from "./db.js";
import { api, send, sendLong, sendDoc, broadcast, broadcastDoc,
         answerCallback, startPolling, esc } from "./telegram.js";
import { topPairs } from "./data/tradingview.js";
import { prices } from "./data/mexc.js";
import { startLoops, startReports } from "./scheduler.js";
import { fmtPrice, fmtPct, fmtUsd, fmtAgo, fmtTime } from "./format.js";
import {
  logEvent, monthKey, closedBetween, closedInMonth, digest, stats,
  summaryLine, monthReport, exportMonthCsv, exportMonthLog, availableMonths,
} from "./journal.js";

const STARTED = now();

// --- состояние рынка --------------------------------------------------------
async function marketSnapshot() {
  const top = await topPairs();
  setSetting("last_market_seen", now());
  setSetting("universe_size", top.length);
  return top;
}

// --- такты ------------------------------------------------------------------
async function scanTick() {
  const top = await marketSnapshot();
  log(`скан: ${top.length} пар в работе`);
  if (getSetting("pulse", "1") === "1") {
    const t = top.slice(0, 3)
      .map(r => `${r.symbol.replace("USDT", "")} ${fmtPrice(r.close)} (${fmtPct(r.change)})`)
      .join(" · ");
    await broadcast(`📊 ${t}\n<i>вселенная ${top.length} пар · этап 1, стратегии подключаются следующим шагом</i>`);
  }
}

async function watchTick({ focus }) {
  const pos = openPositions();
  if (!pos.length) return;
  const px = await prices([...new Set(pos.map(p => p.symbol))]);
  setSetting("last_market_seen", now());
  log(`присмотр${focus ? " (фокус)" : ""}: ${pos.length} позиций, цены получены по ${Object.keys(px).length}`);
  // Проверка целей, стопа и нарушения стратегии — этап 3.
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

// --- команды ----------------------------------------------------------------
const HELP = `<b>Что я умею</b>

/status — режим, что вижу на рынке, открытые сделки
/focus — бросить всё и следить только за взятыми сделками
/scan — вернуться к поиску новых монет
/pulse — включить/выключить сводку раз в 15 минут

<b>Журнал</b>
/results — итоги закрытых сигналов за сегодня
/log — итоги месяца плюс выгрузка файлами
/stats — статистика за всё время
/help — это сообщение

<i>Telegram понимает только латиницу в командах, но я отзываюсь и на русские:
/статус /фокус /скан /пульс /итоги /журнал /стата /помощь</i>

<i>Скоро: сигналы по стратегиям, кнопка «Взял в работу», тревоги на выход.</i>`;

async function statusText() {
  const mode = getMode();
  const pos = openPositions();
  const seen = Number(getSetting("last_market_seen", "0"));
  const uni = getSetting("universe_size", "—");

  const lines = [
    `<b>Режим:</b> ${mode === MODE_FOCUS ? "🎯 фокус на сделках" : "🔍 скан рынка"}`,
    `<b>Рынок видел:</b> ${seen ? fmtAgo(now() - seen) + " назад" : "ещё нет"}`,
    `<b>Вселенная:</b> ${uni} пар MEXC/USDT дороже ${fmtUsd(cfg.minTurnoverUsd)} $ оборота`,
    `<b>Открытых сделок:</b> ${pos.length}`,
    `<b>Работаю без перерыва:</b> ${fmtAgo(now() - STARTED)}`,
  ];
  if (pos.length) {
    lines.push("", "<b>В работе:</b>");
    for (const p of pos) {
      lines.push(`• ${p.side === "long" ? "📈" : "📉"} ${esc(p.symbol)} от ${fmtPrice(p.entry)} · ${esc(p.strategy)}`);
    }
  }
  return lines.join("\n");
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");

  if (cmd === "/start") {
    upsertUser(chatId, msg.from?.username);
    await send(chatId,
      `Готов работать.\n\nЯ ищу точки входа по фьючерсам MEXC, показываю сигналы и слежу за теми, что ты взял в работу. Когда стратегия ломается — предупреждаю до стопа.\n\n${HELP}`);
    return;
  }
  upsertUser(chatId, msg.from?.username);

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
      const on = getSetting("pulse", "1") === "1";
      setSetting("pulse", on ? "0" : "1");
      await send(chatId, on ? "Пульс выключен." : "Пульс включён — сводка раз в 15 минут.");
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
  await answerCallback(q.id, "Кнопки заработают на следующем этапе");
}

// --- запуск -----------------------------------------------------------------
async function main() {
  const me = await api("getMe");
  log(`бот @${me.username} на связи`);

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
    { command: "pulse",  description: "сводка раз в 15 минут" },
    { command: "results", description: "итоги сигналов за сегодня" },
    { command: "log",    description: "итоги месяца и выгрузка файлами" },
    { command: "stats",  description: "статистика за всё время" },
    { command: "help",   description: "список команд" },
  ]});

  await marketSnapshot().catch(e => log("первый скан не удался:", e.message));
  logEvent({ kind: "note", text: "бот запущен" });
  startLoops({ scanTick, watchTick });
  startReports({ onDaily, onMonthly });
  await startPolling({ onMessage, onCallback });
}

process.on("SIGINT", () => { log("остановка"); db.close(); process.exit(0); });
main().catch(e => { log("фатально:", e.message); process.exit(1); });
