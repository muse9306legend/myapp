# 쓰레드 자동화

`posts/queue.json`에 글을 예약해 두면 GitHub Actions가 15분마다 확인해서 게시 시간이 지난 글을 Threads에 올립니다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `posts/queue.json` | 예약 글 목록 (`at`, `text`, `status`) |
| `scripts/threads-post.mjs` | 게시 시간이 지난 `pending` 글을 Threads API로 게시하고 상태를 기록 |
| `scripts/refresh-token.mjs` | 장기 액세스 토큰(60일) 갱신 |
| `.github/workflows/threads-post.yml` | 15분마다 게시 스크립트 실행, 결과를 queue.json에 커밋 |
| `.github/workflows/threads-token-refresh.yml` | 매월 1일·15일 토큰 갱신 후 Secret 교체 |
| `index.html` | 글 작성 도우미와 예약 목록 페이지 (GitHub Pages) |

## 예약 항목 형식

```json
{
  "at": "2026-12-01T09:00:00+09:00",
  "text": "본문 (최대 500자)",
  "status": "pending",
  "image_url": "https://... (선택, 공개 이미지 URL)",
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
   - `GH_PAT`: 토큰 자동 갱신용. 이 저장소에 **Secrets: Read and write** 권한이 있는 fine-grained 개인 토큰
5. **Actions → Threads scheduled post → Run workflow**에서 `dry_run`을 켜고 한 번 실행해 확인합니다.

## 로컬에서 확인

```bash
DRY_RUN=1 node scripts/threads-post.mjs
```

참고: GitHub의 예약 실행은 몇 분 늦어질 수 있습니다.
