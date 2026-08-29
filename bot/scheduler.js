import { cfg, log } from "./config.js";
import { getMode, MODE_FOCUS, openPositions, getSetting, setSetting } from "./db.js";
import { num, reportHourUtc } from "./runtime.js";
import { symbols as zoneSymbols } from "./zones.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Такт с ограничением по времени.
 *
 * Без него подвисший запрос к бирже останавливает весь цикл: следующий
 * такт не начнётся, пока не завершится текущий, и бот замолкает
 * насовсем. Обещание, которое не разрешилось, отменить нельзя — но
 * можно перестать его ждать и пойти дальше.
 */
async function withDeadline(name, fn, ms) {
  let timer;
  const bell = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error(`${name}: не уложился в ${Math.round(ms / 1000)} с`)), ms);
  });
  try { return await Promise.race([fn(), bell]); }
  finally { clearTimeout(timer); }
}

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
      // Предел вдвое больше интервала: если такт съел его целиком,
      // что-то пошло не так, и лучше начать новый, чем ждать вечно.
      const limit = Math.max(120_000, num("scan_min") * 60_000 * 2);
      try { await withDeadline("скан", scanTick, limit); }
      catch (e) { log("скан сорвался:", e.message); }
    }
  })();

  (async function watchLoop() {
    for (;;) {
      const focus = getMode() === MODE_FOCUS;
      // Присматривать нужно и когда сделок нет: зоны ждут цену сами по себе.
      const has = openPositions().length > 0 || zoneSymbols().length > 0;

      if (!has) { await sleep(30_000); continue; }

      try { await withDeadline("присмотр", () => watchTick({ focus }), 120_000); }
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

        // Дневная сводка — после назначенного часа, один раз в день.
        // Отметка ставится ДО отправки, а при ошибке снимается: так
        // сорвавшаяся сборка повторится через минуту, но внезапная
        // смерть процесса ПОСЛЕ рассылки не приведёт к дублю на
        // перезапуске — отметка уже стоит. Оба худших случая закрыты.
        if (past && getSetting("last_daily") !== day) {
          setSetting("last_daily", day);
          try { await onDaily(day); }
          catch (e) { setSetting("last_daily", ""); throw e; }
        }

        // Месячный итог — первого числа, за прошлый месяц.
        const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0))
          .toISOString().slice(0, 7);
        if (d.getUTCDate() === 1 && past && getSetting("last_monthly") !== month) {
          setSetting("last_monthly", month);
          try { await onMonthly(prev); }
          catch (e) { setSetting("last_monthly", ""); throw e; }
        }
      } catch (e) { log("отчёт не собрался:", e.message); }
      await sleep(60_000);
    }
  })();
}
