import { db, now, openPositions } from "./db.js";
import { log } from "./config.js";
import { prices, TF_SEC } from "./data/mexc.js";
import { candles } from "./candles.js";
import { logEvent, goldenTime } from "./journal.js";
import { num } from "./runtime.js";
import { paramsFor } from "./watchlist.js";
import { fmtPrice, fmtAgo } from "./format.js";

/** Тревога не повторяется: уникальный ключ (позиция, уровень, причина). */
const insAlert = db.prepare(
  "INSERT OR IGNORE INTO alerts(position_id,level,reason,text,created_at) VALUES(?,?,?,?,?)"
);
const once = (posId, level, reason, text) =>
  insAlert.run(posId, level, reason, text ?? "", now()).changes > 0;

/** То же гашение повторов — для сообщений вне монитора. */
export const alertOnce = once;

export const stopDist = (p) => Math.abs(p.entry - p.sl);

/**
 * Лесенка: 20% позиции на каждой из пяти целей. После первой цели стоп
 * уходит в безубыток — ровно так считался бэктест, по которому выбраны
 * пороги входа.
 */
export function banked(tpHit) {
  let s = 0;
  for (let n = 1; n <= tpHit; n++) s += 0.2 * 0.5 * n;
  return s;
}
export function rAt(p, price) {
  const d = stopDist(p);
  if (!d) return 0;
  const left = Math.max(0, 1 - 0.2 * p.tp_hit);
  const move = (p.side === "long" ? price - p.entry : p.entry - price) / d;
  return banked(p.tp_hit) + left * move;
}

export function closePosition(p, price, reason) {
  const r = rAt(p, price);
  db.prepare(
    "UPDATE positions SET status='closed', closed_at=?, close_price=?, " +
    "close_reason=?, r_result=? WHERE id=?"
  ).run(now(), price, reason, r, p.id);
  logEvent({ kind: reason === "stop" ? "stop" : "closed", strategy: p.strategy,
             symbol: p.symbol, side: p.side, price, r, text: reason });
  return r;
}

const rTxt = (r) => `${r > 0 ? "+" : ""}${r.toFixed(2)}R`;

/** Причина слома жирным заголовком; уровень — уже причёсанным числом. */
export const badHtml = (b) =>
  `<b>${b.label}</b>` +
  (b.detail ? `\n${b.detail}` : "") +
  (b.level != null ? ` <b>${fmtPrice(b.level)}</b>` : "");

/** То же самое строкой — для журнала и для ключа дедупликации. */
export const badText = (b) =>
  `${b.label}: ${b.detail ?? ""}${b.level != null ? " " + fmtPrice(b.level) : ""}`.trim();

/**
 * Такт присмотра.
 *
 * Цели и стоп проверяются по текущей цене — это дёшево, можно часто.
 * Слом стратегии требует индикаторов, поэтому считается один раз
 * на закрытии бара «родного» таймфрейма позиции.
 */
