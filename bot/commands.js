import { cfg, log, codeVersion } from "./config.js";
import {
  db, now, getSetting, setSetting, upsertUser, openPositions,
  getUser, setRole, listUsers, getMode, setMode, MODE_SCAN, MODE_FOCUS,
} from "./db.js";
import { send, sendLong, sendDoc, sendPhoto, editText, editLong, answerCallback, esc } from "./telegram.js";
import { prices, lastPrice, deepHistory, pairExists } from "./data/mexc.js";
import { checkTradable, rejectReason, listsState, ready as tradableReady } from "./data/tradable.js";
import { closePosition, rAt } from "./monitor.js";
import { cacheSize } from "./candles.js";
import { PARAMS, GROUPS, num, setNum, fmtVal } from "./runtime.js";
import { fmtPrice, fmtUsd, fmtAgo, startOfDayUtc } from "./format.js";
import { checkAll, renderHealth } from "./health.js";
import { tuneAll } from "./tune.js";
import {
  logEvent, monthKey, closedBetween, closedInMonth, digest, stats, signalCard, plural,
  goldenTime, summaryLine, monthReport, exportMonthCsv, exportMonthLog, availableMonths,
} from "./journal.js";
import { ACCESS_KB, rTxt, settingsView, settingsKeyboard,
         analysisText, tuneText, zonesText, HELP } from "./texts.js";
import * as WL from "./watchlist.js";
import * as ZN from "./zones.js";
import * as PZ from "./data/prizrak.js";

/**
 * Обработчики команд и кнопок.
 *
 * Всё, что бот делает в ответ на действие человека: разбор /команд,
 * нажатия под карточками, проверка доступа. Раньше это лежало в
 * index.js вместе с тактами работы с рынком, и файл дорос до полутора
 * тысяч строк — там и прятались ошибки вроде /del, забывавшего зоны.
 *
 * Ядро (index.js) передаёт сюда две вещи через init: список стратегий,
 * который собирается при запуске, и способ ответить в нитку сделки.
 * Импортировать их напрямую нельзя — вышло бы кольцо, ведь index.js
 * импортирует этот файл.
 */

/** Время запуска: модуль грузится один раз при старте бота. */
const STARTED = now();
const VER = codeVersion();          // codeVersion помнит ответ, git дёргается один раз

let STRATEGIES = [];
let postUpdate = async () => null;

export function init(deps) {
  STRATEGIES = deps.strategies;
  postUpdate = deps.postUpdate;
}

/**
 * Закрытый доступ с заявками.
 *
 * Бот виден в поиске Telegram — спрятать его нельзя. Поэтому: владелец
 * работает сразу, любой другой получает «приватный бот», а владельцу
 * уходит заявка с кнопками. Без явного «Разрешить» чужой не увидит
 * ни одного сигнала.
 */
export function ownerId() {
  const fromEnv = cfg.ownerId;
  if (fromEnv) return fromEnv;
  const stored = Number(getSetting("owner_id", "0"));
  return stored || null;
}

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


/**
 * Построить зоны по монете и записать их.
 *
 * Строим на часовых свечах: на них видны и боковики, и объёмные узлы,
 * а дневных для молодой монеты просто не наберётся. Старые
 * автоматические зоны по монете убираем — уровни устаревают.
 */
async function buildZones(symbol) {
  const c = await deepHistory(symbol, "1h", 1400).catch(() => []);
  if (c.length < 400) return { zones: [], short: true };
  const found = ZN.propose(c);
  // Если ничего не прошло — посмотрим, что именно отсеялось. «Зон нет»
  // без причины неотличимо от поломки.
  const weak = found.length ? [] : ZN.propose(c, { minScore: 1, trend: false, maxZones: 20 });
  for (const z of ZN.forSymbol(symbol)) if (z.source === "auto") ZN.remove(z.id);
  const zones = found.map(z => ({
    ...z,
    id: ZN.add({ symbol, side: z.side, lo: z.lo, hi: z.hi, note: z.note, source: "auto" }),
  }));
  return { zones, weak, short: false };
}

