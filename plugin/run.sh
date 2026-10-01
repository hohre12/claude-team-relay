#!/bin/sh
# team-relay 플러그인 런처 — 있는 런타임으로 번들을 띄운다.
#
# Claude Code 는 네이티브 바이너리라 Node 를 보장하지 않고, 기존 팀원은 Bun 만 깔려 있을
# 수 있다. 어느 쪽이든 받아서, 전환 때문에 누구도 끊기지 않게 한다 (v0.7 §3.2).
# Node 가 우선인 이유: 개발 머신에 더 보편적이라 신규 설치에서 사전 요구가 사라진다.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null 2>&1 && exec node "$DIR/dist/server.mjs"
command -v bun  >/dev/null 2>&1 && exec bun  "$DIR/dist/server.mjs"
echo "team-relay: node 도 bun 도 찾을 수 없습니다 — Node.js 를 설치하세요 (https://nodejs.org)" >&2
exit 1
