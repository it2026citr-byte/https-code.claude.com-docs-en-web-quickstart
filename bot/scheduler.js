import { cfg, log } from "./config.js";
import { getMode, MODE_FOCUS, openPositions } from "./db.js";

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