async function statusText(withHealth = true) {
  const mode = getMode();
  const pos = openPositions();
  const seen = Number(getSetting("last_market_seen", "0"));
  const uni = getSetting("universe_size", "—");

  const lines = [
    `<b>Режим:</b> ${mode === MODE_FOCUS ? "🎯 фокус на сделках" : "🔍 скан рынка"}`,
    `<b>Рынок видел:</b> ${seen ? fmtAgo(now() - seen) + " назад" : "ещё нет"}`,
    `<b>Вселенная:</b> ${uni} пар · порог ${fmtVal("min_turn_k")}` +
      ` <i>(в пересчёте на прошедшую часть суток ${fmtUsd(num("min_turn_k") * 1000 *
        Math.max(0.02, (Date.now() % 86_400_000) / 86_400_000))} $)</i>`,
    // Сканер отстающих сигналы даёт, но стратегией не является —
    // в списке его не было, и выходило, что сигнал пришёл ниоткуда.
    `<b>Стратегий:</b> ${STRATEGIES.length ? STRATEGIES.map(s => s.id).join(", ") : "нет"}`,
    `<b>Сканер отстающих:</b> ${num("leadlag_on") === 1
      ? `ищет · скачок от ${num("ll_pump")}%, совпадение от ${num("ll_corr")}%, ` +
        `сдвиг до ${num("ll_lag") >= 60 ? num("ll_lag") / 60 + " ч" : num("ll_lag") + " мин"}`
      : "выключен"}`,
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
    // Без списков отсев отказывает всем парам, и бот молчит. Молчание
    // от «нечего сказать» и от «не смог проверить» надо различать.
    const L = listsState();
    lines.push(L.perp && L.closed
      ? `<i>свечей в кеше: ${cacheSize()} пар · фьючерсов ${L.perp}, из них закрыто ${L.closed}</i>`
      : `⚠️ <b>Списки фьючерсов не загружены</b> — сигналов не будет, пока не поднимутся.`);
  }
  return lines.join("\n");
}

