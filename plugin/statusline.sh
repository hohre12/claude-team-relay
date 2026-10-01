#!/bin/sh
# team-relay 상태줄 — Claude Code 가 주기적으로 실행해 한 줄을 받아간다.
#
# 이 스크립트는 **플러그인 프로세스와 완전히 독립**이다. 그래서 플러그인이 죽어 있어도
# 그 사실을 보여줄 수 있다 — state.json 의 updatedAt 이 낡은 것이 곧 그 신호다.
# 의존성 0 (jq 도 쓰지 않는다). 상태 파일이 없으면 조용히 아무것도 출력하지 않는다.
# Claude Code 가 세션 정보를 JSON 으로 stdin 에 준다 — 그 안의 session_id 로 **이 세션의**
# 상태 파일만 찾는다. 팀 채널을 쓰지 않는 세션에는 그 파일이 없으므로 아무것도 안 띄운다.
DIR="${TEAM_RELAY_STATE_DIR:-$HOME/.claude/channels/team-relay}"
if [ -n "$TEAM_RELAY_STATE" ]; then
  STATE="$TEAM_RELAY_STATE"
else
  INPUT=$(cat 2>/dev/null)
  SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$SID" ] || exit 0
  STATE="$DIR/state-$SID.json"
fi
[ -f "$STATE" ] || exit 0

RAW=$(cat "$STATE" 2>/dev/null) || exit 0

# 스칼라 뽑기 — "key": value
field() { printf '%s' "$RAW" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p" | head -1 | tr -d '" '; }
# 배열 길이와 첫 원소
arr_first() { printf '%s' "$RAW" | tr -d '\n ' | sed -n "s/.*\"$1\":\[\"\([^\"]*\)\".*/\1/p" | head -1; }
arr_count() {
  BODY=$(printf '%s' "$RAW" | tr -d '\n ' | sed -n "s/.*\"$1\":\[\([^]]*\)\].*/\1/p" | head -1)
  [ -z "$BODY" ] && { echo 0; return; }
  printf '%s' "$BODY" | tr ',' '\n' | grep -c '"'
}

UPDATED=$(field updatedAt)
[ -z "$UPDATED" ] && exit 0
NOW=$(date +%s)
AGE=$(( NOW - UPDATED / 1000 ))

# ① 플러그인이 안 돌고 있다 — 가장 먼저 봐야 할 상태
if [ "$AGE" -gt 60 ]; then
  printf '[team ✗ 플러그인 미동작]'
  exit 0
fi

GATEWAY=$(field gateway)
[ "$GATEWAY" != "true" ] && exit 0        # 발신 전용 세션은 상태줄을 차지하지 않는다

ERR=$(field lastError)
if [ -n "$ERR" ] && [ "$ERR" != "null" ]; then
  case "$ERR" in
    plugin_outdated) printf '[team ✗ 구버전 — /plugin update]' ;;
    revoked)         printf '[team ✗ 접속 차단됨]' ;;
    *)               printf '[team ✗ %s]' "$ERR" ;;
  esac
  exit 0
fi

[ "$(field connected)" != "true" ] && { printf '[team ✗ 연결없음]'; exit 0; }
[ "$(field away)" = "true" ] && { printf '[team 🌙 퇴근]'; exit 0; }

HELD_N=$(arr_count held)
QUEUED=$(field queued)
[ -z "$QUEUED" ] && QUEUED=0
SUFFIX=''
[ "$QUEUED" -gt 0 ] 2>/dev/null && SUFFIX=" · ⏳$QUEUED"

if [ "$HELD_N" -eq 0 ]; then
  EMPTY_N=$(arr_count empty)
  if [ "$EMPTY_N" -gt 0 ]; then
    printf '[team ⚠️ 담당없음 · 빈방 %s]' "$EMPTY_N"
  else
    printf '[team ⚠️ 담당없음]'
  fi
  exit 0
fi

FIRST=$(arr_first held)
if [ "$HELD_N" -gt 1 ]; then
  printf '[team 🟢 %s +%s%s]' "$FIRST" "$(( HELD_N - 1 ))" "$SUFFIX"
else
  printf '[team 🟢 %s%s]' "$FIRST" "$SUFFIX"
fi
