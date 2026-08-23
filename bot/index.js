import { cfg, log, codeVersion } from "./config.js";
import { acquireLock } from "./lock.js";
import {
  db, now, getSetting, setSetting, upsertUser, openPositions,
  getUser, setRole, listUsers, getMode, setMode, MODE_SCAN, MODE_FOCUS,
} from "./db.js";
import { api, send, sendLong, sendDoc, sendPhoto, broadcast, broadcastDoc, editText,
         answerCallback, startPolling, esc } from "./telegram.js";
import { topPairs } from "./data/tradingview.js";
import { prices, lastPrice, deepHistory, pairExists } from "./data/mexc.js";
import { monitorTick, closePosition, rAt, alertOnce } from "./monitor.js";
import { candles } from "./candles.js";
import { atr } from "./indicators.js";
import { PARAMS, GROUPS, paramsOf, num, setNum, fmtVal, reportHourUtc } from "./runtime.js";
import * as WL from "./watchlist.js";
import { tuneStrategy } from "./tune.js";
import * as ZN from "./zones.js";
import * as PZ from "./data/prizrak.js";
import { checkTradable, rejectReason } from "./data/tradable.js";
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

/**
 * Повторный сигнал по монете, которая уже в работе.
 *
 * Прислать его как обычную карточку — значит позвать перезайти в то,
 * где ты уже стоишь. Поэтому вместо приглашения идёт правка к открытой
 * сделке: подтверждение с новым стопом или предупреждение о развороте.
 * Одно сообщение на бар — ключ гашения содержит время бара.
 */
const rTxt = (r) => `${r > 0 ? "+" : ""}${r.toFixed(2)}R`;

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
      `<b>${esc(w.symbol)}</b> · ${fmtPrice(w.price)}\n` +
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

