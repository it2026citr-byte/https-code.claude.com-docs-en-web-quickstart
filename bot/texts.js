import { esc } from "./telegram.js";
import { plural } from "./journal.js";
import { fmtPrice } from "./format.js";
import { PARAMS, GROUPS, paramsOf, num, fmtVal, reportHourUtc } from "./runtime.js";

/**
 * Вёрстка сообщений и клавиатур.
 *
 * Здесь только то, что превращает данные в текст: ни запросов к бирже,
 * ни записи в базу, ни отправки в Telegram. Раньше всё это жило в
 * index.js вперемешку с тактами и обработчиками команд, и файл разросся
 * до полутора тысяч строк — там и прятались ошибки вроде /del, который
 * забывал зоны. Разделение по принципу «считает» и «показывает»
 * позволяет читать вёрстку, не держа в голове работу с рынком.
 */

// --- клавиатуры -----------------------------------------------------------
export const TAKE_KB = (id) => [[
  { text: "✅ Взял", callback_data: `take:${id}` },
  { text: "🚫 Пропустил", callback_data: `skip:${id}` },
]];


export const ACCESS_KB = (id) => [[
  { text: "✅ Разрешить", callback_data: `grant:${id}` },
  { text: "🚫 Отказать", callback_data: `deny:${id}` },
]];

// --- мелочи ---------------------------------------------------------------
export const rTxt = (r) => `${r > 0 ? "+" : ""}${r.toFixed(2)}R`;

// --- настройки ------------------------------------------------------------
const HINT = {
  рынок: "Чем ниже порог оборота, тем больше пар и тем хуже исполнение: " +
         "на неликвиде проскальзывание съедает выигрыш. Монеты из /coins " +
         "сканируются всегда, независимо от оборота.",
  сделки: "Чем раньше стоп уходит в безубыток, тем меньше убыточных сделок " +
          "и тем меньше прибыль. Каждые пять процентов убыточных стоят " +
          "примерно пятую часть дохода.",
  ритм: "Правка применяется со следующего такта, перезапускать не нужно.",
};

export function settingsView(g) {
  const rows = paramsOf(g).map(k => `<b>${PARAMS[k].title}:</b> ${fmtVal(k)}`);
  const extra = g === "отчёты"
    ? `Дневной отчёт уходит в ${String(reportHourUtc()).padStart(2, "0")}:00 UTC.`
    : "";
  return [`⚙️ <b>${GROUPS[g]}</b>`, "", ...rows, "",
          `<i>${extra} ${HINT[g] ?? ""}</i>`].join("\n");
}

function optLabel(key, v) {
  if (key === "tz") return `+${v}`;
  if (key === "report_hour") return `${v}:00`;
  if (key === "only_list") return v ? "только список" : "оборот + список";
  if (key === "be_at") return v >= 50 ? "на цели" : `${(v / 100).toFixed(2)}R`;
  return v === 0 ? "выкл" : `${v}`;
}

export function settingsKeyboard(g) {
  const kb = [];
  for (const key of paramsOf(g)) {
    const p = PARAMS[key], cur = num(key);
    kb.push([{ text: `— ${p.title} —`, callback_data: "noop" }]);
    kb.push(p.opts.map(v => ({
      text: (v === cur ? "• " : "") + optLabel(key, v),
      callback_data: `cfg:${key}:${v}:${g}`,
    })));
  }
  kb.push(Object.keys(GROUPS).map(k => ({
    text: (k === g ? "· " : "") + GROUPS[k].split(" ")[0],
    callback_data: `sec:${k}`,
  })));
  return kb;
}

// --- список монет ---------------------------------------------------------
const sig = (n) => `${n} ${plural(n, ["сигнал", "сигнала", "сигналов"])}`;
const prof = (n) => `${n} ${plural(n, ["прибыльный", "прибыльных", "прибыльных"])}`;

const TF_RU = { "5m": "5 мин", "15m": "15 мин", "1h": "1 час", "4h": "4 часа" };

