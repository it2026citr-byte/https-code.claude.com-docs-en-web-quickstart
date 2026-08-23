import { cfg, log } from "./config.js";
import { getMode, MODE_FOCUS, openPositions, getSetting, setSetting } from "./db.js";
import { num, reportHourUtc } from "./runtime.js";
import { symbols as zoneSymbols } from "./zones.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Сколько миллисекунд до закрытия следующей свечи в N минут (+ фора). */
function msToNextBoundary(minutes, graceSec = 5) {
  const step = minutes * 60_000;
  const next = Math.ceil(Date.now() / step) * step;
  return next - Date.now() + graceSec * 1000;
}

/**
 * Два независимых цикла.
 *   scanTick  — поиск новых монет, только вне фокуса, на закрытии свечи.
 *   watchTick — присмотр за взятыми сделками. В фокусе каждые 10 секунд,
 *               вне фокуса — вместе со сканом.
 */
export function startLoops({ scanTick, watchTick, pulseTick }) {
  // Интервалы читаются на каждом витке: правка из Telegram применяется
  // со следующего такта, перезапускать бота не нужно.
  (async function scanLoop() {
    for (;;) {
      await sleep(msToNextBoundary(num("scan_min")));
      if (getMode() === MODE_FOCUS) {
        log("фокус: скан рынка пропущен");
        continue;
      }
      try { await scanTick(); }
      catch (e) { log("скан сорвался:", e.message); }
    }
  })();

  (async function watchLoop() {
    for (;;) {
      const focus = getMode() === MODE_FOCUS;
      // Присматривать нужно и когда сделок нет: зоны ждут цену сами по себе.
      const has = openPositions().length > 0 || zoneSymbols().length > 0;

      if (!has) { await sleep(30_000); continue; }

      try { await watchTick({ focus }); }
      catch (e) { log("присмотр сорвался:", e.message); }

      await sleep(focus ? num("focus_sec") * 1000
                        : msToNextBoundary(num("watch_min")));
    }
  })();

  // Пульс живёт своим ритмом, не привязан к скану. Ноль — выключен.
  (async function pulseLoop() {
    for (;;) {
      const m = num("pulse_min");
      if (m <= 0) { await sleep(60_000); continue; }
      await sleep(msToNextBoundary(m));
      if (num("pulse_min") <= 0) continue;      // успели выключить, пока спали
      try { await pulseTick(); }
      catch (e) { log("пульс сорвался:", e.message); }
    }
  })();
}

/**
 * Отчёты. Проверяем раз в минуту, не пора ли — так переживаем выключение
 * компьютера: если срок настал, пока машина спала, отчёт уйдёт при запуске.
 */
export function startReports({ onDaily, onMonthly }) {
  (async function reportLoop() {
    for (;;) {
      try {
        const d = new Date();
        const day = d.toISOString().slice(0, 10);
        const month = d.toISOString().slice(0, 7);
        const past = d.getUTCHours() >= reportHourUtc();

        // Дневная сводка за сегодня — после назначенного часа, один раз в день.
        if (past && getSetting("last_daily") !== day) {
          setSetting("last_daily", day);
          await onDaily(day);
        }

        // Месячный итог — первого числа, за прошлый месяц.
        const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0))
          .toISOString().slice(0, 7);
        if (d.getUTCDate() === 1 && past && getSetting("last_monthly") !== month) {
          setSetting("last_monthly", month);
          await onMonthly(prev);
        }
      } catch (e) { log("отчёт не собрался:", e.message); }
      await sleep(60_000);
    }
  })();

  // Пульс живёт своим ритмом, не привязан к скану. Ноль — выключен.
  (async function pulseLoop() {
    for (;;) {
      const m = num("pulse_min");
      if (m <= 0) { await sleep(60_000); continue; }
      await sleep(msToNextBoundary(m));
      if (num("pulse_min") <= 0) continue;      // успели выключить, пока спали
      try { await pulseTick(); }
      catch (e) { log("пульс сорвался:", e.message); }
    }
  })();
}
