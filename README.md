# notion-tasks-sync

구글 Tasks 목록과 Notion 데이터베이스를 **5분마다** 양방향으로 맞춰 주는 개인용 프로그램이에요.
Cloudflare Worker 에서 돌아가서 PC 를 켜둘 필요가 없고, 무료 한도 안에서 동작해요.
로그에는 할 일 내용 없이 개수만 남아요.

## 동작 규칙

| 항목 | 규칙 |
|---|---|
| 연동 칸 | 제목, 완료, 메모(세부정보), 날짜, 하위 할 일 |
| 날짜 | 구글은 날짜만 지원 → Notion 에 시간이 있으면 시간은 유지하고 날짜만 맞춤 |
| 반복 항목 | Notion 에 반복 주기(Frequency)가 있으면 'Next Due' 를 구글 날짜로 보냄 (날짜는 Notion 기준) |
| 하위 할 일 | 구글은 1단계만 지원 → Notion 의 깊은 하위는 구글에서 최상위 항목 아래로 |
| 양쪽 수정 | 칸별로 합침. 같은 칸을 양쪽에서 고치면 나중에 고친 쪽 우선 |
| 삭제 | 한쪽에서 지우면 반대쪽도 삭제 (Notion 은 휴지통 → 30일 안에 복구 가능) |
| 안전장치 | 한 번에 5개 넘게 지우려 하거나 한쪽이 통째로 비어 보이면 아무것도 안 바꾸고 멈춤 |
| 짝 장부 | Notion 의 '동기화 기록' 페이지에 ID 와 지문(해시)만 저장 |
| 요청 한도 | 실행 한 번에 외부 요청 50개(무료 플랜) → 일이 많으면 나눠서 다음 실행 때 마저 처리 |

## 배포

`main` 에 올리면 GitHub Actions 가 테스트 → Cloudflare 배포 → 비밀값 등록 → 시험 실행까지 해요.
Actions 탭 → **deploy** → **Run workflow** 에서 '지금 바로 동기화'를 고르면 5분을 기다리지 않고 바로 맞춰요.

## 필요한 GitHub Secrets

| 이름 | 내용 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API 토큰 ('Edit Cloudflare Workers' 템플릿) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 계정 ID (32자리) |
| `GOOGLE_CLIENT_ID` | 구글 클라우드 OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 구글 클라우드 OAuth 클라이언트 보안 비밀번호 |
| `GOOGLE_REFRESH_TOKEN` | Tasks 권한으로 받은 리프레시 토큰 |
| `NOTION_TOKEN` | Notion 개인 액세스 토큰 |
| `NOTION_STATE_PAGE_ID` | '동기화 기록' 페이지 ID |
| `NOTION_TODO_DS_ID` | TO-DO 데이터베이스의 데이터 소스 ID |
| `TELEGRAM_BOT_TOKEN` | (선택) 실패 알림을 보낼 텔레그램 봇 토큰 — routine-bot 과 같은 봇이어도 돼요 |
| `TELEGRAM_CHAT_ID` | (선택) 알림 받을 채팅방 번호 |

텔레그램 값을 넣으면 실패할 때 알림이 와요. 같은 오류는 하루 한 번만, 다시 정상이 되면 '복구' 알림을 한 번 보내요.
무엇을 보냈는지는 Cloudflare KV(`notion-tasks-sync-alerts`, 배포 때 자동 생성)에 기억해요.

## 무료 한도

| 항목 | 무료 한도 | 쓰는 양 |
|---|---|---|
| Workers 요청 | 하루 10만 건 | 하루 288건 (5분마다) |
| 실행 한 번의 외부 요청 | 50개 | 평소 6~8개 |
| Cron(예약 실행) | 계정 전체 5개 | 1개 |

## 테스트

```
npm ci
npm run check && npm test
```

`docs/` 폴더는 구글 앱 게시에 필요한 홈페이지·개인정보처리방침(GitHub Pages)이에요.
