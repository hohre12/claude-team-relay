---
name: owner
description: 방장 전용 — 내가 방장인 방의 초대코드 발급·방 단위 추방·방 전원 공지·방 메모리 관리. 사용법 — /team-relay:owner invite|kick|notice|memory <방> ...
---

사용자가 `/team-relay:owner <동작> <방> ...` 를 실행했다. 방장 지정은 서버 관리자가 한다.

1. `invite <방> <새팀원이름>` → `team_owner(action:"invite", room, name)` — 발급된 초대코드를 그대로 보여주고 전달 방법을 안내한다. 그 이름은 **그 방에서만 쓰이는 라벨**이라 다른 방과 달라도 된다.
2. `kick <방> <이름>` → `team_owner(action:"kick", room, name)` — **그 방에서만** 빠지는 것이고 토큰·다른 방 소속은 유지된다는 점을 함께 알린다 (전역 차단은 관리자 revoke).
3. `notice <방> <내용>` → `team_owner(action:"notice", room, text)` — 배달/보관 집계와 만석으로 못 받은 팀원을 그대로 전한다.
4. `memory <방>` → `team_memory(action:"view", room)` 로 지금 내용과 대기 중인 제안을 보여준다. 이어서 사용자가 원하는 대로:
   - 설명 → `team_memory(action:"describe", room, text)`
   - 항목 추가·수정·삭제 → `add`(text, unknown) · `edit`(pos, text, unknown) · `remove`(pos)
   - 제안 처리 → `approve`(proposal_id, 3칸이 다 찼으면 replace) · `reject`(proposal_id, reason)
   메모리는 **설명 1 + 항목 최대 3, 칸마다 150자**다. 항목마다 "모르면 생기는 일"(unknown)이 있어야 하고, 채울 수 없다면 메모리감이 아니라고 알려준다. 넣을 기준은 "코드를 읽어서는 알 수 없고 답이 매번 같은 것" 이다.
5. "방장이 아닙니다" 응답이면 서버 관리자에게 방장 지정을 요청하라고 안내한다.
