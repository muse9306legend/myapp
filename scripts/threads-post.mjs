// Publishes due posts from posts/queue.json to Threads.
// Env: THREADS_ACCESS_TOKEN (required unless DRY_RUN=1), QUEUE_FILE, DRY_RUN
import { readFile, writeFile } from "node:fs/promises";

const API = "https://graph.threads.net/v1.0";
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const QUEUE_FILE = process.env.QUEUE_FILE || "posts/queue.json";
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_LEN = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === "GET" ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, method === "GET" ? {} : { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`${method} ${path} → ${res.status} ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

async function waitUntilReady(containerId, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const { status, error_message } = await api("GET", `/${containerId}`, { fields: "status,error_message" });
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") throw new Error(`container ${status}: ${error_message || ""}`);
    await sleep(5000);
  }
  throw new Error(`container not ready after ${tries * 5}s`);
}

async function publish(post) {
  const params = { media_type: "TEXT", text: post.text };
  if (post.image_url) Object.assign(params, { media_type: "IMAGE", image_url: post.image_url });
  if (post.video_url) Object.assign(params, { media_type: "VIDEO", video_url: post.video_url });
  if (post.reply_to_id) params.reply_to_id = post.reply_to_id;

  const { id: containerId } = await api("POST", "/me/threads", params);
  await waitUntilReady(containerId, post.video_url ? 60 : 12);
  const { id } = await api("POST", "/me/threads_publish", { creation_id: containerId });
  const { permalink } = await api("GET", `/${id}`, { fields: "permalink" }).catch(() => ({}));
  return { id, permalink };
}

if (DRY_RUN && TOKEN) {
  try {
    const me = await api("GET", "/me", { fields: "username" });
    console.log(`Token OK: connected to @${me.username}`);
  } catch (err) {
    console.error(`Token check failed: ${err.message}`);
    process.exit(1);
  }
}

const queue = JSON.parse(await readFile(QUEUE_FILE, "utf8"));
const now = Date.now();
const due = queue.posts.filter((p) => p.status === "pending" && Date.parse(p.at) <= now);

if (!due.length) {
  console.log("No posts due.");
  process.exit(0);
}
if (!TOKEN && !DRY_RUN) {
  console.error("THREADS_ACCESS_TOKEN is not set.");
  process.exit(1);
}

// Daily cap on replies to other people's posts (brand/threads/config.json → replies.max_per_day).
const config = JSON.parse(await readFile("brand/threads/config.json", "utf8").catch(() => "{}"));
const maxRepliesPerDay = config.replies?.max_per_day ?? 10;
const kstDay = (iso) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);
const today = kstDay(new Date().toISOString());
let repliesToday = queue.posts.filter(
  (p) => p.reply_to_id && p.status === "published" && p.published_at && kstDay(p.published_at) === today,
).length;

let failed = 0;
for (const post of due) {
  if (post.reply_to_id && repliesToday >= maxRepliesPerDay) {
    console.log(`Reply limit (${maxRepliesPerDay}/day) reached; leaving the rest for tomorrow.`);
    break;
  }
  const label = `[${post.at}] ${post.text.slice(0, 30).replace(/\n/g, " ")}…`;
  if ([...post.text].length > MAX_LEN) {
    post.status = "failed";
    post.error = `text exceeds ${MAX_LEN} characters`;
    console.error(`✗ ${label} ${post.error}`);
    failed++;
    continue;
  }
  if (DRY_RUN) {
    console.log(`(dry run) would publish ${label}`);
    continue;
  }
  try {
    const { id, permalink } = await publish(post);
    Object.assign(post, { status: "published", published_at: new Date().toISOString(), threads_id: id, permalink });
    if (post.reply_to_id) repliesToday++;
    delete post.error;
    console.log(`✓ ${label} ${permalink || id}`);
  } catch (err) {
    post.attempts = (post.attempts || 0) + 1;
    post.error = err.message;
    if (post.attempts >= 3) post.status = "failed";
    console.error(`✗ ${label} ${err.message}`);
    failed++;
  }
  await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
}

if (!DRY_RUN) await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
process.exit(failed ? 1 : 0);
