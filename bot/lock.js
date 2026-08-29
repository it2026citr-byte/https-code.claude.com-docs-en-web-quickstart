import { openSync, writeSync, closeSync, readFileSync, writeFileSync,
         unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, log } from "./config.js";

const LOCK = join(ROOT, "storage", "bot.lock");
const BEAT_MS = 15_000;      // как часто работающая копия обновляет отметку
const STALE_MS = 60_000;     // после этого замок считается брошенным

const alive = (pid) => {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const read = () => {
  try {
    const [pid, ts] = readFileSync(LOCK, "utf8").split(/\s+/);
    return { pid: Number(pid), ts: Number(ts) };
  } catch { return null; }
};

const stamp = () => `${process.pid} ${Date.now()}`;

/**
 * Единственность экземпляра.
 *
 * Telegram конфликтует только на чтении очереди, а слать сообщения лишним
 * копиям ничто не мешает — поэтому дубли проявляются как несколько
 * одинаковых пульсов подряд.
 *
 * Замок ставится атомарно: флаг "wx" создаёт файл, только если его ещё
 * нет, так что гонка двух одновременных запусков исключена. Живость
 * определяется не по имени процесса — путь в командной строке бывает
 * и относительным, — а по отметке времени, которую работающая копия
 * обновляет каждые пятнадцать секунд. Не обновлялась минуту — брошен.
 */
export function acquireLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, stamp());
      closeSync(fd);

      // Пульс сперва проверяет, что замок всё ещё наш. Android умеет
      // замораживать процесс дольше минуты (doze, phantom freeze);
      // проснувшись, старая копия обнаружила бы, что запасная уже
      // забрала замок, — и молча писала бы поверх, оставив ДВЕ живые
      // копии навсегда. Правильный выход у проснувшейся один: умереть.
      const beat = setInterval(() => {
        try {
          const t0 = Date.now();
          const cur = read();
          if (cur && cur.pid !== process.pid && alive(cur.pid)) {
            log(`замок перехвачен копией PID ${cur.pid} — эта копия лишняя, выхожу`);
            process.exit(0);                     // сторож не поднимет вторую: замок занят
          }
          // Заморозило между чтением и записью? Пишем вслепую поверх
          // возможно чужого замка — лучше пропустить удар: следующий
          // честно перечитает и, если замок занят, выйдет.
          if (Date.now() - t0 > 5_000) return;
          writeFileSync(LOCK, stamp());
        } catch { /* переживём */ }
      }, BEAT_MS);
      beat.unref?.();

      // Снимаем только СВОЙ замок: если его уже перехватила другая
      // копия, unlink снёс бы чужой — и открыл дорогу третьей.
      const release = () => {
        try { if (read()?.pid === process.pid) unlinkSync(LOCK); }
        catch { /* уже нет */ }
      };
      process.on("exit", release);
      for (const s of ["SIGINT", "SIGTERM"])
        process.on(s, () => { release(); process.exit(0); });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      const cur = read();
      const fresh = cur && Date.now() - cur.ts < STALE_MS;
      if (cur && alive(cur.pid) && fresh) {
        log(`уже работает копия бота, PID ${cur.pid} — эта не нужна, выхожу`);
        return false;
      }
      log(cur ? `замок брошен (PID ${cur.pid}), забираю` : "замок повреждён, забираю");
      try { unlinkSync(LOCK); } catch { /* кто-то опередил */ }
    }
  }
  log("замок занят, выхожу во избежание дублей");
  return false;
}
