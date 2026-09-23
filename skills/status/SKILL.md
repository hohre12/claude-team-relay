---
name: status
description: 팀 연결 상태(이 세션 담당 방·방별 내 라벨·온라인 팀원·자동답장 토글)를 보여준다. 자동답장 전환 — /team-relay:status auto-reply off|on
---

사용자가 `/team-relay:status` 를 실행했다.

1. 인자가 없으면 `team_status` 도구를 인자 없이 호출해 결과를 그대로 보여준다.
2. 인자가 `auto-reply off` 또는 `auto-reply on` 이면 `team_status` 를
   `{ auto_reply: "off" | "on" }` 으로 호출해 토글을 전환하고, 바뀐 상태를 확인시킨다.
   off 는 "팀 질문에 답하기 전에 초안을 나에게 보여달라"는 뜻이라고 설명한다.
3. "연결돼 있지 않습니다" 가 나오면 `/team-relay:join` 안내 또는 중계 서버 상태 확인을 권한다.
4. 내 이름은 **방마다 다를 수 있다**(신원은 토큰 하나, 이름은 방별 라벨) — 출력의 `방(라벨)`
   표기를 그대로 전한다. "이 세션 담당"이 비어 있으면 이 세션은 발신 전용이라는 뜻이므로
   `/team-relay:room <방>` 으로 지정할 수 있다고 안내한다.
