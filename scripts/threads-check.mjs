// Checks which Threads features the current token can use, without publishing.
// Creating a media container needs the same permission as posting, but an
// unpublished container never appears on the account and expires on its own.
import { appendFile } from "node:fs/promises";

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const API = "https://graph.threads.net/v1.0";
if (!TOKEN) {
  console.error("THREADS_ACCESS_TOKEN is not set.");
  process.exit(1);
}

async function call(method, path, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const url = method === "GET" ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, method === "GET" ? {} : { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`${res.status} ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

const results = [];
async function check(label, permission, fn) {
  try {
    const note = await fn();
    results.push({ label, permission, ok: true, note: note || "" });
  } catch (err) {
    results.push({ label, permission, ok: false, note: err.message });
  }
}

let ownPostId;
await check("계정 정보 읽기", "threads_basic", async () => {
  const me = await call("GET", "/me", { fields: "username" });
  return `@${me.username}`;
});
await check("내 글 목록 읽기", "threads_basic", async () => {
  const list = await call("GET", "/me/threads", { fields: "id,text", limit: "1" });
  ownPostId = list.data?.[0]?.id;
  return ownPostId ? `최근 글 ${ownPostId}` : "글 없음";
});
await check("글 올리기 (준비 단계까지만)", "threads_content_publish", async () => {
  const c = await call("POST", "/me/threads", { media_type: "TEXT", text: "권한 점검용 (게시하지 않음)" });
  return `컨테이너 ${c.id} 생성됨, 게시 안 함`;
});
await check("키워드 검색", "threads_keyword_search", async () => {
  const r = await call("GET", "/keyword_search", { q: "말씀돌", fields: "id", limit: "5" });
  return `${(r.data || []).length}개 결과`;
});
await check("답글 읽기", "threads_read_replies", async () => {
  if (!ownPostId) throw new Error("확인할 내 글이 없음");
  const r = await call("GET", `/${ownPostId}/replies`, { fields: "id,text", limit: "5" });
  return `답글 ${(r.data || []).length}개 읽음`;
});
await check("답글 달기 (준비 단계까지만)", "threads_manage_replies", async () => {
  if (!ownPostId) throw new Error("답글을 달 내 글이 없음");
  const c = await call("POST", "/me/threads", {
    media_type: "TEXT",
    text: "권한 점검용 답글 (게시하지 않음)",
    reply_to_id: ownPostId,
  });
  return `답글 컨테이너 ${c.id} 생성됨, 게시 안 함`;
});

const lines = [
  "## Threads 권한 점검 (아무것도 게시하지 않음)",
  "",
  "| 기능 | 권한 | 결과 | 메모 |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.label} | \`${r.permission}\` | ${r.ok ? "✅" : "❌"} | ${r.note.replace(/\|/g, "\\|")} |`),
  "",
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
