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

export async function send(chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  try {
    return await api("sendMessage", payload);
  } catch (e) {
    log("не отправилось в", chatId, "—", e.message);
    return null;
  }
}

export async function broadcast(text, keyboard = null) {
  for (const id of activeUsers()) await send(id, text, keyboard);
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
