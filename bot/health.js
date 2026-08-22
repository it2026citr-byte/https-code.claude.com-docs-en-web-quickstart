import { cfg } from "./config.js";

/** Одна проверка: жив ли источник и за сколько отвечает. */
async function probe(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: e.message.slice(0, 80) };
  }
}

const tv = () => probe("TradingView", async () => {
  const r = await fetch("https://scanner.tradingview.com/crypto/scan", {
    method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({
      symbols: { tickers: ["MEXC:BTCUSDT"], query: { types: [] } },
      columns: ["close"],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.data?.[0]?.d?.[0]) throw new Error("пустой ответ");
});

const mexc = () => probe("MEXC", async () => {
  const r = await fetch("https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT",
    { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!(await r.json()).price) throw new Error("нет цены");
});

const telegram = () => probe("Telegram", async () => {
  const r = await fetch(`https://api.telegram.org/bot${cfg.token}/getMe`,
    { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!(await r.json()).ok) throw new Error("отказ");
});

/** Все три источника разом. */
export const checkAll = () => Promise.all([tv(), mexc(), telegram()]);

export function renderHealth(rows) {
  return rows.map(r => r.ok
    ? `✅ ${r.name} — ${(r.ms / 1000).toFixed(2)} с`
    : `❌ ${r.name} — ${r.error}`).join("\n");
}
