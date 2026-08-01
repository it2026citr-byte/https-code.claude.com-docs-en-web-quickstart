#!/usr/bin/env node
/**
 * TradingView MCP server.
 *
 * Transports:
 *  - stdio (default):        node dist/index.js
 *  - streamable HTTP:        node dist/index.js --http [--port 3810]
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { rowsToObjects, scan, searchSymbols, type ScanFilter } from "./client.js";
import { INTERVAL_SUFFIX, INTERVALS, TA_COLUMNS, ratingText } from "./technicals.js";

const QUOTE_COLUMNS = [
  "name",
  "description",
  "type",
  "close",
  "currency",
  "change",
  "change_abs",
  "open",
  "high",
  "low",
  "volume",
  "market_cap_basic",
  "price_earnings_ttm",
  "earnings_per_share_basic_ttm",
];

function buildServer(): McpServer {
  const server = new McpServer({ name: "tradingview", version: "1.0.0" });

  server.registerTool(
    "tradingview_search_symbols",
    {
      title: "Search TradingView symbols",
      description:
        "Search TradingView for tickers by name, symbol, ISIN, or CUSIP. Returns matches with " +
        'their exchange, so results can be passed to other tools as "EXCHANGE:SYMBOL" ' +
        '(e.g. "NASDAQ:AAPL", "BINANCE:BTCUSDT"). Use this first when you only know a company ' +
        "or asset name.",
      inputSchema: {
        text: z.string().min(1).describe('Search query, e.g. "apple", "BTC", "US0378331005"'),
        type: z
          .enum(["stock", "fund", "futures", "forex", "crypto", "index", "bond", "economic"])
          .optional()
          .describe("Restrict results to one asset type"),
        exchange: z.string().optional().describe('Restrict to an exchange, e.g. "NASDAQ", "BINANCE"'),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ text, type, exchange, limit }) => {
      const res = await searchSymbols({ text, type, exchange });
      const symbols = res.symbols.slice(0, limit).map((s) => ({
        ticker: `${s.exchange}:${s.symbol.replace(/<\/?em>/g, "")}`,
        symbol: s.symbol.replace(/<\/?em>/g, ""),
        description: s.description.replace(/<\/?em>/g, ""),
        type: s.type,
        exchange: s.exchange,
        currency: s.currency_code ?? null,
        country: s.country ?? null,
      }));
      const structured = { total_matches: symbols.length + res.symbols_remaining, symbols };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  server.registerTool(
    "tradingview_get_quotes",
    {
      title: "Get TradingView quotes",
      description:
        "Get current quotes for up to 50 symbols in one call: price, change %, OHLC, volume, " +
        "market cap, and P/E. Symbols must be fully qualified as \"EXCHANGE:SYMBOL\" " +
        '(e.g. "NASDAQ:AAPL", "BINANCE:BTCUSDT", "FX_IDC:EURUSD"); use ' +
        "tradingview_search_symbols to resolve them. Extra scanner columns (fundamentals, " +
        'performance, etc.) can be requested via extra_columns, e.g. ["Perf.YTD", "dividends_yield"].',
      inputSchema: {
        symbols: z
          .array(z.string().regex(/^[^:]+:[^:]+$/, 'Must be "EXCHANGE:SYMBOL"'))
          .min(1)
          .max(50)
          .describe('Fully qualified tickers, e.g. ["NASDAQ:AAPL", "BINANCE:BTCUSDT"]'),
        extra_columns: z
          .array(z.string())
          .optional()
          .describe('Additional TradingView scanner columns to include, e.g. ["Perf.YTD"]'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols, extra_columns }) => {
      const columns = [...QUOTE_COLUMNS, ...(extra_columns ?? [])];
      const res = await scan("global", {
        symbols: { tickers: symbols, query: { types: [] } },
        columns,
      });
      const quotes = rowsToObjects(columns, res.data);
      const found = new Set(res.data.map((r) => r.s));
      const missing = symbols.filter((s) => !found.has(s));
      const structured = { quotes, ...(missing.length ? { not_found: missing } : {}) };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  server.registerTool(
    "tradingview_get_technical_analysis",
    {
      title: "Get TradingView technical analysis",
      description:
        "Get TradingView's technical-analysis summary for one symbol: the overall " +
        "Buy/Sell/Neutral recommendation (as shown on tradingview.com's Technicals gauge) plus " +
        "the underlying oscillator and moving-average indicator values (RSI, MACD, Stochastic, " +
        "ADX, EMAs/SMAs, ...). Supports multiple timeframes per call.",
      inputSchema: {
        symbol: z
          .string()
          .regex(/^[^:]+:[^:]+$/, 'Must be "EXCHANGE:SYMBOL"')
          .describe('Fully qualified ticker, e.g. "NASDAQ:AAPL"'),
        intervals: z
          .array(z.enum(INTERVALS as [string, ...string[]]))
          .min(1)
          .default(["1h", "4h", "1d"])
          .describe(`Timeframes to analyze: ${INTERVALS.join(", ")}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, intervals }) => {
      const columns: string[] = [];
      for (const interval of intervals) {
        const suffix = INTERVAL_SUFFIX[interval];
        for (const col of TA_COLUMNS) columns.push(`${col}${suffix}`);
      }
      const res = await scan("global", {
        symbols: { tickers: [symbol], query: { types: [] } },
        columns,
      });
      if (res.data.length === 0) {
        throw new Error(
          `Symbol "${symbol}" not found. Use tradingview_search_symbols to find the correct ` +
            `"EXCHANGE:SYMBOL" ticker.`
        );
      }
      const values = res.data[0].d;
      const byInterval: Record<string, Record<string, unknown>> = {};
      intervals.forEach((interval, idx) => {
        const offset = idx * TA_COLUMNS.length;
        const indicators: Record<string, unknown> = {};
        TA_COLUMNS.forEach((col, i) => {
          indicators[col] = values[offset + i] ?? null;
        });
        byInterval[interval] = {
          summary: {
            overall: ratingText(indicators["Recommend.All"] as number),
            moving_averages: ratingText(indicators["Recommend.MA"] as number),
            oscillators: ratingText(indicators["Recommend.Other"] as number),
          },
          indicators,
        };
      });
      const structured = { symbol, analysis: byInterval };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  server.registerTool(
    "tradingview_scan_market",
    {
      title: "Screen a TradingView market",
      description:
        "Run TradingView's screener over a whole market: filter and rank symbols by any scanner " +
        'column. Examples: top US gainers (market "america", sort_by "change"), most-traded ' +
        'Binance pairs (market "crypto", filter exchange equal BINANCE, sort_by "volume"), ' +
        'oversold large caps (filter RSI less 30 and market_cap_basic greater 1e10). Common ' +
        "columns: name, description, close, change, volume, market_cap_basic, RSI, " +
        "Recommend.All, price_earnings_ttm, Perf.W, Perf.1M, Perf.YTD, sector, exchange.",
      inputSchema: {
        market: z
          .string()
          .default("america")
          .describe(
            'Market to scan: "america", "crypto", "forex", "futures", "bonds", "cfd", or a ' +
              'country like "germany", "japan", "india", "uk", "brazil"'
          ),
        filters: z
          .array(
            z.object({
              left: z.string().describe('Column to filter on, e.g. "RSI", "exchange", "market_cap_basic"'),
              operation: z
                .enum([
                  "greater",
                  "less",
                  "egreater",
                  "eless",
                  "equal",
                  "nequal",
                  "in_range",
                  "not_in_range",
                  "match",
                ])
                .describe("Comparison operator"),
              right: z
                .union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))])
                .describe("Value to compare against (array for in_range)"),
            })
          )
          .optional()
          .describe("Filter conditions, all must match"),
        sort_by: z.string().default("volume").describe('Column to sort by, e.g. "change", "volume", "market_cap_basic"'),
        sort_order: z.enum(["asc", "desc"]).default("desc"),
        columns: z
          .array(z.string())
          .optional()
          .describe("Columns to return; defaults to name, description, close, change, volume, market_cap_basic, RSI, Recommend.All"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max rows to return"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ market, filters, sort_by, sort_order, columns, limit }) => {
      const cols = columns ?? [
        "name",
        "description",
        "close",
        "change",
        "volume",
        "market_cap_basic",
        "RSI",
        "Recommend.All",
      ];
      const res = await scan(market, {
        filter: filters as ScanFilter[] | undefined,
        columns: cols,
        sort: { sortBy: sort_by, sortOrder: sort_order },
        range: [0, limit],
      });
      const structured = {
        total_matches: res.totalCount,
        returned: res.data.length,
        rows: rowsToObjects(cols, res.data),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  return server;
}

async function runStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("tradingview-mcp: running on stdio");
}

async function runHttp(port: number) {
  const httpServer = createHttpServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "Not found. POST MCP requests to /mcp" })
      );
      return;
    }
    // Stateless mode: a fresh server/transport pair per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  httpServer.listen(port, () => {
    console.error(`tradingview-mcp: streamable HTTP listening on http://localhost:${port}/mcp`);
  });
}

const args = process.argv.slice(2);
if (args.includes("--http")) {
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 3810);
  runHttp(port);
} else {
  runStdio().catch((err) => {
    console.error("tradingview-mcp fatal error:", err);
    process.exit(1);
  });
}