export async function monitorTick({ strategies, notify, focus }) {
  const pos = openPositions();
  if (!pos.length) return { checked: 0, events: 0 };

  const px = await prices([...new Set(pos.map(p => p.symbol))]);
  let events = 0;

  for (const p of pos) {
    const price = px[p.symbol];
    if (price == null) continue;
    const long = p.side === "long";
    const targets = JSON.parse(p.targets);
    const d = stopDist(p);

    // --- безубыток раньше первой цели -------------------------------------
    // Отдельный рычаг: чем раньше стоп уезжает в ноль, тем меньше
    // убыточных сделок и тем меньше прибыль. Крутится из /settings.
    const beAt = num("be_at") / 100;
    if (!p.be_armed && p.tp_hit === 0 && beAt < 0.5 && d > 0) {
      const trigger = long ? p.entry + beAt * d : p.entry - beAt * d;
      if (long ? price >= trigger : price <= trigger) {
        db.prepare("UPDATE positions SET be_armed=1, sl_current=? WHERE id=?")
          .run(p.entry, p.id);
        p.be_armed = 1; p.sl_current = p.entry;
        if (once(p.id, "info", "breakeven", "")) {
          events++;
          logEvent({ kind: "note", strategy: p.strategy, symbol: p.symbol,
                     side: p.side, price, text: "стоп в безубытке" });
          await notify(p.id,
            `⚪️ <b>Стоп в безубытке</b> · ${fmtPrice(p.entry)}\n` +
            `${p.symbol} ${long ? "LONG" : "SHORT"} · прошли ${beAt.toFixed(2)}R в свою сторону\n` +
            `<i>Дальше сделка не может кончиться убытком.</i>`);
        }
      }
    }

    // --- цели -------------------------------------------------------------
    let hit = p.tp_hit;
    while (hit < targets.length &&
           (long ? price >= targets[hit] : price <= targets[hit])) hit++;

    if (hit > p.tp_hit) {
      const toBreakeven = p.tp_hit === 0 && !p.be_armed;
      const newSl = toBreakeven || p.be_armed ? p.entry : p.sl_current;
      db.prepare("UPDATE positions SET tp_hit=?, sl_current=?, be_armed=1 WHERE id=?")
        .run(hit, newSl, p.id);
      p.tp_hit = hit; p.sl_current = newSl;

      if (once(p.id, "target", `t${hit}`, "")) {
        events++;
        logEvent({ kind: "target", strategy: p.strategy, symbol: p.symbol,
                   side: p.side, price, r: banked(hit), text: `цель ${hit}` });
        const more = hit < targets.length
          ? `Следующая цель ${fmtPrice(targets[hit])}`
          : "Все цели взяты";
        await notify(p.id,
          `🎯 <b>Цель ${hit}</b> · ${fmtPrice(targets[hit - 1])}\n` +
          `${p.symbol} ${long ? "LONG" : "SHORT"} · зафиксировано <b>${rTxt(banked(hit))}</b>\n` +
          (toBreakeven ? `Стоп переведён в безубыток ${fmtPrice(p.entry)}\n` : "") +
          `<i>${more}</i>`);
      }

      if (hit >= targets.length) {
        const r = closePosition(p, targets[targets.length - 1], "target");
        await notify(p.id,
          `🟢 <b>Закрыта по последней цели</b>\n` +
          `${p.symbol} ${long ? "LONG" : "SHORT"} · итог <b>${rTxt(r)}</b>\n` +
          `<i>${goldenTime(now())}</i>`);
        continue;
      }
    }

    // --- стоп -------------------------------------------------------------
    const sl = p.sl_current;
    if (long ? price <= sl : price >= sl) {
      const be = p.tp_hit > 0 || p.be_armed === 1;
      const r = closePosition(p, sl, "stop");
      await notify(p.id,
        `${be ? "⚪️" : "🔴"} <b>${be ? "Стоп в безубытке" : "Стоп"}</b> · ${fmtPrice(sl)}\n` +
        `${p.symbol} ${long ? "LONG" : "SHORT"} · итог <b>${rTxt(r)}</b>\n` +
        `<i>${goldenTime(now())}</i>`);
      events++;
      continue;
    }

    // --- слом стратегии ---------------------------------------------------
    // У слитого сигнала имя составное: «A + B». Берём первую из тех,
    // что действительно есть в реестре, — иначе проверки слома молчали бы.
    const names = String(p.strategy).split(" + ");
    const base = strategies.find(s => names.includes(s.id));
    if (!base?.invalidated) continue;
    const own = paramsFor(p.symbol)?.[base.id];
    const st = own && base.make ? base.make(own) : base;
    const step = TF_SEC[st.timeframe] ?? 3600;
    const closedBar = Math.floor(now() / step) * step - step;
    const barIsNew = (p.last_bar ?? 0) < closedBar;

    // Вне фокуса считаем только на закрытии бара — это дёшево и достаточно.
    // В фокусе смотрим ещё и внутрь формирующейся свечи: там рождается
    // жёлтая тревога, дающая фору до закрытия часа.
    if (!barIsNew && !focus) continue;

    let c;
    try { c = await candles(p.symbol, st.timeframe, 300); }
    catch (e) { log(`свечи ${p.symbol} не пришли:`, e.message); continue; }
    if (c.length < 160) continue;

    const x = st.prepare(c);
    const iClosed = c.length - 2;
    const iLive = c.length - 1;

    // --- красная: бар закрылся, сомнений нет ---
    if (barIsNew) {
      db.prepare("UPDATE positions SET last_bar=? WHERE id=?").run(c[iClosed].t, p.id);
      const bad = st.invalidated(c, x, iClosed, p);
      if (bad && once(p.id, "red", bad.reason, badText(bad))) {
        events++;
        logEvent({ kind: "broken", strategy: p.strategy, symbol: p.symbol,
                   side: p.side, price, r: rAt(p, price), text: badText(bad) });
        await notify(p.id,
          `🔴 <b>ВЫХОД — СТРАТЕГИЯ СЛОМАНА</b>\n` +
          `${p.symbol} ${long ? "LONG" : "SHORT"}\n\n` +
          `${badHtml(bad)}\n\n` +
          `Цена ${fmtPrice(price)} · стоп ${fmtPrice(sl)} · сейчас <b>${rTxt(rAt(p, price))}</b>\n` +
          `<i>Подтверждено на закрытии бара. Выходи, не дожидаясь стопа.</i>`,
          [[{ text: "✅ Вышел", callback_data: `exit:${p.id}` },
            { text: "⏳ Остаюсь", callback_data: `stay:${p.id}` }]]);
        continue;
      }
    }

    // --- жёлтая: свеча ещё формируется, но условие уже выполнено ---
    if (!focus) continue;
    const early = st.invalidated(c, x, iLive, p);
    if (!early) continue;
    if (!once(p.id, "yellow", early.reason, badText(early))) continue;

    events++;
    const left = Math.max(0, (Math.floor(now() / step) * step + step) - now());
    logEvent({ kind: "note", strategy: p.strategy, symbol: p.symbol, side: p.side,
               price, text: `жёлтая тревога: ${badText(early)}` });
    await notify(p.id,
      `🟡 <b>ТРЕВОГА — условие выхода выполнено</b>\n` +
      `${p.symbol} ${long ? "LONG" : "SHORT"}\n\n` +
      `${badHtml(early)}\n\n` +
      `Цена ${fmtPrice(price)} · сейчас <b>${rTxt(rAt(p, price))}</b>\n` +
      `<i>Свеча ещё не закрылась, до закрытия ${fmtAgo(left)}. ` +
      `Успеет отыграть — тревога снимется, нет — придёт красная.</i>`,
      [[{ text: "✅ Вышел заранее", callback_data: `exit:${p.id}` },
        { text: "⏳ Жду закрытия", callback_data: `stay:${p.id}` }]]);
  }

  return { checked: pos.length, events };
}
