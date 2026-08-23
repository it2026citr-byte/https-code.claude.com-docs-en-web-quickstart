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
export async function sendLong(chatId, text, keyboard = null) {
  const LIMIT = 3800;
  if (text.length <= LIMIT) return send(chatId, text, keyboard);
  const parts = [];
  let buf = "";
  for (const block of text.split("\n\n")) {
    if ((buf + "\n\n" + block).length > LIMIT && buf) { parts.push(buf); buf = block; }
    else buf = buf ? buf + "\n\n" + block : block;
  }
  if (buf) parts.push(buf);
  let last = null;
  for (let i = 0; i < parts.length; i++)
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
