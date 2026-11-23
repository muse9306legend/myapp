// Searches public Threads posts by keyword and writes a summary table.
// Env: THREADS_ACCESS_TOKEN, KEYWORD, SEARCH_TYPE (TOP|RECENT), LIMIT
import { appendFile } from "node:fs/promises";

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const KEYWORD = (process.env.KEYWORD || "").trim();
const SEARCH_TYPE = process.env.SEARCH_TYPE === "RECENT" ? "RECENT" : "TOP";
const LIMIT = Math.min(Number(process.env.LIMIT) || 25, 100);

if (!TOKEN || !KEYWORD) {
  console.error("THREADS_ACCESS_TOKEN and KEYWORD are required.");
  process.exit(1);
}

const params = new URLSearchParams({
  q: KEYWORD,
  search_type: SEARCH_TYPE,
  limit: String(LIMIT),
  fields: "id,text,media_type,permalink,timestamp,username,has_replies",
  access_token: TOKEN,
});
let res, data;
for (const host of ["graph.threads.com", "graph.threads.net"]) {
  res = await fetch(`https://${host}/v1.0/keyword_search?${params}`);
  data = await res.json().catch(() => ({}));
  if (res.ok && !data.error) break;
  const e = data.error || {};
  console.error(`${host}: ${res.status} ${e.message || JSON.stringify(data)} (type=${e.type}, code=${e.code}, subcode=${e.error_subcode}, trace=${e.fbtrace_id})`);
}
if (!res.ok || data.error) {
  const me = await fetch(`https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(TOKEN)}`)
    .then((r) => r.json()).catch(() => ({}));
  console.error(`Token belongs to: ${me.username ? "@" + me.username : JSON.stringify(me)}`);
  console.error("Search failed on both hosts.");
  process.exit(1);
}

const posts = data.data || [];
console.log(`"${KEYWORD}" (${SEARCH_TYPE}): ${posts.length} posts`);

const cell = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 120);
const lines = [
  `## Threads 검색: "${KEYWORD}" (${SEARCH_TYPE === "TOP" ? "인기순" : "최신순"}, ${posts.length}개)`,
  "",
  "| # | 작성자 | 형식 | 날짜 | 첫 부분 | 링크 |",
  "|---|---|---|---|---|---|",
  ...posts.map((p, i) =>
    `| ${i + 1} | @${cell(p.username)} | ${cell(p.media_type)} | ${cell(p.timestamp?.slice(0, 10))} | ${cell(p.text)} | [열기](${p.permalink}) |`,
  ),
  "",
];
if (!posts.length) {
  lines.push("결과가 없어요. 앱 심사(고급 접근) 전에는 내 계정 글 안에서만 검색됩니다.");
}

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
} else {
  console.log(lines.join("\n"));
}
