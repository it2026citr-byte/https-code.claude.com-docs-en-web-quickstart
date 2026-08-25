import { cfg, log } from "./config.js";
import { getSetting, setSetting, activeUsers } from "./db.js";

const API = `https://api.telegram.org/bot${cfg.token}`;

export async function api(method, payload = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({ ok: false, description: "не JSON" }));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}

export const esc = (s) => String(s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
    // Карточку могли удалить — тогда шлём обычным сообщением, а не теряем событие.
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
 * Картинка по ссылке: Telegram скачивает её сам, нам качать не нужно.
 * Если ссылка почему-то не берётся, отправляем подпись текстом —
 * потерять разбор хуже, чем показать его без картинки.
 */
export async function sendPhoto(chatId, url, caption = "") {
  try {
    return await api("sendPhoto", {
      chat_id: chatId, photo: url, caption, parse_mode: "HTML",
    });
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
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
    fd.append("document", new Blob([buf]), basename(path));
    const res = await fetch(`${API}/sendDocument`, { method: "POST", body: fd });
    const j = await res.json();
    if (!j.ok) throw new Error(j.description);
    return j.result;
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
