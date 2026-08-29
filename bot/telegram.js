import { cfg, log } from "./config.js";
import { getSetting, setSetting, activeUsers } from "./db.js";

const API = `https://api.telegram.org/bot${cfg.token}`;

export async function api(method, payload = {}) {
  // Таймаут обязателен: опрос апдейтов строго последовательный, и одно
  // повисшее соединение оставило бы бота глухим к командам на минуты.
  // Долгому опросу (getUpdates ждёт до payload.timeout секунд) даём
  // его срок плюс запас; остальным вызовам хватает тридцати секунд.
  const tmoMs = (Number(payload.timeout) || 0) * 1000 + 30_000;
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(tmoMs),
  });
  // Код ответа сохраняем: «не JSON (HTTP 502)» — это шлюз, который до
  // API не достучался, такой повторить безопасно; «не JSON (HTTP 200)»
  // — возможно, усечённый удачный ответ, такой повторять нельзя.
  const j = await res.json().catch(() => ({ ok: false, description: `не JSON (HTTP ${res.status})` }));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}

export const esc = (s) => String(s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Ошибки, после которых повтор безопасен: обрыв соединения, лимит
 * запросов (429 = «не принял»), шлюз не достучался до API (502/503).
 * Таймаута и «не JSON» здесь нет сознательно: и там и там сообщение
 * могло дойти — ответ просто не дочитался, — и повтор дал бы дубль.
 */
const RETRY_NET = /fetch failed|ECONN|EAI_AGAIN|socket|network|reset|EPIPE|Too Many Requests|Bad Gateway|Service Unavailable|не JSON \(HTTP 5\d\d\)/i;

export async function send(chatId, text, keyboard = null, replyTo = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  try {
    return await api("sendMessage", payload);
  } catch (e) {
    // Один повтор — только когда запрос ТОЧНО не дошёл (обрыв, 429).
    // Таймаут повторять нельзя: сообщение могло дойти, а ответ — нет,
    // повтор дал бы дубль. Повтор идёт тем же payload — нитка ответа
    // сохраняется; 429 называет срок сам («retry after N»), дольше
    // пяти секунд не ждём: опрос команд строго последовательный.
    if (RETRY_NET.test(e.message)) {
      const after = Number(/retry after (\d+)/i.exec(e.message)?.[1] ?? 0);
      if (after <= 5) {
        const waitMs = after > 0 ? after * 1000 : 2000;
        log(`сбой отправки, повторю через ${waitMs / 1000} с:`, e.message);
        await new Promise(r => setTimeout(r, waitMs));
        try { return await api("sendMessage", payload); }
        catch (e2) { e = e2; }
      }
    }
    // Карточку могли удалить — тогда шлём обычным сообщением, а не
    // теряем событие. Сюда же падает неудачный повтор с ниткой.
    if (replyTo) {
      log("ответ на", replyTo, "не прошёл, шлю отдельно:", e.message);
      return send(chatId, text, keyboard, null);
    }
    log("не отправилось в", chatId, "—", e.message);
    return null;
  }
}

/** Telegram режет сообщения на 4096 символах — бьём по карточкам. */
const LIMIT = 3800;

/**
 * Разбить текст так, чтобы каждый кусок влезал в сообщение.
 *
 * Три уровня, от бережного к грубому: по пустым строкам, затем по
 * обычным переводам строки, затем просто по длине. Раньше был только
 * первый, и сплошной текст без пустых строк не резался вовсе —
 * Telegram отвергал такое сообщение целиком, а человек не получал
 * ничего. Список зон по монете именно такой: строки идут подряд.
 */
function split(text) {
  if (text.length <= LIMIT) return [text];

  const glue = (blocks, sep) => {
    const out = [];
    let buf = "";
    for (const b of blocks) {
      if (buf && (buf + sep + b).length > LIMIT) { out.push(buf); buf = b; }
      else buf = buf ? buf + sep + b : b;
    }
    if (buf) out.push(buf);
    return out;
  };

  const hard = (s) => {
    const out = [];
    for (let i = 0; i < s.length; i += LIMIT) out.push(s.slice(i, i + LIMIT));
    return out;
  };

  return glue(text.split("\n\n"), "\n\n")
    .flatMap(p => p.length <= LIMIT ? [p] : glue(p.split("\n"), "\n"))
    .flatMap(p => p.length <= LIMIT ? [p] : hard(p));
}

export async function sendLong(chatId, text, keyboard = null) {
  const parts = split(text);
  let last = null;
  for (let i = 0; i < parts.length; i++)
    last = await send(chatId, parts[i], i === parts.length - 1 ? keyboard : null);
  return last;
}

/**
 * Заменить сообщение-заглушку («Строю зоны…») готовым ответом.
 *
 * Правка не умеет резать длинный текст: Telegram отвергает всё
 * сообщение целиком, заглушка остаётся висеть, и со стороны это
 * неотличимо от зависшего бота. Поэтому длинный ответ кладём в
 * заглушку первым куском, а остальное досылаем следом.
 */
export async function editLong(chatId, msgId, text, keyboard = null) {
  if (!msgId) return sendLong(chatId, text, keyboard);
  const parts = split(text);
  await editText(chatId, msgId, parts[0], parts.length === 1 ? keyboard : null);
  let last = null;
  for (let i = 1; i < parts.length; i++)
    last = await send(chatId, parts[i], i === parts.length - 1 ? keyboard : null);
  return last;
}

/**
 * Картинка по ссылке — в три попытки, от дешёвой к дорогой.
 *
 * Сначала отдаём Telegram саму ссылку: его серверы качают картинку
 * сами, нам трафика не нужно. Но у Telegram это периодически
 * срывается даже на живых ссылках (проверено на CDN предпросмотра
 * t.me: картинка отдаётся, а sendPhoto по URL отказывает). Поэтому
 * при отказе качаем байты сами и грузим их файлом. Подпись текстом —
 * только когда не вышло и это: потерять разбор хуже, чем показать
 * его без картинки.
 */
/** Загрузка байтами: общий низ для фото и файлов. */
async function apiUpload(method, field, blob, filename, { chat_id, caption }) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
  fd.append(field, blob, filename);
  const res = await fetch(`${API}/${method}`,
    { method: "POST", body: fd, signal: AbortSignal.timeout(60_000) });
  const j = await res.json().catch(() => ({ ok: false, description: "не JSON" }));
  if (!j.ok) throw new Error(j.description);
  return j.result;
}

