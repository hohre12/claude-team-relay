---
name: owner
description: 방장 전용 — 내가 방장인 방의 초대코드 발급·방 단위 추방·방 전원 공지. 사용법 — /team-relay:owner invite|kick|notice <방> ...
---

사용자가 `/team-relay:owner <동작> <방> ...` 를 실행했다. 방장 지정은 서버 관리자가 한다.

1. `invite <방> <새팀원이름>` → `team_owner(action:"invite", room, name)` — 발급된 초대코드를 그대로 보여주고 전달 방법을 안내한다. 그 이름은 **그 방에서만 쓰이는 라벨**이라 다른 방과 달라도 된다.
2. `kick <방> <이름>` → `team_owner(action:"kick", room, name)` — **그 방에서만** 빠지는 것이고 토큰·다른 방 소속은 유지된다는 점을 함께 알린다 (전역 차단은 관리자 revoke).
3. `notice <방> <내용>` → `team_owner(action:"notice", room, text)` — 배달/보관 집계와 만석으로 못 받은 팀원을 그대로 전한다.
4. "방장이 아닙니다" 응답이면 서버 관리자에게 방장 지정을 요청하라고 안내한다.
