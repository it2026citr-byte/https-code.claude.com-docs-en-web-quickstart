/**
 * Technical-analysis column sets and rating interpretation, mirroring what
 * tradingview.com shows on its "Technicals" page.
 */

/** Maps a human-friendly interval to the column suffix the scanner expects. */
export const INTERVAL_SUFFIX: Record<string, string> = {
  "1m": "|1",
  "5m": "|5",
  "15m": "|15",
  "30m": "|30",
  "1h": "|60",
  "2h": "|120",
  "4h": "|240",
  "1d": "",
  "1w": "|1W",
  "1M": "|1M",
};

export const INTERVALS = Object.keys(INTERVAL_SUFFIX);

/** Base column names; the interval suffix is appended for non-daily intervals. */
export const TA_COLUMNS = [
  "close",
  "change",
  "Recommend.All",
  "Recommend.MA",
  "Recommend.Other",
  "RSI",
  "Stoch.K",
  "Stoch.D",
  "CCI20",
  "ADX",
  "AO",
  "Mom",
  "MACD.macd",
  "MACD.signal",
  "W.R",
  "BBPower",
  "UO",
  "EMA10",
  "EMA20",
  "EMA30",
  "EMA50",
  "EMA100",
  "EMA200",
  "SMA10",
  "SMA20",
  "SMA30",
  "SMA50",
  "SMA100",
  "SMA200",
];

/** TradingView's rating buckets for Recommend.* values in [-1, 1]. */
export function ratingText(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= 0.5) return "STRONG_BUY";
  if (value >= 0.1) return "BUY";
  if (value > -0.1) return "NEUTRAL";
  if (value > -0.5) return "SELL";
  return "STRONG_SELL";
}
