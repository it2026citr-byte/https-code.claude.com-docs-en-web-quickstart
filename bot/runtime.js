import { getSetting, setSetting } from "./db.js";
import { cfg } from "./config.js";

/**
 * Настройки, меняемые прямо из Telegram.
 *
 * Значения из config.js служат исходными: пока пользователь ничего не трогал,
 * работает то, что в файле. Как только тронул — решает база, и правка
 * переживает перезапуск.
 */
export const GROUPS = {
  ритм:    "Ритм работы",
  рынок:   "Какие монеты",
  сделки:  "Ведение сделки",
  отчёты:  "Отчёты и время",
};

export const PARAMS = {
  scan_min:    { g: "ритм", def: () => cfg.scanIntervalMin, opts: [5, 15, 30, 60, 240],
                 title: "Скан рынка",           unit: "мин" },
  pulse_min:   { g: "ритм", def: () => 0,                  opts: [0, 15, 30, 60, 180],
                 title: "Пульс рынка",          unit: "мин" },
  focus_sec:   { g: "ритм", def: () => cfg.focusIntervalSec, opts: [5, 10, 30, 60],
                 title: "Присмотр в фокусе",    unit: "сек" },
  watch_min:   { g: "ритм", def: () => cfg.normalWatchMin, opts: [1, 5, 15, 30],
                 title: "Присмотр вне фокуса",  unit: "мин" },
  report_hour: { g: "отчёты", def: () => 23,                 opts: [9, 12, 18, 21, 23],
                 title: "Час дневного отчёта",  unit: "ч" },
  // На каком ходе в свою сторону стоп уезжает в безубыток, в сотых долях R.
  // 50 — на первой цели, как было. Меньше — меньше убыточных сделок,
  // но и меньше прибыль: замер по 125 дням часовой истории показывает
  // 28%→23%→19%→13% убыточных при +0,161→+0,141→+0,113→+0,082R.
  be_at:       { g: "сделки", def: () => 50, opts: [50, 35, 25, 15],
                 title: "Безубыток на",         unit: "R" },
  top_pairs:   { g: "рынок", def: () => cfg.topByTurnover, opts: [50, 100, 200, 350, 500],
                 title: "Пар в работе, не более", unit: "" },
  min_turn_k:  { g: "рынок", def: () => cfg.minTurnoverUsd / 1000, opts: [1000, 500, 200, 100, 50],
                 title: "Порог оборота",         unit: "тыс $" },
  only_list:   { g: "рынок", def: () => 0, opts: [0, 1],
                 title: "Источник пар",         unit: "" },
  tz:          { g: "отчёты", def: () => 3,                  opts: [0, 1, 2, 3, 5, 7],
                 title: "Твой часовой пояс",    unit: "UTC+" },
};

export function num(key) {
  const p = PARAMS[key];
  const raw = getSetting(key);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? v : p.def();
}

export function setNum(key, value) {
  setSetting(key, String(value));
}

/** Час отчёта пользователь задаёт по своему времени, планировщик живёт в UTC. */
export const paramsOf = (g) =>
  Object.entries(PARAMS).filter(([, p]) => p.g === g).map(([k]) => k);

export const reportHourUtc = () => ((num("report_hour") - num("tz")) % 24 + 24) % 24;

export const fmtVal = (key) => {
  const p = PARAMS[key], v = num(key);
  if (key === "tz") return `UTC+${v}`;
  if (key === "only_list") return v ? "только мой список" : "оборот + мой список";
  if (key === "be_at") return v >= 50 ? "на первой цели" : `${(v / 100).toFixed(2)}R`;
  if (key === "top_pairs") return `до ${v} пар`;
  if (key === "min_turn_k") return v >= 1000 ? `от ${v / 1000} млн $` : `от ${v} тыс $`;
  if (key === "report_hour") return `${String(v).padStart(2, "0")}:00 по-твоему`;
  if (v === 0) return "выключен";
  return `каждые ${v} ${p.unit}`;
};
