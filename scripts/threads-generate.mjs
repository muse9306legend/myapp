// Writes Threads posts with Claude and adds them to posts/queue.json.
// Env: ANTHROPIC_API_KEY, TARGET_DATE (YYYY-MM-DD, KST; default tomorrow), TOPIC (optional hint)
import { readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const QUEUE_FILE = process.env.QUEUE_FILE || "posts/queue.json";
const MAX_LEN = 500;

const [brand, rules, config, queue] = await Promise.all([
  readFile("brand/BRAND.md", "utf8"),
  readFile("brand/threads/RULES.md", "utf8"),
  readFile("brand/threads/config.json", "utf8").then(JSON.parse),
  readFile(QUEUE_FILE, "utf8").then(JSON.parse),
]);

const kstToday = new Date(Date.now() + 9 * 3600 * 1000);
kstToday.setUTCDate(kstToday.getUTCDate() + 1);
const date = process.env.TARGET_DATE || kstToday.toISOString().slice(0, 10);

const taken = new Set(queue.posts.map((p) => Date.parse(p.at)));
const slots = config.times
  .map((t) => `${date}T${t}:00+09:00`)
  .filter((at) => !taken.has(Date.parse(at)));

if (!slots.length) {
  console.log(`${date}: every time slot already has a post.`);
  process.exit(0);
}

const recent = queue.posts
  .filter((p) => p.status !== "failed")
  .slice(-20)
  .map((p, i) => `${i + 1}. ${p.text.replace(/\n+/g, " ")}`)
  .join("\n");

const topics = [process.env.TOPIC, ...(config.topics || [])].filter(Boolean);

const kw = config.keywords || { min_per_post: 0, identity: [], search: [] };
const allKeywords = [...(kw.identity || []), ...(kw.search || [])];
const keywordCheck = (text) => {
  const found = allKeywords.filter((k) => text.includes(k));
  const hasIdentity = !(kw.identity || []).length || (kw.identity || []).some((k) => text.includes(k));
  return { found, ok: found.length >= (kw.min_per_post || 0) && hasIdentity };
};

const system = `You write Threads posts in Korean for the account described below.
Follow the brand guide and the Threads rules exactly. Every post must be at most ${MAX_LEN} characters.
Write as the account owner; do not invent statistics, news, or personal results that are not in the guide.

<brand_guide>
${brand}
</brand_guide>

<threads_rules>
${rules}
</threads_rules>

<keywords>
Identity keywords (every post must contain at least one, written exactly as listed): ${(kw.identity || []).join(", ")}
Search keywords: ${(kw.search || []).join(", ")}
Every post must contain at least ${kw.min_per_post || 0} keywords in total from these two lists, written exactly as listed,
with at least one of them in the first two lines. Weave them into natural sentences; never list them.
</keywords>`;

const user = `${date}에 올릴 Threads 글 ${slots.length}개를 써 주세요.
글끼리 주제와 형식이 겹치지 않게 해 주세요.
${topics.length ? `\n이번에 다룰 주제 힌트:\n${topics.map((t) => `- ${t}`).join("\n")}\n` : ""}
최근에 쓴 글과 겹치지 않게 해 주세요:
${recent || "(아직 없음)"}`;

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
            posts: {
              type: "array",
              items: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          },
          required: ["posts"],
          additionalProperties: false,
        },
      },
    },
    system,
    messages: [{ role: "user", content: user }],
  });
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("ANTHROPIC_API_KEY is missing or invalid.");
  } else if (error instanceof Anthropic.RateLimitError) {
    console.error("Rate limited by the Claude API; try again later.");
  } else if (error instanceof Anthropic.APIError) {
    console.error(`Claude API error ${error.status}: ${error.message}`);
  } else {
    throw error;
  }
  process.exit(1);
}

if (response.stop_reason === "refusal") {
  console.error(`Claude declined: ${response.stop_details?.explanation || "no details"}`);
  process.exit(1);
}
if (response.stop_reason === "max_tokens") {
  console.error("Response was cut off (max_tokens).");
  process.exit(1);
}

const json = response.content.find((b) => b.type === "text")?.text;
const { posts } = JSON.parse(json);

posts.slice(0, slots.length).forEach(({ text }, i) => {
  const clean = text.trim();
  const tooLong = [...clean].length > MAX_LEN;
  const { found, ok: keywordsOk } = keywordCheck(clean);
  const entry = {
    at: slots[i],
    text: clean,
    status: tooLong || !keywordsOk || config.require_approval ? "draft" : "pending",
    source: "ai",
    keywords: found,
  };
  const problems = [];
  if (tooLong) problems.push(`${MAX_LEN}자를 넘어서 줄여야 해요`);
  if (!keywordsOk) problems.push(`키워드가 부족해요 (찾은 것: ${found.join(", ") || "없음"})`);
  if (problems.length) entry.error = problems.join(" / ");
  queue.posts.push(entry);
  console.log(`+ [${entry.status}] ${slots[i]} [${found.join(", ")}] ${clean.slice(0, 30).replace(/\n/g, " ")}…`);
});

queue.posts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
console.log(`Model: ${response.model}, tokens in/out: ${response.usage.input_tokens}/${response.usage.output_tokens}`);
