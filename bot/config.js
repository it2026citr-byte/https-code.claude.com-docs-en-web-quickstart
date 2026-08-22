import { readFileSync, existsSync, mkdirSync } from "node:fs";
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
  dbPath: join(ROOT, "storage", "bot.db"),

  scanIntervalMin: 15,      // как часто ищем новые монеты
  focusIntervalSec: 10,     // как часто проверяем взятые сделки в фокусе
  normalWatchMin: 15,       // как часто проверяем позиции вне фокуса

  topByTurnover: 80,       // сколько пар берём в работу по обороту
  minTurnoverUsd: 1_000_000,   // ниже — на фьючерсах съедает проскальзывание

  reportHourUtc: 20,        // час UTC для дневной сводки и месячного итога

  riskPct: 1,               // риск на сделку, % депозита
};

if (!cfg.token) {
  console.error("Нет TELEGRAM_TOKEN. Скопируй .env.example в .env и заполни.");
  process.exit(1);
}

export const log = (...a) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...a);
};