async function scanTick() {
  const t0 = Date.now();
  const r = await scanMarket(STRATEGIES, onSignal, onUpdate);
  setSetting("last_market_seen", now());
  setSetting("universe_size", r.pairs);
  const watched = await onWatching(r.watching).catch(() => 0);
  log(`скан: ${r.pairs} пар, кандидатов ${r.candidates}, выдано ${r.signals}, ` +
      `правок по открытым ${r.updates ?? 0}, на прицеле ${watched}, ` +
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
  await Promise.all(syms.map(async (s) => {
    const v = await dailyVol(s).catch(() => null);
    if (v) vol[s] = v;
  }));
  const far = num("zone_far_share") / 100, near = num("zone_near_share") / 100;

  await checkTradable("BTCUSDT").catch(() => null);

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

const TF_RU = { "5m": "5 мин", "15m": "15 мин", "1h": "1 час", "4h": "4 часа" };

function analysisText(symbol, res) {
  const good = res.filter(r => !r.short);
  const age = res[0]?.age ?? 0;
  const young = res.some(r => r.native === false);

  const lines = res.map(r => {
    const tf = `<i>${TF_RU[r.tf] ?? r.tf}</i>`;
    if (r.short)
      return `▫️ <b>${r.id}</b> · ${tf}\n   <i>мало истории — ${r.bars ?? 0} свечей</i>`;
    const pct = r.n ? Math.round(r.win / r.n * 100) : 0;
    const mark = r.n === 0 ? "▫️" : r.avgR > 0 ? "✅" : "🔻";
    return `${mark} <b>${r.id}</b> · ${tf}\n` +
      `   ${sig(r.n)} · ${prof(r.win)} (${pct}%) · стопов ${r.stops}\n` +
      `   <i>ср. ${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}R · ${r.perWeek.toFixed(1)} в неделю</i>`;
  });

  const tot = good.reduce((a, r) => a + r.n, 0);
  const totWin = good.reduce((a, r) => a + r.win, 0);

  const tail = young ? [
    "",
    "<i>Монета моложе трёх месяцев, поэтому считалось на мелких свечах —",
    "на часе у неё вышло бы один-два сигнала, а это не статистика.",
    "С часовыми числами такие напрямую не сравнивай: стратегии настраивались",
    "на часе, и на мелких свечах преимущество другое.",
    "Живые сигналы всё равно пойдут на часе, когда история дорастёт.</i>",
  ] : [];

  return [
    `🔎 <b>${symbol}</b> · возраст ${age} дн`, "",
    ...lines, "",
    tot ? `<b>Итого ${sig(tot)}, ${prof(totWin)} (${Math.round(totWin / tot * 100)}%)</b>`
        : "<b>Сигналов за период не было</b>",
    ...tail,
  ].join("\n");
}

function tuneText(rows) {
  if (!rows.length) return "";
  const lines = rows.map(r => {
    if (!r.chosen)
      return `▫️ <b>${r.id}</b> — умолчания\n   <i>${r.why ?? "подбор не дал выигрыша"}</i>`;
    const p = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ");
    return `🔧 <b>${r.id}</b>\n   <code>${p}</code>\n` +
      `   <i>на проверочной части: ${r.test.n} сигн, ${(r.test.rate*100).toFixed(0)}%, ` +
      `${r.test.sumR > 0 ? "+" : ""}${r.test.sumR.toFixed(1)}R ` +
      `против ${r.baseTest.sumR > 0 ? "+" : ""}${r.baseTest.sumR.toFixed(1)}R у умолчаний</i>`;
  });
  return ["", "", "<b>Подгонка под монету</b>", ...lines, "",
    "<i>Параметры подбирались на первых 70% истории, а сравнивались",
    "на последних 30%, которых подбор не видел. Принято только то,",
    "что выиграло на этой невидимой части — иначе это подгонка под шум.</i>",
  ].join("\n");
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

function zonesText(symbol, zones, weak = []) {
  if (!zones.length) {
    const why = weak.length
      ? `рядом есть уровни, но ни один не подпёрт боковиком — ` +
        `только ${esc(weak[0].note)}. Такие на проверке не держали цену.`
      : `монета идёт без остановок, зацепиться не за что.`;
    return `\n\n🎯 <b>Зон нет</b> — ${why}\n` +
      `<i>Если видишь уровень сам: <code>/zone ${symbol} long ЦЕНА ЦЕНА</code></i>`;
  }
  const lines = zones.map(z =>
    `${z.side === "long" ? "🟢" : "🔴"} <b>${fmtPrice(z.lo)} — ${fmtPrice(z.hi)}</b> ` +
    `· ${z.away}% от цены\n   <i>${esc(z.note)}</i>`);
  return ["", "", `🎯 <b>Предлагаю зоны — ${zones.length}</b>`, ...lines, "",
    "<i>Это кандидаты, а не сигналы: на проверке построенный мной уровень",
    "оказался не лучше случайного, поэтому решаешь ты. Принять — в /zones,",
    `там же кнопка. Поправить: <code>/zone ${symbol} long ЦЕНА ЦЕНА</code>,`,
    "убрать: <code>/zone del НОМЕР</code></i>",
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
/tune ZECUSDT — заново подобрать параметры под монету
/zones — зоны интереса, за которыми слежу
/levels 2 — загрузить уровни из канала за 2 месяца
/charts 3 — принести разборы с графиками за 3 дня
/zone SOLUSDT long 81 82.1 — задать зону руками
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
    `<b>Вселенная:</b> ${uni} пар · порог ${fmtVal("min_turn_k")}` +
      ` <i>(в пересчёте на прошедшую часть суток ${fmtUsd(num("min_turn_k") * 1000 *
        Math.max(0.02, (Date.now() % 86_400_000) / 86_400_000))} $)</i>`,
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
          if (wait) await editText(chatId, wait.message_id, t); else await send(chatId, t);
          break;
        }
        // Подгонка параметров под монету — на первых 70% истории,
        // проверка на последних 30%, которых подбор не видел.
        if (wait) await editText(chatId, wait.message_id,
          `🔧 <b>${esc(sym)}</b> · подбираю параметры под монету…`);
        const tuned = {}, tuneRows = [];
        for (const st of STRATEGIES) {
          const c = await WL.candlesFor(sym, st).catch(() => null);
          if (!c) continue;
          const t = await tuneStrategy(st, c, st.timeframe === "4h" ? 12 : 48, sym).catch(() => null);
          if (!t) continue;
          if (t.chosen) tuned[st.id] = t.params;
          tuneRows.push({ id: st.id, ...t });
        }

        WL.add(sym, res, Object.keys(tuned).length ? tuned : null);
        logEvent({ kind: "note", symbol: sym, text: "монета добавлена в список" });

        if (wait) await editText(chatId, wait.message_id,
          `🎯 <b>${esc(sym)}</b> · строю зоны по истории…`);
        const zn = await buildZones(sym).catch(() => ({ zones: [], short: true }));

        const txt = analysisText(sym, res) + tuneText(tuneRows) +
          (zn.short ? "" : zonesText(sym, zn.zones, zn.weak)) +
          `\n\n✅ <b>Добавлена в список</b> — теперь сканируется всегда.`;
        if (wait) await editText(chatId, wait.message_id, txt);
        else await sendLong(chatId, txt);
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
          if (wait) await editText(chatId, wait.message_id, t); else await send(chatId, t);
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
          if (wait) await editText(chatId, wait.message_id, t); else await send(chatId, t);
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
        await checkTradable("BTCUSDT").catch(() => null);   // подтянуть список контрактов
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
        if (wait) await editText(chatId, wait.message_id, t); else await sendLong(chatId, t);
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
        if (wait) await editText(chatId, wait.message_id, t); else await send(chatId, t);
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
      for (const [sym, zs] of byCoin) {
        const px = allPx[sym] ?? null;
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
          `<b>${esc(sym)}</b>${px ? ` · ${fmtPrice(px)}` : ""}\n` + lines.join("\n"), kb);
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
      const tuned = {}, rows = [];
      for (const st of STRATEGIES) {
        const c = await WL.candlesFor(sym, st).catch(() => null);
        if (!c) continue;
        const t = await tuneStrategy(st, c, st.timeframe === "4h" ? 12 : 48, sym).catch(() => null);
        if (!t) continue;
        if (t.chosen) tuned[st.id] = t.params;
        rows.push({ id: st.id, ...t });
      }
      const old = WL.list().find(r => r.symbol === sym);
      WL.add(sym, old?.stats ? JSON.parse(old.stats) : null,
             Object.keys(tuned).length ? tuned : null);
      const txt = `🔧 <b>${esc(sym)}</b>` + tuneText(rows);
      if (wait) await editText(chatId, wait.message_id, txt); else await sendLong(chatId, txt);
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

  // Вторая копия не должна дожить до отправки сообщений.
  if (!acquireLock()) process.exit(0);
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
