// Finds public Threads posts by keyword, reads their conversation, and asks
// Claude to draft thoughtful replies. Drafts go into posts/queue.json with
// reply_to_id and status "draft"; nothing is posted until a person approves.
// Env: THREADS_ACCESS_TOKEN, ANTHROPIC_API_KEY, KEYWORD, COUNT, QUEUE_FILE
import { readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const API = "https://graph.threads.net/v1.0";
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const KEYWORD = (process.env.KEYWORD || "").trim();
const COUNT = Math.min(Number(process.env.COUNT) || 3, 10);
const QUEUE_FILE = process.env.QUEUE_FILE || "posts/queue.json";
const MAX_REPLY_LEN = 300;
const ALLOW_OWN = process.env.ALLOW_OWN === "true";
const OWN_USERNAME = "comingstone.kr";

if (!TOKEN || !KEYWORD) {
  console.error("THREADS_ACCESS_TOKEN and KEYWORD are required.");
  process.exit(1);
}

async function get(path, params) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(`${API}${path}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`GET ${path} → ${res.status} ${data.error?.message || ""}`);
  return data;
}

const [brand, queue] = await Promise.all([
  readFile("brand/BRAND.md", "utf8"),
  readFile(QUEUE_FILE, "utf8").then(JSON.parse),
]);
const alreadyQueued = new Set(queue.posts.map((p) => p.reply_to_id).filter(Boolean));

// 1) keyword search (threads_keyword_search)
const found = await get("/keyword_search", {
  q: KEYWORD,
  search_type: "TOP",
  limit: "25",
  fields: "id,text,permalink,timestamp,username",
});
const candidates = (found.data || [])
  .filter((p) => p.text && !alreadyQueued.has(p.id))
  .slice(0, COUNT);

if (!candidates.length) {
  console.log(`No new posts to reply to for "${KEYWORD}".`);
  process.exit(0);
}

// 2) read each conversation (threads_read_replies)
for (const post of candidates) {
  try {
    const replies = await get(`/${post.id}/replies`, { fields: "text,username", limit: "5" });
    post.replies = (replies.data || []).map((r) => `@${r.username}: ${r.text}`);
  } catch (err) {
    post.replies = [];
    console.error(`Could not read replies for ${post.id}: ${err.message}`);
  }
}

// 3) draft replies with Claude
const system = `You write replies in Korean on Threads for the account described below.
Each reply must respond to what the other person actually wrote: empathize, add something useful, or ask a genuine question.
Do not sell, do not include links, prices, or calls to buy, and do not mention our products unless the post is directly about Bible-verse gifts or natural stone.
Keep each reply under ${MAX_REPLY_LEN} characters, warm and natural, at most one emoji.
If a post is sensitive (grief, conflict, politics, health) or unrelated to our account, set skip to true instead of replying.
${ALLOW_OWN
  ? `Posts by @${OWN_USERNAME} are our own. For those, write a short follow-up reply that continues the thread with one new concrete detail (a behind-the-scenes moment, a material detail, or a question to readers), never self-praise.`
  : `Posts by @${OWN_USERNAME} are our own; set skip to true for them.`}

<brand_guide>
${brand}
</brand_guide>`;

const user = candidates
  .map((p, i) => `<post index="${i}" author="@${p.username}">
${p.text}
${p.replies.length ? `<recent_replies>\n${p.replies.join("\n")}\n</recent_replies>` : ""}
</post>`)
  .join("\n\n");

const client = new Anthropic();
let response;
try {
  response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            replies: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer" },
                  skip: { type: "boolean" },
                  reason: { type: "string" },
                  text: { type: "string" },
                },
                required: ["index", "skip", "reason", "text"],
                additionalProperties: false,
              },
            },
          },
          required: ["replies"],
          additionalProperties: false,
        },
      },
    },
    system,
    messages: [{ role: "user", content: `다음 Threads 글마다 답글 초안을 써 주세요.\n\n${user}` }],
  });
} catch (error) {
  if (error instanceof Anthropic.APIError) {
    console.error(`Claude API error ${error.status}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
  console.error(`Claude stopped: ${response.stop_reason}`);
  process.exit(1);
}

const { replies } = JSON.parse(response.content.find((b) => b.type === "text").text);
const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + "+09:00";
let added = 0;
for (const r of replies) {
  const post = candidates[r.index];
  if (!post) continue;
  if (r.skip) {
    console.log(`- skip @${post.username}: ${r.reason}`);
    continue;
  }
  const text = r.text.trim();
  queue.posts.push({
    at: now,
    text,
    status: "draft",
    source: "ai-reply",
    reply_to_id: post.id,
    reply_to: { username: post.username, permalink: post.permalink, text: post.text.slice(0, 200) },
    ...([...text].length > MAX_REPLY_LEN ? { error: `${MAX_REPLY_LEN}자를 넘어서 줄여야 해요` } : {}),
  });
  added++;
  console.log(`+ draft reply to @${post.username}: ${text.slice(0, 40).replace(/\n/g, " ")}…`);
}

await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
console.log(`${added} reply drafts added. Approve by changing status to "pending".`);