export function analysisText(symbol, res) {
  const good = res.filter(r => !r.short);
  const age = res[0]?.age ?? 0;
  const young = res.some(r => r.native === false);

  const lines = res.map(r => {
    const tf = `<i>${TF_RU[r.tf] ?? r.tf}</i>`;
    if (r.short)
      return `▫️ <b>${r.id}</b> · ${tf}\n   <i>мало истории — ${r.bars ?? 0} свечей</i>`;
    const pct = r.n ? Math.round(r.win / r.n * 100) : 0;
    const mark = r.n === 0 ? "▫️" : r.avgR > 0 ? "✅" : "🔻";
    return `${mark} <b>${r.id}</b> · ${tf}\n` +
      `   ${sig(r.n)} · ${prof(r.win)} (${pct}%) · стопов ${r.stops}\n` +
      `   <i>ср. ${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}R · ${r.perWeek.toFixed(1)} в неделю</i>`;
  });

  const tot = good.reduce((a, r) => a + r.n, 0);
  const totWin = good.reduce((a, r) => a + r.win, 0);

  const tail = young ? [
    "",
    "<i>Монета моложе трёх месяцев, поэтому считалось на мелких свечах —",
    "на часе у неё вышло бы один-два сигнала, а это не статистика.",
    "С часовыми числами такие напрямую не сравнивай: стратегии настраивались",
    "на часе, и на мелких свечах преимущество другое.",
    "Живые сигналы всё равно пойдут на часе, когда история дорастёт.</i>",
  ] : [];

  return [
    `🔎 <b>${symbol}</b> · возраст ${age} дн`, "",
    ...lines, "",
    tot ? `<b>Итого ${sig(tot)}, ${prof(totWin)} (${Math.round(totWin / tot * 100)}%)</b>`
        : "<b>Сигналов за период не было</b>",
    ...tail,
  ].join("\n");
}

export function tuneText(rows) {
  if (!rows.length) return "";
  const lines = rows.map(r => {
    if (!r.chosen)
      return `▫️ <b>${r.id}</b> — умолчания\n   <i>${r.why ?? "подбор не дал выигрыша"}</i>`;
    const p = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ");
    return `🔧 <b>${r.id}</b>\n   <code>${p}</code>\n` +
      `   <i>на проверочной части: ${r.test.n} сигн, ${(r.test.rate*100).toFixed(0)}%, ` +
      `${r.test.sumR > 0 ? "+" : ""}${r.test.sumR.toFixed(1)}R ` +
      `против ${r.baseTest.sumR > 0 ? "+" : ""}${r.baseTest.sumR.toFixed(1)}R у умолчаний</i>`;
  });
  return ["", "", "<b>Подгонка под монету</b>", ...lines, "",
    "<i>Параметры подбирались на первых 70% истории, а сравнивались",
    "на последних 30%, которых подбор не видел. Принято только то,",
    "что выиграло на этой невидимой части — иначе это подгонка под шум.</i>",
  ].join("\n");
}

export function zonesText(symbol, zones, weak = []) {
  if (!zones.length) {
    const why = weak.length
      ? `рядом есть уровни, но ни один не подпёрт боковиком — ` +
        `только ${esc(weak[0].note)}. Такие на проверке не держали цену.`
      : `монета идёт без остановок, зацепиться не за что.`;
    return `\n\n🎯 <b>Зон нет</b> — ${why}\n` +
      `<i>Если видишь уровень сам: <code>/zone ${symbol} long ЦЕНА ЦЕНА</code></i>`;
  }
  const lines = zones.map(z =>
    `${z.side === "long" ? "🟢" : "🔴"} <b>${fmtPrice(z.lo)} — ${fmtPrice(z.hi)}</b> ` +
    `· ${z.away}% от цены\n   <i>${esc(z.note)}</i>`);
  return ["", "", `🎯 <b>Предлагаю зоны — ${zones.length}</b>`, ...lines, "",
    "<i>Это кандидаты, а не сигналы: на проверке построенный мной уровень",
    "оказался не лучше случайного, поэтому решаешь ты. Принять — в /zones,",
    `там же кнопка. Поправить: <code>/zone ${symbol} long ЦЕНА ЦЕНА</code>,`,
    "убрать: <code>/zone del НОМЕР</code></i>",
  ].join("\n");
}

// --- команды ----------------------------------------------------------------
export const HELP = `<b>Что я умею</b>

/status — режим, что вижу на рынке, открытые сделки
/focus — бросить всё и следить только за взятыми сделками
/scan — вернуться к поиску новых монет
/pulse — включить/выключить сводку по рынку
/settings — интервалы, монеты, риск, отчёты (четыре раздела)
/coins — мой список монет
/add ZECUSDT — разобрать историю за полгода и добавить
/tune ZECUSDT — заново подобрать параметры под монету
/zones — зоны интереса, за которыми слежу
/levels 2 — загрузить уровни из канала за 2 месяца
/charts 3 — принести разборы с графиками за 3 дня
/zone SOLUSDT long 81 82.1 — задать зону руками
/del ZECUSDT — убрать из списка

/positions — открытые сделки, текущий результат, закрыть вручную

<b>Журнал</b>
/results — итоги закрытых сигналов за сегодня
/log — итоги месяца плюс выгрузка файлами
/stats — статистика за всё время
/users — кто имеет доступ, выдать или отозвать
/help — это сообщение

<i>Telegram понимает только латиницу в командах, но я отзываюсь и на русские:
/статус /фокус /скан /пульс /настройки /монеты /сделки /итоги /журнал /стата /доступ /помощь</i>

<i>Сигналы приходят карточкой с кнопками «Взял» и «Пропустил».
По взятой сделке вся история — ниткой ответов под карточкой:
цели, перенос стопа в безубыток, слом стратегии, закрытие.</i>`;

