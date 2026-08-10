---
name: status
description: 팀 연결 상태(내 이름·방·온라인 팀원·자동답장 토글)를 보여준다. 자동답장 전환 — /team:status auto-reply off|on
---

사용자가 `/team:status` 를 실행했다.

1. 인자가 없으면 `team_status` 도구를 인자 없이 호출해 결과를 그대로 보여준다.
2. 인자가 `auto-reply off` 또는 `auto-reply on` 이면 `team_status` 를
   `{ auto_reply: "off" | "on" }` 으로 호출해 토글을 전환하고, 바뀐 상태를 확인시킨다.
   off 는 "팀 질문에 답하기 전에 초안을 나에게 보여달라"는 뜻이라고 설명한다.
3. "연결돼 있지 않습니다" 가 나오면 `/team:join` 안내 또는 중계 서버 상태 확인을 권한다.
