import { cfg, log } from "./config.js";
import { getMode, MODE_FOCUS, openPositions, getSetting, setSetting } from "./db.js";

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
export function startLoops({ scanTick, watchTick }) {
  (async function scanLoop() {
    for (;;) {
      await sleep(msToNextBoundary(cfg.scanIntervalMin));
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
      const has = openPositions().length > 0;

      if (!has) { await sleep(30_000); continue; }

      try { await watchTick({ focus }); }
      catch (e) { log("присмотр сорвался:", e.message); }

      await sleep(focus ? cfg.focusIntervalSec * 1000
                        : msToNextBoundary(cfg.normalWatchMin));
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
        const past = d.getUTCHours() >= cfg.reportHourUtc;

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
}