export async function onMessage(msg) {
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
          `${p.side === "long" ? "📈" : "📉"} <b>${esc(p.symbol)}</b> ${p.side === "long" ? "LONG" : "SHORT"} · <i>${esc(p.strategy)}</i>`,
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
        let tn = "";
        try {
          const pr = JSON.parse(r.params || "null");
          if (pr && Object.keys(pr).length)
            tn = "\n<i>подогнано: " + Object.entries(pr)
              .map(([id, v]) => `${id} (${Object.entries(v).map(([k, x]) => k + "=" + x).join(", ")})`)
              .join("; ") + "</i>";
        } catch { /* без подгонки тоже сойдёт */ }
        await send(chatId, `<b>${esc(r.symbol)}</b>${st}${tn}`,
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
          await editLong(chatId, wait?.message_id, t);
          break;
        }
        // Подгонка параметров под монету — на первых 70% истории,
        // проверка на последних 30%, которых подбор не видел.
        if (wait) await editText(chatId, wait.message_id,
          `🔧 <b>${esc(sym)}</b> · подбираю параметры под монету…`);
        const { params, rows: tuneRows } = await tuneAll(sym, STRATEGIES, WL.candlesFor);

        WL.add(sym, res, params);
        logEvent({ kind: "note", symbol: sym, text: "монета добавлена в список" });

        if (wait) await editText(chatId, wait.message_id,
          `🎯 <b>${esc(sym)}</b> · строю зоны по истории…`);
        const zn = await buildZones(sym).catch(() => ({ zones: [], short: true }));

        const txt = analysisText(sym, res) + tuneText(tuneRows) +
          (zn.short ? "" : zonesText(sym, zn.zones, zn.weak)) +
          `\n\n✅ <b>Добавлена в список</b> — теперь сканируется всегда.`;
        await editLong(chatId, wait?.message_id, txt);
      } catch (e) {
        await send(chatId, `Не смог разобрать <b>${esc(sym)}</b>: ${esc(e.message)}`);
      }
      break;
    }

    case "/charts": case "/графики": {
      const days = Math.min(30, Math.max(1, Number(text.split(/\s+/)[1]) || 3));
      const wait = await send(chatId, `🖼 Ищу разборы с графиками за ${days} дн…`);
      try {
        const list = await PZ.posts(Math.max(1, days / 30));
        const since = Date.now() - days * 86_400_000;
        const pics = PZ.charts(list).filter(x => (Date.parse(x.date) || 0) >= since);
        if (!pics.length) {
          const t = `За ${days} дн разборов с картинками не нашёл.`;
          await editLong(chatId, wait?.message_id, t);
          break;
        }
        if (wait) await editText(chatId, wait.message_id,
          `🖼 <b>Разборов с графиками: ${pics.length}</b>\n` +
          `<i>Под нужной картинкой ответь командой — например\n` +
          `<code>/zone long 0.043 0.046</code>.\n` +
          `Монету возьму из подписи, писать её не нужно.</i>`);

        // Свежие сверху: старые разборы обычно уже отработаны.
        for (const p of pics.slice(-20).reverse()) {
          // Тикер в подписи нужен не для красоты: по нему «/zone long ...»
          // ответом на картинку понимает, о какой монете речь.
          const tag = p.tags[0] ? `#${p.tags[0]}` : "";
          const more = p.photos.length > 1
            ? `\nв посте ещё ${p.photos.length - 1} график(а) — по ссылке` : "";
          const cap =
            `${tag} · ${p.date?.slice(0, 10) ?? ""}\n` +
            `${esc(p.head)}${more}\n${p.link}`;
          await sendPhoto(chatId, p.photos[0], cap);
        }
        await send(chatId,
          `Готово. Под нужным графиком ответь так:\n` +
          `<code>/zone long 0.043 0.046</code>\n` +
          `<i>Если в подписи нет тикера — укажи монету сам: ` +
          `<code>/zone MINAUSDT long 0.043 0.046</code></i>`);
      } catch (e) {
        await send(chatId, `Не смог прочитать канал: ${esc(e.message)}`);
      }
      break;
    }

    case "/levels": case "/уровни": {
      const mon = Math.min(6, Math.max(1, Number(text.split(/\s+/)[1]) || 2));
      const wait = await send(chatId, `📥 Читаю канал уровней за ${mon} мес…`);
      try {
        const list = await PZ.posts(mon);
        const rows = PZ.levels(list);
        if (!rows.length) {
          const t = `Постов прочитал ${list.length}, уровней не нашёл — ` +
                    `видимо в канале сменился формат записи.`;
          await editLong(chatId, wait?.message_id, t);
          break;
        }

        // Оставляем только то, чем бот реально может торговать.
        if (wait) await editText(chatId, wait.message_id,
          `🔎 Уровней ${rows.length}. Проверяю по свечам, какие уже отработаны — это минута-две…`);
        const syms = [...new Set(rows.flatMap(r => (r.pairs ?? [r.pair]).map(x => x + "USDT")))];
        const px = await prices(syms).catch(() => ({}));

        // Зона принадлежит той монете, рядом с чьей ценой она стоит:
        // отклонение больше чем в полтора раза — точно не та монета.
        const pick = (r) => {
          const mid = (r.lo + r.hi) / 2;
          let best = null, bd = Infinity;
          for (const t of r.pairs ?? [r.pair]) {
            const p = px[t + "USDT"];
            if (p == null) continue;
            const d = Math.abs(Math.log(mid / p));
            if (d < bd) { bd = d; best = t; }
          }
          return bd < Math.log(2.5) ? best : null;
        };

        let added = 0, noPair = 0, far = 0, dup = 0, done = 0;
        const seen = new Set();
        await tradableReady();
        let notFut = 0;
        for (const r of rows) {
          const owner = pick(r);
          if (!owner) { noPair++; continue; }
          const sym = owner + "USDT";
          const p = px[sym];
          if (p == null) { noPair++; continue; }
          // Только бессрочные фьючерсы криптовалют.
          if (rejectReason(sym)) { notFut++; continue; }
          const side = r.hi < p ? "long" : r.lo > p ? "short" : null;
          if (!side) { far++; continue; }         // цена внутри зоны — уже поздно
          const away = (side === "long" ? p - r.hi : r.lo - p) / p * 100;
          if (away > 30) { far++; continue; }     // до такого уровня идти месяцами
          const key = `${sym}|${side}|${r.lo.toPrecision(6)}|${r.hi.toPrecision(6)}`;
          if (seen.has(key)) { dup++; continue; }
          seen.add(key);
          const was = ZN.forSymbol(sym).find(z =>
            z.side === side && Math.abs(z.lo - r.lo) / r.lo < 0.005 &&
            Math.abs(z.hi - r.hi) / r.hi < 0.005);
          if (was) { dup++; continue; }

          // Уровень, к которому цена уже приходила после публикации, —
          // отработанный: он свою роль сыграл, ждать там больше нечего.
          const since = Date.parse(r.date || "") || 0;
          if (since) {
            const bars = Math.min(4000, Math.ceil((Date.now() - since) / 3600_000) + 2);
            const c = await deepHistory(sym, "1h", bars).catch(() => []);
            const from = c.filter(b => b.t * 1000 >= since);
            if (from.some(b => b.l <= r.hi && b.h >= r.lo)) { done++; continue; }
          }

          ZN.add({ symbol: sym, side, lo: r.lo, hi: r.hi,
                   note: `канал · ${r.date?.slice(0, 10) ?? ""}`, source: "channel" });
          added++;
        }
        logEvent({ kind: "note", text: `из канала загружено зон: ${added}` });
        const t =
          `📥 <b>Уровни из канала за ${mon} мес</b>\n\n` +
          `Прочитал постов: ${list.length}\n` +
          `Нашёл уровней: ${rows.length}\n\n` +
          `✅ Добавлено: <b>${added}</b> — цена туда ещё не приходила\n` +
          `▫️ Уже отработаны, цена там побывала: ${done}\n` +
          `▫️ Нет пары на бирже: ${noPair}\n` +
          `▫️ Без фьючерса, акции, стейблы: ${notFut}\n` +
          `▫️ Цена внутри зоны или дальше 30%: ${far}\n` +
          `▫️ Повторы: ${dup}\n\n` +
          `<i>Добавлены как непринятые: посмотри <code>/zones</code> и прими ` +
          `кнопкой те, что считаешь рабочими. Сторожить цену буду по всем, ` +
          `но сигнал дам только по принятым.</i>`;
        await editLong(chatId, wait?.message_id, t);
      } catch (e) {
        await send(chatId, `Не смог прочитать канал: ${esc(e.message)}`);
      }
      break;
    }

    case "/zones": case "/зоны": {
      const parts = text.split(/\s+/);
      const arg = WL.normalize(parts[1]);
      // «/zones SOLUSDT новые» — перестроить уровни по свежей истории.
      if (arg && /^(новые|new|rebuild|заново)$/i.test(parts[2] ?? "")) {
        const wait = await send(chatId, `🎯 Строю зоны по <b>${esc(arg)}</b>…`);
        const zn = await buildZones(arg).catch(() => ({ zones: [], short: true }));
        const t = zn.short
          ? `<b>${esc(arg)}</b> — истории мало, зоны не строю.`
          : `🎯 <b>${esc(arg)}</b>` + zonesText(arg, zn.zones, zn.weak);
        await editLong(chatId, wait?.message_id, t);
        break;
      }
      const list = arg ? ZN.forSymbol(arg) : ZN.all();
      if (!list.length) {
        await send(chatId, arg
          ? `По <b>${esc(arg)}</b> зон нет.\n\nПостроить: <code>/zones ${esc(arg)} новые</code>`
          : "🎯 <b>Зон нет</b>\n\nОни появляются сами при <code>/add МОНЕТА</code>.\n" +
            "Или задать вручную: <code>/zone SOLUSDT long 81 82.1</code>");
        break;
      }
      // Одно сообщение на монету: по три карточки на каждую чат не читается.
      const byCoin = new Map();
      for (const z of list) {
        if (!byCoin.has(z.symbol)) byCoin.set(z.symbol, []);
        byCoin.get(z.symbol).push(z);
      }
      await send(chatId,
        `🎯 <b>Зоны${arg ? " · " + esc(arg) : ""} — ${list.length}</b> ` +
        `по ${byCoin.size} монет${byCoin.size === 1 ? "е" : "ам"}\n` +
        `<i>Слежу за ценой и сигналю при подходе и входе в зону.</i>`);

      // Цены — одним запросом на все монеты: по одной это столько
      // обращений к бирже, сколько монет в списке.
      const allPx = await prices([...byCoin.keys()]).catch(() => ({}));
      // Сколько зон по монете показываем за раз. Ограничение не
      // косметическое: у Telegram есть предел и на длину сообщения, и на
      // число кнопок, а после /levels зон по одной монете набирается
      // много. Превысив предел, сообщение не приходит вовсе.
      const PER_COIN = 12;
      for (const [sym, all] of byCoin) {
        const px = allPx[sym] ?? null;
        const zs = (px
          ? [...all].sort((a, b) =>
              Math.min(Math.abs(a.lo - px), Math.abs(a.hi - px)) -
              Math.min(Math.abs(b.lo - px), Math.abs(b.hi - px)))
          : all).slice(0, PER_COIN);
        const hidden = all.length - zs.length;
        const lines = zs.map(z => {
          const away = px ? Math.abs((z.side === "long" ? px - z.hi : z.lo - px)) / px * 100 : null;
          return `${z.side === "long" ? "🟢" : "🔴"} <b>${fmtPrice(z.lo)} — ${fmtPrice(z.hi)}</b>` +
            (away != null ? ` · ${away.toFixed(1)}% от цены` : "") +
            `${z.armed ? "" : " · <i>не принята</i>"}\n` +
            `   <i>№${z.id} · ${esc(z.note ?? "")}</i>`;
        });
        const kb = [];
        for (const z of zs) {
          kb.push(z.armed
            ? [{ text: `🗑 №${z.id}`, callback_data: `zdel:${z.id}` },
               { text: `🔄 №${z.id}`, callback_data: `zarm:${z.id}` }]
            : [{ text: `✅ Принять №${z.id}`, callback_data: `zok:${z.id}` },
               { text: `🗑 №${z.id}`, callback_data: `zdel:${z.id}` }]);
        }
        if (zs.length > 1)
          kb.push([{ text: `🗑 Убрать все по ${sym.replace("USDT", "")}`,
                     callback_data: `zdelall:${sym}` }]);
        await send(chatId,
          `<b>${esc(sym)}</b>${px ? ` · ${fmtPrice(px)}` : ""}\n` + lines.join("\n") +
          (hidden ? `\n<i>…и ещё ${hidden}. Показаны ближайшие к цене.</i>` : ""), kb);
      }
      break;
    }

    case "/zone": case "/зона": {
      let p = text.split(/\s+/).slice(1);
      if (p[0] === "del" || p[0] === "удалить") {
        const ok = ZN.remove(Number(p[1]));
        await send(chatId, ok ? "🗑 Зона убрана." : "Такой зоны нет.");
        break;
      }

      // Ответ на картинку разбора: монету берём из подписи, чтобы под
      // графиком хватало «/zone long 0.043 0.046» — глядя на график,
      // тикер набирать незачем, он и так в подписи.
      let fromPic = null;
      const rep = msg.reply_to_message;
      if (rep && /^(long|лонг|buy|short|шорт|sell)$/i.test(p[0] ?? "")) {
        const cap = rep.caption ?? rep.text ?? "";
        const tag = /#([A-Z0-9]{2,12})\b/.exec(cap);
        if (tag) { fromPic = tag[1]; p = [tag[1], ...p]; }
      }

      const sym = WL.normalize(p[0]);
      const side = /^(long|лонг|buy)$/i.test(p[1] ?? "") ? "long"
                 : /^(short|шорт|sell)$/i.test(p[1] ?? "") ? "short" : null;
      const lo = Number(String(p[2] ?? "").replace(",", "."));
      const hi = Number(String(p[3] ?? "").replace(",", "."));
      if (!sym || !side || !isFinite(lo) || !isFinite(hi) || lo <= 0 || hi <= 0) {
        await send(chatId,
          "Так: <code>/zone SOLUSDT long 81 82.1</code>\n" +
          "Ответом на картинку разбора можно короче: <code>/zone long 81 82.1</code>\n" +
          "или <code>/zone del 7</code> чтобы убрать.");
        break;
      }
      if (!await pairExists(sym)) {
        await send(chatId, `<b>${esc(sym)}</b> — такой пары на бирже нет.`);
        break;
      }
      const nope = await checkTradable(sym).catch(() => null);
      if (nope) {
        await send(chatId, `<b>${esc(sym)}</b> — ${esc(nope)}.\n` +
          `<i>Сигналы даю только по бессрочным фьючерсам криптовалют.</i>`);
        break;
      }
      const id = ZN.add({ symbol: sym, side, lo, hi,
                          note: fromPic ? "снята с графика канала" : "задана вручную" });
      logEvent({ kind: "note", symbol: sym, text: `зона задана вручную ${lo}–${hi}` });
      await send(chatId,
        `🎯 Зона добавлена: ${side === "long" ? "🟢 лонг" : "🔴 шорт"} ` +
        `<b>${esc(sym)}</b> ${fmtPrice(Math.min(lo, hi))} — ${fmtPrice(Math.max(lo, hi))}\n` +
        `<i>№${id}. Слежу за ценой.</i>`);
      break;
    }

    case "/tune": case "/подбор": {
      const sym = WL.normalize(text.split(/\s+/)[1]);
      if (!sym) { await send(chatId, "Так: <code>/tune ZECUSDT</code>"); break; }
      if (!WL.has(sym)) { await send(chatId, `<b>${esc(sym)}</b> не в списке. Сначала <code>/add ${esc(sym)}</code>`); break; }
      const wait = await send(chatId, `🔧 Подбираю параметры под <b>${esc(sym)}</b>…`);
      const { params, rows } = await tuneAll(sym, STRATEGIES, WL.candlesFor);
      const old = WL.list().find(r => r.symbol === sym);
      WL.add(sym, old?.stats ? JSON.parse(old.stats) : null, params);
      const txt = `🔧 <b>${esc(sym)}</b>` + tuneText(rows);
      await editLong(chatId, wait?.message_id, txt);
      break;
    }

    case "/del": case "/убрать": {
      const sym = WL.normalize(text.split(/\s+/)[1]);
      if (!sym) { await send(chatId, "Так: <code>/del ZECUSDT</code>"); break; }
      if (!WL.remove(sym)) { await send(chatId, `<b>${esc(sym)}</b> в списке не было.`); break; }
      // Ровно то же, что делает кнопка в /coins: зоны уходят с монетой,
      // открытая сделка остаётся.
      const zn = ZN.removeSymbol(sym);
      const open = openPositions().filter(p => p.symbol === sym).length;
      logEvent({ kind: "note", text: `монета убрана из списка: ${sym}` +
                                     (zn ? `, зон убрано ${zn}` : "") });
      await send(chatId, `🗑 <b>${esc(sym)}</b> убрана из списка.` +
        (zn ? `\n<i>Заодно убрал ${zn} ${zn === 1 ? "зону" : "зон"} по ней.</i>` : "") +
        (open ? `\n<i>Открытая сделка остаётся — веду её до конца.</i>` : ""));
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
      const rows = closedBetween(startOfDayUtc(now()), now());
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

export async function onCallback(q) {
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

  if (act0 === "zdelall") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const sym = String(q.data).split(":")[1];
    const n = ZN.removeSymbol(sym);
    logEvent({ kind: "note", symbol: sym, text: `убраны все зоны (${n})` });
    await answerCallback(q.id, `Убрано зон: ${n}`);
    await editText(chatId, q.message.message_id,
      `🗑 <b>${esc(sym)}</b> · убраны все зоны (${n})\n` +
      (WL.has(sym) ? `<i>Монета осталась в списке — сканирую как прежде.</i>` : ""));
    return;
  }

  if (act0 === "zok") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const id = Number(String(q.data).split(":")[1]);
    const z = ZN.get(id);
    if (!z) { await answerCallback(q.id, "Зона не найдена"); return; }
    ZN.arm(id); ZN.rearm(id);
    logEvent({ kind: "note", symbol: z.symbol, text: `зона ${z.lo}–${z.hi} принята` });
    await answerCallback(q.id, "Принята — теперь даёт сигнал");
    await editText(chatId, q.message.message_id,
      `✅ <b>Зона принята</b> · ${esc(z.symbol)} ${z.side === "long" ? "лонг" : "шорт"}\n` +
      `${fmtPrice(z.lo)} — ${fmtPrice(z.hi)}\n` +
      `<i>Теперь вход в неё даёт полноценный сигнал.</i>`);
    return;
  }

  if (act0 === "zdel" || act0 === "zarm") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const id = Number(String(q.data).split(":")[1]);
    const z = ZN.get(id);
    if (!z) { await answerCallback(q.id, "Зона не найдена"); return; }
    if (act0 === "zdel") {
      ZN.remove(id);
      const left = ZN.forSymbol(z.symbol).length;
      await answerCallback(q.id, "Убрана");
      await editText(chatId, q.message.message_id,
        `🗑 Зона ${esc(z.symbol)} ${fmtPrice(z.lo)}–${fmtPrice(z.hi)} убрана\n` +
        `<i>${WL.has(z.symbol) ? "Монета в списке остаётся" : "Монеты в списке нет"}` +
        `${left ? `, зон по ней ещё ${left}` : ""}.</i>`);
    } else {
      ZN.rearm(id);
      await answerCallback(q.id, "Сброшено — сработает снова");
      await editText(chatId, q.message.message_id,
        `🔄 ${esc(z.symbol)} ${fmtPrice(z.lo)}–${fmtPrice(z.hi)} · <i>сработает заново</i>`);
    }
    return;
  }

  // Перенос стопа по повторному сигналу — только к цене, только вниз по риску.
  if (act0 === "tsl" || act0 === "close") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const [, rawId, rawSl] = String(q.data).split(":");
    const p = db.prepare("SELECT * FROM positions WHERE id=? AND status='open'").get(Number(rawId));
    if (!p) { await answerCallback(q.id, "Сделка уже закрыта"); return; }
    const long = p.side === "long";

    if (act0 === "close") {
      const px = await lastPrice(p.symbol).catch(() => null);
      if (px == null) { await answerCallback(q.id, "Цена недоступна, попробуй ещё раз"); return; }
      const r = closePosition(p, px, "manual");
      await answerCallback(q.id, `Закрыто ${rTxt(r)}`);
      await editText(chatId, q.message.message_id,
        `🚪 <b>Закрыто вручную</b> · ${esc(p.symbol)} ${long ? "LONG" : "SHORT"}\n` +
        `Цена ${fmtPrice(px)} · итог <b>${rTxt(r)}</b>`);
      return;
    }

    const sl = Number(rawSl);
    const px = await lastPrice(p.symbol).catch(() => null);
    if (!isFinite(sl) || sl <= 0) { await answerCallback(q.id, "Стоп не разобрал"); return; }
    if (!(long ? sl > p.sl_current : sl < p.sl_current)) {
      await answerCallback(q.id, "Текущий стоп уже лучше"); return;
    }
    if (px != null && (long ? sl >= px : sl <= px)) {
      await answerCallback(q.id, "Цена ушла, стоп оказался бы за ней"); return;
    }
    db.prepare("UPDATE positions SET sl_current=?, be_armed=1 WHERE id=?").run(sl, p.id);
    logEvent({ kind: "note", symbol: p.symbol, side: p.side, price: sl,
               text: `стоп подтянут вручную с ${p.sl_current} до ${sl}` });
    await answerCallback(q.id, `Стоп ${fmtPrice(sl)}`);
    await editText(chatId, q.message.message_id,
      `🛡 <b>Стоп подтянут</b> · ${esc(p.symbol)} ${long ? "LONG" : "SHORT"}\n` +
      `${fmtPrice(p.sl_current)} → <b>${fmtPrice(sl)}</b>\n` +
      `<i>Риск уменьшен, перезаходить не потребовалось.</i>`);
    return;
  }

  if (act0 === "wldel") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
    const sym = String(q.data).split(":")[1];
    WL.remove(sym);
    // Убрать монету и оставить сторожить её зоны — значит и дальше
    // слать по ней сигналы. Зоны уходят вместе с монетой.
    const zn = ZN.removeSymbol(sym);
    // Открытую сделку не трогаем: она живёт своей жизнью до стопа
    // или целей, и её сопровождение от списка монет не зависит.
    const open = openPositions().filter(p => p.symbol === sym).length;
    logEvent({ kind: "note", text: `монета убрана из списка: ${sym}` +
                                   (zn ? `, зон убрано ${zn}` : "") });
    await answerCallback(q.id, `${sym} убрана${zn ? `, зон: ${zn}` : ""}`);
    await editText(chatId, q.message.message_id,
      `🗑 <b>${esc(sym)}</b> убрана из списка` +
      (zn ? `\n<i>Заодно убрал ${zn} ${zn === 1 ? "зону" : "зон"} по ней.</i>` : "") +
      (open ? `\n<i>Открытая сделка остаётся — веду её до конца.</i>` : ""));
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
  // Раньше сюда же был приписан close — но он разбирается выше вместе
  // с tsl и до этой ветки не доходил. Оставлять недостижимый разбор
  // вредно: правка в нём выглядит применённой, а на деле мертва.
  if (act0 === "exit" || act0 === "stay") {
    if (chatId !== ownerId()) { await answerCallback(q.id, "Только администратор"); return; }
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
    const r = closePosition(p, px, "broken");
    await answerCallback(q.id, "Закрыл");
    await postUpdate(pid,
      `🟠 <b>Сделка закрыта по слому стратегии</b>\n` +
      `${esc(p.symbol)} · выход ${fmtPrice(px)} · итог <b>${r > 0 ? "+" : ""}${r.toFixed(2)}R</b>`);
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
      "sl_current,targets,shares,tp_hit,opened_at,status,msg_id) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,'open',?)"
    ).run(id, chatId, sig.strategy, sig.symbol, sig.side, sig.tf,
          sig.entry, sig.sl, sig.sl, sig.targets, sig.shares ?? null, t, q.message.message_id);
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
