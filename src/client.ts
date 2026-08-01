/**
 * Thin HTTP client for TradingView's public (unauthenticated) endpoints.
 *
 * Endpoints used:
 *  - https://scanner.tradingview.com/<market>/scan  (quotes, indicators, screener)
 *  - https://symbol-search.tradingview.com/symbol_search/v3/  (symbol lookup)
 */

const COMMON_HEADERS: Record<string, string> = {
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
};

export interface ScanFilter {
  left: string;
  operation: string;
  right?: unknown;
}

export interface ScanRequest {
  symbols?: { tickers: string[]; query: { types: string[] } };
  filter?: ScanFilter[];
  columns: string[];
  sort?: { sortBy: string; sortOrder: "asc" | "desc" };
  range?: [number, number];
  markets?: string[];
}

export interface ScanRow {
  s: string; // full ticker, e.g. "NASDAQ:AAPL"
  d: unknown[]; // values aligned with the requested columns
}

export interface ScanResponse {
  totalCount: number;
  data: ScanRow[];
}

export async function scan(market: string, body: ScanRequest): Promise<ScanResponse> {
  const url = `https://scanner.tradingview.com/${encodeURIComponent(market)}/scan`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `TradingView scanner returned HTTP ${res.status} for market "${market}". ` +
        `${text.slice(0, 300)} — check that the market name is valid (e.g. "global", "america", ` +
        `"crypto", "forex") and that every requested column/filter field exists.`
    );
  }
  return (await res.json()) as ScanResponse;
}

/** Convert a scan response into an array of { ticker, <column>: value } objects. */
export function rowsToObjects(columns: string[], rows: ScanRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = { ticker: row.s };
    columns.forEach((col, i) => {
      obj[col] = row.d[i] ?? null;
    });
    return obj;
  });
}

export interface SymbolSearchResult {
  symbol: string;
  description: string;
  type: string;
  exchange: string;
  currency_code?: string;
  country?: string;
  provider_id?: string;
}

export async function searchSymbols(params: {
  text: string;
  type?: string;
  exchange?: string;
}): Promise<{ symbols_remaining: number; symbols: SymbolSearchResult[] }> {
  const qs = new URLSearchParams({
    text: params.text,
    hl: "0",
    lang: "en",
    search_type: params.type ?? "undefined",
    domain: "production",
  });
  if (params.exchange) qs.set("exchange", params.exchange);
  const url = `https://symbol-search.tradingview.com/symbol_search/v3/?${qs.toString()}`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TradingView symbol search returned HTTP ${res.status}. ${text.slice(0, 300)}`);
  }
  return (await res.json()) as { symbols_remaining: number; symbols: SymbolSearchResult[] };
}
