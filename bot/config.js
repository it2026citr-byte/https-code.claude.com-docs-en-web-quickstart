import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

// Читаем .env своими силами — чтобы не тянуть dotenv
for (const p of [join(ROOT, ".env")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

mkdirSync(join(ROOT, "storage"), { recursive: true });

export const cfg = {
  token: process.env.TELEGRAM_TOKEN || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  // Закрытый доступ: бот отвечает только этому Telegram-id.
  // Пусто — владельцем станет тот, кто первым напишет /start.
  ownerId: Number(process.env.OWNER_ID || 0) || null,
  dbPath: join(ROOT, "storage", "bot.db"),

  scanIntervalMin: 15,      // как часто ищем новые монеты
  focusIntervalSec: 10,     // как часто проверяем взятые сделки в фокусе
  normalWatchMin: 15,       // как часто проверяем позиции вне фокуса

  topByTurnover: 80,

  // Граница между поштучными запросами цен и одним общим.
  // Измерено на проводе: одна пара 829 б (из них 790 — заголовки HTTP,
  // данных всего 39), весь список 17 497 б в gzip. Равновесие — 21,1 пары.
  bulkPriceThreshold: 21,       // сколько пар берём в работу по обороту
  minTurnoverUsd: 1_000_000,   // ниже — на фьючерсах съедает проскальзывание

  // 0 — без ограничения: сигналов ровно столько, сколько даёт стратегия.
  // Ненулевое значение — аварийный тормоз, не инструмент отбора.
  maxSignalsPerScan: 0,
  reportHourUtc: 20,        // час UTC для дневной сводки и месячного итога

  riskPct: 1,               // риск на сделку, % депозита
};

if (!cfg.token) {
  console.error("Нет TELEGRAM_TOKEN. Скопируй .env.example в .env и заполни.");
  process.exit(1);
}

/**
 * Версия кода — короткий хеш коммита и его дата. Нужна, чтобы отличать
 * «обновил файлы» от «перезапустил процесс»: git pull меняет файлы,
 * но работающий Node держит в памяти старый код.
 */
export function codeVersion() {
  try {
    const { execFileSync } = require("node:child_process");
    const run = (args) => execFileSync("git", ["-C", ROOT, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { hash: run(["rev-parse", "--short", "HEAD"]),
             date: run(["log", "-1", "--format=%cd", "--date=format:%d.%m %H:%M"]) };
  } catch {
    return { hash: "?", date: "версия не определена" };
  }
}

export const log = (...a) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...a);
};
