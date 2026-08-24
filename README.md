# tradingview-mcp

MCP-сервер, который подключает Claude к рыночным данным TradingView. Использует публичные (без авторизации) эндпоинты TradingView — API-ключ не нужен.

An MCP server that connects Claude to TradingView market data via TradingView's public endpoints. No API key required.

> **Раздел «[ИИ и боты](ИИ-и-боты/)»** — торговый бот, стратегии для
> TradingView, сканер MEXC и накопленные знания по разбору сигнальной системы.
> Оглавление: [`ИИ-и-боты/README.md`](ИИ-и-боты/README.md).

## Инструменты / Tools

| Инструмент | Что делает |
|---|---|
| `tradingview_search_symbols` | Поиск тикеров по названию, символу, ISIN или CUSIP (акции, крипта, форекс, фьючерсы, индексы) |
| `tradingview_get_quotes` | Котировки до 50 символов за раз: цена, изменение %, OHLC, объём, капитализация, P/E |
| `tradingview_get_technical_analysis` | Сводка теханализа как на странице «Technicals» TradingView: рейтинг Buy/Sell/Neutral + RSI, MACD, Stochastic, ADX, EMA/SMA — на таймфреймах от 1m до 1M |
| `tradingview_scan_market` | Скринер: фильтрация и сортировка целого рынка (например, топ растущих акций США, самые торгуемые пары Binance, перепроданные бумаги с RSI < 30) |

## Установка / Setup

```bash
git clone <this-repo>
cd tradingview-mcp
npm install
npm run build
```

### Подключение к Claude Code (CLI / desktop)

```bash
claude mcp add tradingview -- node /absolute/path/to/tradingview-mcp/dist/index.js
```

Или добавьте в `.mcp.json` проекта:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/dist/index.js"]
    }
  }
}
```

### Подключение к Claude Desktop

В `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/dist/index.js"]
    }
  }
}
```

### Подключение к claude.ai (веб) как custom connector

Для веб-версии нужен публично доступный HTTP-сервер. Запустите:

```bash
node dist/index.js --http --port 3810
```

Сервер поднимет streamable HTTP endpoint на `http://localhost:3810/mcp`. Разместите его на хостинге (или пробросьте туннелем, например `cloudflared`/`ngrok`) и добавьте URL в **Settings → Connectors → Add custom connector** на claude.ai.

## Примеры запросов к Claude

- «Найди тикер Сбербанка и покажи котировку»
- «Какой теханализ по BTCUSDT на 1h и 4h?»
- «Покажи топ-10 акций США по росту за сегодня с капитализацией больше $1 млрд»
- «Какие пары на Binance сейчас самые торгуемые?»

## Примечания

- Используются неофициальные публичные эндпоинты TradingView (`scanner.tradingview.com`, `symbol-search.tradingview.com`) — те же, что открывает сайт tradingview.com. Они могут измениться без предупреждения.
- Данные только на чтение; сервер не совершает сделок и не требует аккаунта TradingView.
- Данные по некоторым биржам могут отдаваться с задержкой (как и на самом сайте без подписки).