/**
 * Отказы Telegram, при которых есть смысл скачать картинку самим:
 * его серверы не смогли забрать URL. Заблокированный бот, кривая
 * подпись или лимит запросов повтором байтами не лечатся — туда
 * не ходим, только зря удвоим трафик под ограничителем.
 */
// «photo» сюда нельзя: оно есть в каждом сообщении («Telegram sendPhoto: …»).
const URL_FETCH_FAIL = /url|http|webpage|content|identifier/i;

export async function sendPhoto(chatId, url, caption = "") {
  try {
    return await api("sendPhoto", {
      chat_id: chatId, photo: url, caption, parse_mode: "HTML",
    });
  } catch (e) {
    if (!URL_FETCH_FAIL.test(e.message)) {
      log("картинка не отправилась:", e.message);
      return send(chatId, caption + `\n<i>(картинка не загрузилась)</i>`);
    }
    log("картинка по ссылке не ушла, качаю сам:", e.message);
  }
  try {
    // Телефонный процесс маленький: и время, и размер ограничены жёстко.
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} при скачивании`);
    const len = Number(r.headers.get("content-length") || 0);
    if (len > 10 * 1024 * 1024) throw new Error(`слишком большая: ${len} байт`);
    const blob = await r.blob();
    if (blob.size > 10 * 1024 * 1024) throw new Error(`слишком большая: ${blob.size} байт`);
    log(`картинку скачал сам: ${blob.size} байт`);
    return await apiUpload("sendPhoto", "photo", blob, "chart.jpg",
                           { chat_id: chatId, caption });
  } catch (e) {
    log("картинка не отправилась:", e.message);
    return send(chatId, caption + `\n<i>(картинка не загрузилась)</i>`);
  }
}

/** Отправка файла — месячные выгрузки. */
export async function sendDoc(chatId, path, caption = "") {
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  try {
    const buf = await readFile(path);
    return await apiUpload("sendDocument", "document", new Blob([buf]),
                           basename(path), { chat_id: chatId, caption });
  } catch (e) {
    log("файл не ушёл:", e.message);
    return null;
  }
}

export async function broadcast(text, keyboard = null) {
  for (const id of activeUsers()) await sendLong(id, text, keyboard);
}

export async function broadcastDoc(path, caption = "") {
  for (const id of activeUsers()) await sendDoc(id, path, caption);
}

export async function editText(chatId, messageId, text, keyboard = null) {
  const payload = {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  try { return await api("editMessageText", payload); }
  catch (e) { log("правка не прошла:", e.message); return null; }
}

export async function answerCallback(id, text = "") {
  try { await api("answerCallbackQuery", { callback_query_id: id, text }); }
  catch { /* устаревшая кнопка — не беда */ }
}

// Длинный опрос. Смещение храним в базе, чтобы не переигрывать старое.
export async function startPolling({ onMessage, onCallback }) {
  let offset = Number(getSetting("tg_offset", "0"));
  log("опрос Telegram запущен");

  for (;;) {
    try {
      const updates = await api("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        setSetting("tg_offset", offset);
        try {
          if (u.message?.text) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
        } catch (e) {
          log("ошибка обработки апдейта:", e.message);
        }
      }
    } catch (e) {
      if (e.message.includes("409")) {
        log("ВНИМАНИЕ: запущен ещё один экземпляр бота. Останови лишний.");
      } else {
        log("опрос сорвался:", e.message);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
