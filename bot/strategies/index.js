import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Реестр. Новая стратегия — просто новый файл в этой папке,
 * подхватывается сама. Ничего регистрировать вручную не нужно.
 */
export async function loadStrategies() {
  const out = [];
  for (const f of readdirSync(HERE).sort()) {
    if (!f.endsWith(".js") || f === "index.js") continue;
    try {
      const m = await import(join(HERE, f));
      const s = m.default;
      if (!s?.id || !s.evaluate) { log(`пропущен ${f}: нет id или evaluate`); continue; }
      if (s.enabled === false) { log(`${s.id}: выключена в файле стратегии`); continue; }
      // Фабрика и сетка перебора нужны подборщику параметров под монету.
      s.make = m.make ?? null;
      s.tunable = m.TUNABLE ?? null;
      out.push(s);
    } catch (e) {
      log(`стратегия ${f} не загрузилась:`, e.message);
    }
  }
  log(`стратегий загружено: ${out.length} — ${out.map(s => s.id).join(", ")}`);
  return out;
}
