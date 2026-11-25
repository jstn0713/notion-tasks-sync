# notion-tasks-sync

구글 Tasks 목록과 Notion 데이터베이스를 15분마다 양방향으로 맞춰 주는 개인용 프로그램입니다.
깃허브 Actions에서 자동으로 실행되며, 할 일 내용은 로그에 남기지 않고 개수만 출력합니다.

## 동작 규칙

| 항목 | 규칙 |
|---|---|
| 연동 칸 | 제목, 완료, 메모(세부정보), 날짜, 하위 할 일 |
| 날짜 | 구글은 날짜만 지원 → Notion에 시간이 있으면 시간은 유지하고 날짜만 맞춤 |
| 반복 항목 | Notion에 반복 주기가 있으면 '다음 마감일'을 구글 날짜로 보냄 (날짜는 Notion 기준) |
| 하위 할 일 | 구글은 1단계만 지원 → Notion의 깊은 하위는 구글에서 최상위 항목 아래로 |
| 양쪽 수정 | 칸별로 합침. 같은 칸을 양쪽에서 고치면 나중에 고친 쪽 우선 |
| 삭제 | 한쪽에서 지우면 반대쪽도 삭제 (Notion은 휴지통 → 30일 안에 복구 가능) |
| 안전장치 | 한 번에 5개 넘게 지우려 하거나 한쪽이 통째로 비어 보이면 아무것도 안 바꾸고 멈춤 |
| 짝 장부 | Notion의 '동기화 기록' 페이지에 ID만 저장 |

## 필요한 Secrets

| 이름 | 내용 |
|---|---|
| `GOOGLE_CLIENT_ID` | 구글 클라우드 OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 구글 클라우드 OAuth 클라이언트 보안 비밀번호 |
| `GOOGLE_REFRESH_TOKEN` | Tasks 권한으로 받은 리프레시 토큰 |
| `NOTION_TOKEN` | Notion 내부 연동(Integration) 키 |
| `NOTION_STATE_PAGE_ID` | '동기화 기록' 페이지 ID |
| `NOTION_TODO_DS_ID` | TO-DO 데이터베이스의 데이터 소스 ID |

## 15분 실행 방식

깃허브 예약 실행(schedule)은 늦어지거나 건너뛰는 일이 잦아서, 외부 알람 서비스(cron-job.org)가
15분마다 아래 주소로 '실행' 요청을 보냅니다. 깃허브 예약 실행은 예비용으로 남겨 둡니다.

```
POST https://api.github.com/repos/<owner>/notion-tasks-sync/actions/workflows/sync.yml/dispatches
Authorization: Bearer <이 저장소 Actions 쓰기 권한만 있는 fine-grained 토큰>
Body: {"ref":"main","inputs":{"dry_run":"false"}}
```

## 수동 실행

Actions 탭 → "Notion ↔ Google Tasks 동기화" → Run workflow.
'시험 실행'에 체크하면 실제로 바꾸지 않고 무엇이 몇 개 바뀔지만 보여줍니다.

## 테스트

```
pip install -r requirements.txt pytest
python -m pytest -q tests
```
