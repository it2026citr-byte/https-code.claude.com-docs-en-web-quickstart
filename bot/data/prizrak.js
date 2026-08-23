import { log } from "../config.js";

/**
 * Разбор публичного канала с уровнями.
 *
 * Канал открытый, поэтому берём его веб-версию t.me/s/<канал> —
 * ни ключей, ни входа в аккаунт не нужно. Страница отдаёт двадцатку
 * постов, дальше листаем параметром before по номеру поста.
 *
 * Зачем это боту: автор отбирает уровни руками, и проверка показала,
 * что механически такой отбор не воспроизводится. Значит проще взять
 * готовый — а сторожить цену у уровня бот умеет лучше человека.
 */

const CH = "Prizrak_trade";
const NUM = "\\d+[.,]?\\d*";
const DASH = "[-–—−]";

/** Одна страница канала. */
async function page(before) {
  const url = `https://t.me/s/${CH}` + (before ? `?before=${before}` : "");
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`канал ответил ${r.status}`);
  return r.text();
}

const unescape = (s) => s
  .replace(/<br\s*\/?>/g, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .trim();

function parsePage(html) {
  const out = [];
  const re = /data-post="[^/]+\/(\d+)"([\s\S]*?)(?=data-post="|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const id = Number(m[1]), block = m[2];
    const t = /datetime="([^"]+)"/.exec(block);
    const body = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);

    // Картинки поста: у веб-версии это фон блока с фотографией.
    // Эмодзи-иконки лежат на telegram.org и сюда не попадают.
    const photos = [...block.matchAll(/background-image:url\('(https:\/\/cdn[^']+)'\)/g)]
      .map(x => x[1])
      .filter(u => /\.(jpg|jpeg|png|webp)/i.test(u));

    if (!body && !photos.length) continue;
    out.push({ id, date: t ? t[1] : null,
               text: body ? unescape(body[1]) : "",
               photos: [...new Set(photos)] });
  }
  return out;
}

/** Посты за последние months месяцев. */
export async function posts(months = 2, maxPages = 60) {
  const since = Date.now() - months * 30 * 86_400_000;
  const seen = new Set(), all = [];
  let before = null;
  for (let p = 0; p < maxPages; p++) {
    let got;
    try { got = parsePage(await page(before)); } catch (e) { log(`канал: ${e.message}`); break; }
    const fresh = got.filter(x => !seen.has(x.id));
    if (!fresh.length) break;
    for (const x of fresh) { seen.add(x.id); all.push(x); }
    before = Math.min(...got.map(x => x.id));
    // Дошли до нужной глубины — дальше листать незачем.
    const oldest = Math.min(...all.map(x => Date.parse(x.date) || Infinity));
    if (oldest < since) break;
  }
  return all
    .filter(x => (Date.parse(x.date) || 0) >= since)
    .sort((a, b) => a.id - b.id);
}

/**
 * Уровни из текста поста.
 *
 * Формулировки в канале плавают, поэтому ловим по признаку «слово про
 * зону, затем два числа через тире». Направление берём не из слов —
 * оно там бывает и в рассуждении, — а из положения зоны относительно
 * цены: ниже цены значит лонг, выше значит шорт. Так надёжнее.
 */
export function levels(list) {
  const rx = new RegExp(
    "(Диапазон[^:\\n]{0,40}|BUY[^:\\n]{0,20}|SHORT[^:\\n]{0,20}|LONG[^:\\n]{0,20}|" +
    "Лонг[ -]?зона[^:\\n]{0,30}|Шорт[ -]?зона[^:\\n]{0,30}|зона[^:\\n]{0,30})" +
    "\\s*[:\\-–]?\\s*(" + NUM + ")\\s*" + DASH + "\\s*(" + NUM + ")", "gi");
  const f = (x) => Number(String(x).replace(",", "."));
  const rows = [];
  for (const p of list) {
    // Тикеры с их местом в тексте: в обзорах их несколько, и зона
    // относится к ближайшему заголовку слева, а не к первому в посте.
    // Без этого зоны по ETH уезжают под тикер BTC.
    const tags = [...p.text.matchAll(/#([A-Z0-9]{2,12})\b/g)]
      .map(x => ({ at: x.index, sym: x[1] }));
    if (!tags.length) continue;
    let m;
    rx.lastIndex = 0;
    while ((m = rx.exec(p.text))) {
      const a = f(m[2]), b = f(m[3]);
      if (!(a > 0) || !(b > 0)) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      // Слишком широкий «диапазон» — это не зона, а пересказ движения.
      if (hi / lo > 1.5) continue;
      // Какой монете принадлежит зона, по тексту не понять: в обзорах
      // тикеры стоят общим заголовком, а разборы идут подряд. Поэтому
      // отдаём все тикеры поста, а выбор оставляем на цену — зона
      // относится к той монете, рядом с чьей ценой она находится.
      let near = tags[0].sym;
      for (const t of tags) { if (t.at < m.index) near = t.sym; else break; }
      rows.push({ postId: p.id, date: p.date, pair: near,
                  pairs: [...new Set(tags.map(t => t.sym))],
                  label: m[1].trim().slice(0, 40), lo, hi });
    }
  }
  return rows;
}

/**
 * Посты с картинками — те самые разборы, где уровни нарисованы,
 * а не написаны. Текстом их не взять, поэтому бот просто приносит
 * картинку в чат, а уровень с неё снимает человек.
 */
export function charts(list) {
  const out = [];
  for (const p of list) {
    if (!p.photos?.length) continue;
    const tags = [...new Set([...p.text.matchAll(/#([A-Z0-9]{2,12})\b/g)].map(x => x[1]))];
    // Первая строка поста — обычно заголовок разбора.
    const head = p.text.split("\n").find(x => x.trim().length > 3)?.trim() ?? "";
    out.push({ postId: p.id, date: p.date, tags, head: head.slice(0, 120),
               photos: p.photos, link: `https://t.me/${CH}/${p.id}` });
  }
  return out;
}

log("разбор канала уровней подключён");
