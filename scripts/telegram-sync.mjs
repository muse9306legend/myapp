// Two-way Telegram bridge for the post queue, run on a schedule (no server).
// - Reads button presses (approve / reject) and text replies (edit) via getUpdates.
// - Sends new drafts with buttons, and a note when a post is published or fails.
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional: found from the first message
// and saved as a secret when GH_TOKEN is set), QUEUE_FILE, STATE_FILE, MODE (sync|notify)
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const QUEUE_FILE = process.env.QUEUE_FILE || "posts/queue.json";
const STATE_FILE = process.env.STATE_FILE || "posts/telegram-state.json";
const MODE = process.env.MODE || "sync";
const PAGE_URL = "https://muse9306legend.github.io/myapp/";

if (!TOKEN) {
  console.log("TELEGRAM_BOT_TOKEN not set; skipping Telegram.");
  process.exit(0);
}

async function tg(method, params, retried = false) {
  const res = await fetch(`${process.env.TELEGRAM_API || "https://api.telegram.org"}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  const wait = data.parameters?.retry_after;
  if (!data.ok && wait && wait <= 60 && !retried) {
    console.log(`${method}: rate limited, retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return tg(method, params, true);
  }
  if (!data.ok) {
    if (data.error_code === 409) console.error("Another program is reading this bot's messages. Use a separate bot for this automation.");
    throw new Error(`${method}: ${data.description || res.status}`);
  }
  return data.result;
}

const queue = JSON.parse(await readFile(QUEUE_FILE, "utf8"));
const state = JSON.parse(await readFile(STATE_FILE, "utf8").catch(() => "{}"));
let chatId = process.env.TELEGRAM_CHAT_ID || "";

const platformTag = (p) => (p.platform === "instagram" ? "[Instagram]" : p.platform === "blog" ? "[블로그]" : "[Threads]");
const kst = (iso) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const byId = (id) => queue.posts.find((p) => p.id === id);
const byMsg = (mid) => queue.posts.find((p) => p.tg_message_id === mid);

// ---- 1) read updates: buttons and edits
if (MODE === "sync") {
  const updates = await tg("getUpdates", { offset: (state.offset || 0) + 1, timeout: 0, allowed_updates: ["message", "callback_query"] });
  for (const u of updates) {
    state.offset = u.update_id;
    const msg = u.message || u.callback_query?.message;
    const fromChat = String(msg?.chat?.id || "");
    if (!chatId && fromChat) {
      chatId = fromChat;
      if (process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
        try {
          execFileSync("gh", ["secret", "set", "TELEGRAM_CHAT_ID", "--body", chatId, "--repo", process.env.GITHUB_REPOSITORY], { stdio: "inherit" });
          console.log("Saved TELEGRAM_CHAT_ID secret.");
        } catch (err) {
          console.error(`Could not save TELEGRAM_CHAT_ID: ${err.message}`);
        }
      }
      await tg("sendMessage", { chat_id: chatId, text: "✅ 커밍스톤 자동화와 연결됐어요. 새 초안과 게시 결과를 여기로 보낼게요." });
    }
    if (fromChat !== String(chatId)) continue; // ignore other chats

    if (u.callback_query) {
      const [action, id] = (u.callback_query.data || "").split(":");
      const post = byId(id);
      let note = "이미 처리된 항목이에요.";
      if (post && post.status === "draft") {
        if (action === "approve") {
          post.status = "pending";
          note = Date.parse(post.at) <= Date.now() ? "✅ 승인됨. 15분 안에 게시돼요." : `✅ 승인됨. ${kst(post.at)}에 게시돼요.`;
        } else if (action === "reject") {
          post.status = "rejected";
          note = "❌ 거절됨. 게시하지 않아요.";
        }
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await tg("sendMessage", { chat_id: chatId, text: note, reply_to_message_id: msg.message_id });
      }
      await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: note }).catch(() => {});
      continue;
    }

    // a text reply to a draft message replaces its text
    const replyTo = u.message?.reply_to_message?.message_id;
    const newText = (u.message?.text || "").trim();
    if (replyTo && newText) {
      const post = byMsg(replyTo);
      if (post && post.status === "draft") {
        post.text = newText;
        post.source = (post.source || "") + "+telegram-edit";
        delete post.error;
        await tg("sendMessage", {
          chat_id: chatId,
          text: `✏️ 수정했어요. 이대로 올릴까요?\n\n${newText}`,
          reply_to_message_id: u.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: "✅ 승인", callback_data: `approve:${post.id}` }, { text: "❌ 거절", callback_data: `reject:${post.id}` }]] },
        });
      }
    }
  }
}

// ---- 2) notify: new drafts, published, failed
if (chatId) {
  for (const post of queue.posts) {
    if (!post.id) post.id = randomBytes(4).toString("hex");

    if (post.status === "draft" && !post.tg_message_id) {
      const head = post.reply_to
        ? `${platformTag(post)} 답글 초안 · @${post.reply_to.username} 글에\n"${(post.reply_to.text || "").slice(0, 80)}…"\n${post.reply_to.permalink}`
        : `${platformTag(post)} 새 초안 · ${kst(post.at)} 게시 예정`;
      const warn = post.error ? `\n⚠️ ${post.error}` : "";
      const sent = await tg("sendMessage", {
        chat_id: chatId,
        text: `${head}${warn}\n\n${post.text}\n\n✏️ 고치려면 이 메시지에 '답장'으로 새 글을 보내세요.`,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: "✅ 승인", callback_data: `approve:${post.id}` }, { text: "❌ 거절", callback_data: `reject:${post.id}` }]] },
      });
      post.tg_message_id = sent.message_id;
    }

    if (post.status === "published" && !post.tg_published_notified) {
      await tg("sendMessage", { chat_id: chatId, text: `${platformTag(post)} 🎉 게시됐어요\n${post.permalink || ""}`, disable_web_page_preview: false });
      post.tg_published_notified = true;
    }
    if (post.status === "failed" && !post.tg_failed_notified) {
      await tg("sendMessage", { chat_id: chatId, text: `${platformTag(post)} ⚠️ 게시 실패: ${post.error || "원인 미상"}\n${PAGE_URL}` });
      post.tg_failed_notified = true;
    }
  }
} else {
  console.log("No chat yet. Send any message to the bot, then this will connect.");
}

await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
await writeFile(STATE_FILE, JSON.stringify({ offset: state.offset || 0 }, null, 2) + "\n");
console.log("Telegram sync done.");
