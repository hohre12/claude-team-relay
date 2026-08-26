---
name: route
description: 팀 질문의 로컬 위임 등록표를 관리한다. /team-relay:route (목록) · /team-relay:route add "<키워드>" <세션> · /team-relay:route add --room <방> <세션> · /team-relay:route remove "<키워드>"|--room <방>
---

사용자가 `/team-relay:route` 를 실행했다. 등록표는 "이런 키워드의 팀 질문이 오면 이 머신의
저 세션에 위임하라"는 명시 규칙이다 (3단 위임의 1단).

1. 인자가 없거나 `list` 면 `team_route(action: "list")` 를 호출해 목록을 보여준다.
2. `add "<키워드>" <세션이름>` 이면 `team_route(action: "add", keywords, session)` 호출.
   세션이름은 이 머신의 Claude Code 세션 이름(`/rename` 으로 지정한 것)이라고 설명한다.
3. `add --room <방> <세션이름>` 이면 `team_route(action: "add", room, session)` 호출 —
   그 방 꼬리표가 달린 팀 질문은 키워드와 무관하게 항상 그 세션이 답하게 된다
   (방별 세션 분담: 예 — 방① 질문은 backend 세션, 방② 질문은 infra 세션).
4. `remove "<키워드>"` 면 `team_route(action: "remove", keywords)`,
   `remove --room <방>` 이면 `team_route(action: "remove", room)` 호출.
5. 등록은 선택사항이며, 없어도 세션 이름·작업 디렉토리 자동 매칭(2단)으로 위임된다는 것을
   필요 시 덧붙인다.
