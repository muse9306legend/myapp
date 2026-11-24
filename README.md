# 쓰레드 자동화

1. **AI 작성:** 매일 밤 22시쯤 Claude가 `brand/` 폴더의 설명서와 규칙을 읽고 다음 날 글을 써서 `posts/queue.json`에 `draft`(초안)로 넣습니다.
2. **승인:** 초안을 읽고 괜찮으면 `status`를 `"pending"`으로 바꿔 커밋합니다. 고치고 싶으면 `text`를 고치면 됩니다.
3. **게시:** GitHub Actions가 15분마다 확인해서 게시 시간이 지난 `pending` 글을 Threads에 올립니다.

승인 없이 바로 올리려면 `brand/threads/config.json`의 `require_approval`을 `false`로 바꾸세요.

## 구성

| 파일 | 역할 |
| --- | --- |
| `posts/queue.json` | 예약 글 목록 (`at`, `text`, `status`) |
| `brand/BRAND.md` | 계정 주제, 타깃, 말투, 금지어 (AI가 매번 읽는 설명서) |
| `brand/threads/RULES.md` | Threads 글 규칙, 잘 된 글 예시 |
| `brand/threads/REPLY_RULES.md` | 사람처럼 쓰는 댓글(답글) 규칙. 답글 초안 스크립트가 읽음 |
| `brand/threads/config.json` | 게시 시간(`times`), 승인 필요 여부, 주제 힌트(`topics`) |
| `scripts/threads-generate.mjs` | Claude로 빈 시간대의 글을 써서 queue에 추가 |
| `.github/workflows/threads-generate.yml` | 매일 22:17(KST) 다음 날 글 작성. 수동 실행 시 날짜·주제 지정 가능 |
| `scripts/threads-post.mjs` | 게시 시간이 지난 `pending` 글을 Threads API로 게시하고 상태를 기록 |
| `scripts/refresh-token.mjs` | 장기 액세스 토큰(60일) 갱신 |
| `.github/workflows/threads-post.yml` | 15분마다 게시 스크립트 실행, 결과를 queue.json에 커밋 |
| `.github/workflows/threads-token-refresh.yml` | 매월 1일·15일 토큰 갱신 후 Secret 교체 |
| `index.html` | 글 작성 도우미와 예약 목록 페이지 (GitHub Pages) |

## AI 글쓰기 설정
- 모델은 Claude Opus 5.5를 씁니다. 하루 3개 글 기준 요청 1번이라 비용은 작습니다.
- Claude가 요청을 거절하면 API가 다른 모델로 자동 재시도하도록(`fallbacks`) 켜 두었습니다.
- 500자를 넘는 글은 `pending`이 되지 않고 `draft`에 `error`가 붙어 남습니다.
- 성과가 좋았던 글을 `brand/threads/RULES.md`의 예시에 붙여 넣을수록 글이 내 스타일에 가까워집니다.

## 예약 항목 형식

```json
{
  "at": "2026-12-01T09:00:00+09:00",
  "text": "본문 (최대 500자)",
  "status": "draft | pending",
  "image_url": "https://... (선택, 공개 이미지 URL)",
  "video_url": "https://... (선택, 공개 MP4 URL. media/ 폴더에 넣으면 GitHub Pages 주소로 공개됨)",
  "reply_to_id": "답글로 달 Threads 게시물 ID (선택)"
}
```

게시가 끝나면 `status`가 `published`로 바뀌고 `threads_id`, `permalink`가 기록됩니다. 3번 실패하면 `failed`가 됩니다.

## 처음 설정하기

1. [Meta for Developers](https://developers.facebook.com/)에서 앱을 만들고 **Threads API 사용** 사례를 추가합니다.
2. 권한 `threads_basic`, `threads_content_publish`를 추가하고, 내 Threads 계정을 테스터로 등록·수락합니다.
3. 사용자 액세스 토큰을 발급한 뒤 **장기 토큰(60일)**으로 교환합니다.
4. GitHub 저장소 **Settings → Secrets and variables → Actions**에 추가합니다.
   - `THREADS_ACCESS_TOKEN`: 장기 토큰
   - `ANTHROPIC_API_KEY`: Claude API 키 ([console.anthropic.com](https://console.anthropic.com)에서 발급)
   - `GH_PAT`: 토큰 자동 갱신용. 이 저장소에 **Secrets: Read and write** 권한이 있는 fine-grained 개인 토큰
5. **Actions → Threads scheduled post → Run workflow**에서 `dry_run`을 켜고 한 번 실행해 확인합니다.

## 로컬에서 확인

```bash
npm ci
DRY_RUN=1 node scripts/threads-post.mjs
ANTHROPIC_API_KEY=... TARGET_DATE=2026-12-02 node scripts/threads-generate.mjs
```

참고: GitHub의 예약 실행은 몇 분 늦어질 수 있습니다.
