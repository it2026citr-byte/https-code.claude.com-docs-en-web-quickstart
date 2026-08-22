import { DatabaseSync } from "node:sqlite";
import { cfg } from "./config.js";

export const db = new DatabaseSync(cfg.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  chat_id   INTEGER PRIMARY KEY,
  username  TEXT,
  joined_at INTEGER,
  active    INTEGER DEFAULT 1
);

-- Сигнал: то, что предложила стратегия. Ещё не сделка.
CREATE TABLE IF NOT EXISTS signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy   TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL,          -- long | short
  tf         TEXT NOT NULL,
  entry      REAL NOT NULL,
  sl         REAL NOT NULL,
  targets    TEXT NOT NULL,          -- JSON-массив
  reason     TEXT,
  created_at INTEGER NOT NULL,
  bar_time   INTEGER NOT NULL,       -- время бара, на котором родился сигнал
  status     TEXT NOT NULL DEFAULT 'new'   -- new | taken | skipped | expired
);
CREATE UNIQUE INDEX IF NOT EXISTS signals_uniq
  ON signals(strategy, symbol, side, bar_time);

-- Позиция: сигнал, который пользователь взял в работу.
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   INTEGER,
  chat_id     INTEGER NOT NULL,
  strategy    TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,
  tf          TEXT NOT NULL,
  entry       REAL NOT NULL,
  sl          REAL NOT NULL,
  sl_current  REAL NOT NULL,         -- подтягивается в безубыток
  targets     TEXT NOT NULL,
  tp_hit      INTEGER DEFAULT 0,
  opened_at   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | closed
  closed_at   INTEGER,
  close_price REAL,
  close_reason TEXT,
  r_result    REAL
);

-- Тревоги: чтобы не слать одно и то же дважды.
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  level       TEXT NOT NULL,         -- yellow | red | target | stop | info
  reason      TEXT NOT NULL,
  text        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_uniq
  ON alerts(position_id, level, reason);

-- Журнал: append-only лента всего, что произошло. Основа месячных отчётов.
CREATE TABLE IF NOT EXISTS journal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  month      TEXT NOT NULL,          -- '2026-08'
  kind       TEXT NOT NULL,          -- signal|taken|skipped|target|stop|broken|closed|note
  strategy   TEXT,
  symbol     TEXT,
  side       TEXT,
  price      REAL,
  r_value    REAL,
  text       TEXT,
  detail     TEXT                    -- JSON, свободные поля
);
CREATE INDEX IF NOT EXISTS journal_month ON journal(month, ts);
CREATE INDEX IF NOT EXISTS journal_ts ON journal(ts);

-- Кеш свечей, чтобы не дёргать биржу лишний раз.
CREATE TABLE IF NOT EXISTS candles (
  symbol    TEXT NOT NULL,
  tf        TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (symbol, tf, open_time)
);
`);

// Миграция: у ранних баз нет колонок доступа.
{
  const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!cols.includes("role"))
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'pending'");
  if (!cols.includes("requested_at"))
    db.exec("ALTER TABLE users ADD COLUMN requested_at INTEGER");
  if (!cols.includes("first_name"))
    db.exec("ALTER TABLE users ADD COLUMN first_name TEXT");
}

{
  const cols = db.prepare("PRAGMA table_info(positions)").all().map(r => r.name);
  // id карточки сигнала: вся история по сделке уходит ответами на неё,
  // чтобы в чате получалась нитка, а не россыпь сообщений.
  if (!cols.includes("msg_id"))
    db.exec("ALTER TABLE positions ADD COLUMN msg_id INTEGER");
}

const _get = db.prepare("SELECT value FROM settings WHERE key = ?");
const _set = db.prepare(
  "INSERT INTO settings(key, value) VALUES(?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

export function getSetting(key, fallback = null) {
  const r = _get.get(key);
  return r === undefined ? fallback : r.value;
}
export function setSetting(key, value) {
  _set.run(key, String(value));
}
export function getJSON(key, fallback) {
  const v = getSetting(key);
  if (v === null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
export function setJSON(key, value) { setSetting(key, JSON.stringify(value)); }

export const now = () => Math.floor(Date.now() / 1000);

// --- пользователи -----------------------------------------------------------
export function upsertUser(chatId, username, firstName, role = null) {
  db.prepare(
    "INSERT INTO users(chat_id, username, first_name, joined_at, active, role, requested_at) " +
    "VALUES(?,?,?,?,1,?,?) " +
    "ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, " +
    "first_name = excluded.first_name, active = 1"
  ).run(chatId, username || "", firstName || "", now(), role || "pending", now());
}

export const getUser = (chatId) =>
  db.prepare("SELECT * FROM users WHERE chat_id = ?").get(chatId);

export const setRole = (chatId, role) =>
  db.prepare("UPDATE users SET role = ? WHERE chat_id = ?").run(role, chatId);

export const listUsers = () =>
  db.prepare("SELECT * FROM users ORDER BY joined_at").all();

/** Кому уходят сигналы: владелец и все, кого он допустил. */
export function activeUsers() {
  return db.prepare(
    "SELECT chat_id FROM users WHERE active = 1 AND role IN ('owner','approved')"
  ).all().map(r => r.chat_id);
}

// --- режим ------------------------------------------------------------------
export const MODE_SCAN = "scan";
export const MODE_FOCUS = "focus";
export const getMode = () => getSetting("mode", MODE_SCAN);
export const setMode = (m) => setSetting("mode", m);

export function openPositions(chatId = null) {
  return chatId === null
    ? db.prepare("SELECT * FROM positions WHERE status = 'open'").all()
    : db.prepare("SELECT * FROM positions WHERE status='open' AND chat_id=?").all(chatId);
}
