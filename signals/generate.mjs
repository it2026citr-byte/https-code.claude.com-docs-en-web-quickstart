#!/usr/bin/env node
/**
 * Сканер крипто-сигналов по алгоритму универсальной стратегии (скринер-аппроксимация):
 * на каждом таймфрейме (15m/1h/4h/1d) три голоса — CCI (импульс), MACD-гистограмма
 * (momentum, аналог гистограммы Squeeze Momentum), Recommend.MA (ансамбль скользящих —
 * прокси тренда/структуры); плюс детектор сквиза: BB внутри канала Кельтнера (LazyBear).
 * Данные: scanner.tradingview.com. Запуск: node signals/generate.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HDRS = {
  "Content-Type": "application/json",
  Origin: "https://www.tradingview.com",
  "User-Agent": "Mozilla/5.0",
};
const scan = async (market, body) => {
  const res = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST", headers: HDRS, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`scanner HTTP ${res.status}`);
  return res.json();
};

// 1. Вселенная: топ спот-пар BINANCE ...USDT по обороту
const uni = await scan("crypto", {
  filter: [{ left: "exchange", operation: "equal", right: "BINANCE" }],
  columns: ["name", "close", "volume"],
  sort: { sortBy: "volume", sortOrder: "desc" },
  range: [0, 150],
});
const tickers = uni.data
  .filter((r) => r.d[0].endsWith("USDT"))
  .map((r) => ({ ticker: r.s, volUsd: r.d[1] * r.d[2] }))
  .slice(0, 30);
if (tickers.length < 5) throw new Error("вселенная монет не собралась");
const volByTicker = Object.fromEntries(tickers.map((t) => [t.ticker, t.volUsd]));

// 2. Индикаторы по 4 таймфреймам
const TFS = [
  { key: "15m", suffix: "|15", label: "15 мин" },
  { key: "1h", suffix: "|60", label: "1 час" },
  { key: "4h", suffix: "|240", label: "4 часа" },
  { key: "1d", suffix: "", label: "1 день" },
];
const PER_TF = ["CCI20", "MACD.macd", "MACD.signal", "Recommend.MA", "RSI",
  "BB.upper", "BB.lower", "KltChnl.upper", "KltChnl.lower"];
const columns = ["name", "close", "change"];
for (const tf of TFS) for (const c of PER_TF) columns.push(c + tf.suffix);

const { data } = await scan("global", {
  symbols: { tickers: tickers.map((t) => t.ticker), query: { types: [] } },
  columns,
});
if (!data?.length) throw new Error("scanner вернул пустые данные");

// 3. Алгоритм: голоса CCI / MACD-гистограмма / MA-ансамбль → счёт -3..+3
function tfSignal(g, suffix) {
  const cci = g["CCI20" + suffix];
  const hist = g["MACD.macd" + suffix] - g["MACD.signal" + suffix];
  const ma = g["Recommend.MA" + suffix];
  if ([cci, hist, ma].some((v) => v == null || Number.isNaN(v))) return null;
  const vote = (v, dead = 0) => (v > dead ? 1 : v < -dead ? -1 : 0);
  const score = vote(cci) + vote(hist) + vote(ma, 0.1);
  const sqz = g["BB.lower" + suffix] > g["KltChnl.lower" + suffix] &&
              g["BB.upper" + suffix] < g["KltChnl.upper" + suffix];
  return { score, sqz, rsi: g["RSI" + suffix] };
}
function bucket(score) {
  if (score >= 2.5) return { key: "sbuy", label: "АКТ. ПОКУПКА", arrow: "▲▲" };
  if (score >= 1) return { key: "buy", label: "ПОКУПКА", arrow: "▲" };
  if (score <= -2.5) return { key: "ssell", label: "АКТ. ПРОДАЖА", arrow: "▼▼" };
  if (score <= -1) return { key: "sell", label: "ПРОДАЖА", arrow: "▼" };
  return { key: "neutral", label: "НЕЙТР.", arrow: "—" };
}

const rows = data.map((r) => {
  const g = Object.fromEntries(columns.map((c, i) => [c, r.d[i]]));
  const tfs = TFS.map((tf) => tfSignal(g, tf.suffix));
  const valid = tfs.filter(Boolean);
  const mean = valid.length ? valid.reduce((s, t) => s + t.score, 0) / valid.length : 0;
  return {
    name: g.name.replace("USDT", ""),
    pair: g.name,
    close: g.close,
    change24: g.change,
    volUsd: volByTicker[r.s] ?? 0,
    tfs,
    mean,
    consensus: bucket(mean * 1.5),
  };
});
rows.sort((a, b) => b.mean - a.mean || b.volUsd - a.volUsd);

const nBuy = rows.filter((r) => ["buy", "sbuy"].includes(r.consensus.key)).length;
const nSell = rows.filter((r) => ["sell", "ssell"].includes(r.consensus.key)).length;
const nNeutral = rows.length - nBuy - nSell;
const nSqz = rows.filter((r) => r.tfs.some((t) => t?.sqz)).length;
const updated = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

const fmtPrice = (v) =>
  v >= 1000 ? v.toLocaleString("ru-RU", { maximumFractionDigits: 0 })
  : v >= 1 ? v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })
  : v.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
const fmtVol = (usd) =>
  usd >= 1e9 ? (usd / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млрд $"
  : (usd / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " млн $";

const tfCell = (t) => {
  if (!t) return "<td><span class='pill neutral'>—</span></td>";
  const b = bucket(t.score);
  const rsiCls = t.rsi >= 70 ? "hot" : t.rsi <= 30 ? "cold" : "";
  return `<td><span class="pill ${b.key}" title="счёт ${t.score > 0 ? "+" : ""}${t.score} из ±3">${b.arrow} ${b.label}</span>${t.sqz ? '<span class="sqz" title="Сквиз: BB внутри канала Кельтнера — низкая волатильность, готовится движение">⚡ сквиз</span>' : ""}<span class="sub">RSI <span class="num ${rsiCls}">${t.rsi?.toFixed(0) ?? "–"}</span></span></td>`;
};

const tableRows = rows.map((r) => `
  <tr>
    <td class="coin"><strong>${r.name}</strong><span class="sub">${r.pair}</span></td>
    <td class="num price">${fmtPrice(r.close)} $<span class="sub ${r.change24 >= 0 ? "up" : "down"}">${r.change24 >= 0 ? "+" : ""}${r.change24.toFixed(2)}% за 24ч</span></td>
    ${r.tfs.map(tfCell).join("")}
    <td class="consensus"><span class="pill ${r.consensus.key}">${r.consensus.arrow} ${r.consensus.label}</span><span class="sub">счёт ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(1)}</span></td>
    <td class="num vol">${fmtVol(r.volUsd)}</td>
  </tr>`).join("");

const html = `<title>Крипто-сканер · сигналы TradingView</title>
<style>
  :root {
    --bg: #f5f7f9; --surface: #ffffff; --ink: #17202b; --ink2: #55616e; --ink3: #8a95a1;
    --line: #e3e8ed; --buy: #0a8f6c; --buy-bg: #e2f4ee; --sell: #d6383f; --sell-bg: #fcebec;
    --neu: #67737f; --neu-bg: #eef1f4; --sqz: #a86a00; --sqz-bg: #fdf1dc;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg: #10151b; --surface: #171e26; --ink: #e8edf2; --ink2: #9aa7b4; --ink3: #66727f;
    --line: #242d37; --buy: #2fbf8f; --buy-bg: #12332a; --sell: #f0555c; --sell-bg: #3a1b1e;
    --neu: #8a95a1; --neu-bg: #222b34; --sqz: #e8a83d; --sqz-bg: #33270f;
  } }
  :root[data-theme="dark"] {
    --bg: #10151b; --surface: #171e26; --ink: #e8edf2; --ink2: #9aa7b4; --ink3: #66727f;
    --line: #242d37; --buy: #2fbf8f; --buy-bg: #12332a; --sell: #f0555c; --sell-bg: #3a1b1e;
    --neu: #8a95a1; --neu-bg: #222b34; --sqz: #e8a83d; --sqz-bg: #33270f;
  }
  :root[data-theme="light"] {
    --bg: #f5f7f9; --surface: #ffffff; --ink: #17202b; --ink2: #55616e; --ink3: #8a95a1;
    --line: #e3e8ed; --buy: #0a8f6c; --buy-bg: #e2f4ee; --sell: #d6383f; --sell-bg: #fcebec;
    --neu: #67737f; --neu-bg: #eef1f4; --sqz: #a86a00; --sqz-bg: #fdf1dc;
  }
  body { background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px 20px 48px; }
  .wrap { max-width: 1160px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  header h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; text-wrap: balance; }
  header p { margin: 0; color: var(--ink2); font-size: 14px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .tile .v { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile .v.buy { color: var(--buy); } .tile .v.sell { color: var(--sell); }
  .tile .v.neu { color: var(--neu); } .tile .v.sqzc { color: var(--sqz); }
  .tile .l { font-size: 12px; color: var(--ink2); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 1080px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink3); font-weight: 600; padding: 12px 14px 8px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--surface); }
  td { padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td .sub { display: block; font-size: 12px; color: var(--ink3); margin-top: 3px; }
  .num { font-variant-numeric: tabular-nums; }
  .price { font-weight: 600; white-space: nowrap; }
  .sub.up { color: var(--buy); } .sub.down { color: var(--sell); }
  .num.hot { color: var(--sell); font-weight: 600; } .num.cold { color: var(--buy); font-weight: 600; }
  .pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; letter-spacing: 0.02em; }
  .pill.sbuy { background: var(--buy); color: #fff; }
  .pill.buy { background: var(--buy-bg); color: var(--buy); }
  .pill.neutral { background: var(--neu-bg); color: var(--neu); }
  .pill.sell { background: var(--sell-bg); color: var(--sell); }
  .pill.ssell { background: var(--sell); color: #fff; }
  .sqz { display: inline-block; margin-left: 6px; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; background: var(--sqz-bg); color: var(--sqz); white-space: nowrap; }
  .consensus .pill { font-size: 13px; }
  footer { color: var(--ink3); font-size: 12.5px; line-height: 1.6; max-width: 72ch; }
</style>
<div class="wrap">
  <header>
    <h1>Крипто-сканер: сигналы покупки и продажи</h1>
    <p>Топ-${rows.length} спот-пар Binance по обороту · алгоритм стратегии (CCI + MACD + MA-ансамбль + сквиз) · данные TradingView · обновлено ${updated} (МСК)</p>
  </header>
  <div class="tiles">
    <div class="tile"><div class="v buy">${nBuy}</div><div class="l">на покупку</div></div>
    <div class="tile"><div class="v neu">${nNeutral}</div><div class="l">нейтрально</div></div>
    <div class="tile"><div class="v sell">${nSell}</div><div class="l">на продажу</div></div>
    <div class="tile"><div class="v sqzc">${nSqz}</div><div class="l">в сквизе (⚡)</div></div>
  </div>
  <div class="card">
    <table>
      <thead><tr>
        <th>Монета</th><th>Цена</th><th>15 мин</th><th>1 час</th><th>4 часа</th><th>1 день</th><th>Консенсус</th><th>Объём 24ч</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
  <footer>
    Алгоритм на каждом таймфрейме — три голоса из нашей стратегии: импульс CCI (выше/ниже нуля),
    гистограмма MACD (направление momentum, аналог гистограммы Squeeze Momentum) и ансамбль
    скользящих средних TradingView Recommend.MA (прокси тренда). Счёт от −3 до +3: ±3 — активный
    сигнал, ±1–2 — обычный. «Консенсус» — средний счёт по четырём таймфреймам, монеты отсортированы
    по нему. ⚡ — сквиз по LazyBear: полосы Боллинджера внутри канала Кельтнера, низкая волатильность
    перед возможным импульсом. RSI ≥ 70 — перекупленность (красный), ≤ 30 — перепроданность (зелёный).
    Обновляется каждые 15 минут. Не является финансовой рекомендацией.
  </footer>
</div>`;

const out = join(dirname(fileURLToPath(import.meta.url)), "dashboard.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`ok: ${rows.length} монет, BUY ${nBuy} / NEUTRAL ${nNeutral} / SELL ${nSell} / SQZ ${nSqz} → ${out}`);
