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

NOW=$(date +%s)

# 그 파일이 살아 있는가 — updatedAt 이 60초 이내면 플러그인이 돌고 있는 것이다.
fresh() {
  [ -f "$1" ] || return 1
  u=$(sed -n 's/.*"updatedAt"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$1" 2>/dev/null | head -1)
  [ -n "$u" ] || return 1
  [ $(( NOW - u / 1000 )) -le 60 ]
}

# 내 세션 id 로 된 파일이 없거나 낡았을 때의 대비책.
#
# 플러그인이 쓰는 세션 id 와 상태줄이 받는 세션 id 가 **갈릴 수 있다** (실사례: 플러그인은
# state-fbc4f84e 에 쓰는데 상태줄은 state-0e86d25f 를 찾았다. 메시지는 정상이었는데
# 상태줄만 "플러그인 미동작" 이라고 말했다). 플러그인은 자기가 어떤 id 로 불릴지 알 수 없으므로
# 이쪽에서 받아낸다 — **살아 있는 게이트웨이 파일이 딱 하나면 그게 내 것이다.**
#
# 둘 이상이면 고르지 않는다. 남의 세션 상태를 보여주느니 모른다고 하는 쪽이 낫다
# (v0.7.0 의 단일 파일이 정확히 그 사고였다).
if ! fresh "$STATE"; then
  # 게이트웨이 세션이 아니면 **남의 상태를 집지 않는다.** 팀 채널을 안 쓰는 평범한 claude
  # 세션에까지 팀 상태가 뜨면 그게 v0.7.0 의 사고다 (한 파일을 모두가 읽던 시절).
  [ "$TEAM_RELAY_GATEWAY" = "1" ] || exit 0
  N=0; PICK=""
  for f in "$DIR"/state-*.json; do
    fresh "$f" || continue
    grep -q '"gateway"[[:space:]]*:[[:space:]]*true' "$f" 2>/dev/null || continue
    N=$((N + 1)); PICK="$f"
  done
  if [ "$N" = 1 ]; then
    STATE="$PICK"
  else
    # 평범한 claude 세션은 애초에 팀 채널을 안 쓰므로 조용히 빠진다.
    # claude-team 인데 살아 있는 것이 없다 = 플러그인이 정말 안 돈다. 그 글자를 쓸 주체가
    # 바로 그 죽은 플러그인이라 파일로는 알릴 수 없어, 환경변수로 판정한다.
    [ "$TEAM_RELAY_GATEWAY" = "1" ] && printf '[team ✗ 플러그인 미동작]'
    exit 0
  fi
fi

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

# 신선도는 위에서 이미 걸렀다 (fresh) — 여기 오면 플러그인은 돌고 있는 것이다
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
