/**
 * 상태 파일 — statusline 처럼 **플러그인 밖에서** 상태를 읽어가는 수단.
 *
 * 왜 파일인가: `team_doctor` 는 플러그인 프로세스 안에 있어서, 프로세스가 죽으면 진단도
 * 같이 죽는다(2026-09-29 실사례). 상태를 파일로 내보내면 **플러그인이 떠 있지 않아도**
 * 바깥에서 그 사실을 알 수 있다 — `updatedAt` 이 낡은 것이 곧 "안 돌고 있다"는 신호다.
 *
 * 쓰기는 config.json 과 같은 규칙(임시 파일 → rename, 0600)을 따른다. 여러 세션이 같은
 * 파일을 쓰므로 반쪽 파일이 남아선 안 된다.
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_PATH } from './config'

const STATE_DIR = dirname(CONFIG_PATH)

/**
 * 상태 파일은 **세션마다 하나**다.
 *
 * 한 머신에서 여러 세션이 동시에 돌고 각자 담당 방이 다르다. 파일이 하나면 마지막에 쓴
 * 세션이 앞선 세션을 덮어써서, 상태줄이 **남의 세션 상태**를 보여준다. 그리고 팀 채널을
 * 안 쓰는 세션(평범한 `claude`)에서도 그 파일이 읽혀 상태줄이 뜬다.
 *
 * ⚠️ **이 이름은 세션의 진짜 id 가 아닐 수 있다.**
 * `CLAUDE_CODE_SESSION_ID` 는 MCP 서버가 **기동하는 시점**의 값인데, `claude --resume` 은
 * 서버를 먼저 띄우고 **그 뒤에** 이어받을 대화를 고른다. 그 순간 세션 id 가 복원된 대화의
 * 것으로 바뀌지만, **이미 뜬 서버의 환경변수는 바뀌지 않는다.** 다시 읽어도 소용없다 —
 * 프로세스 환경변수는 나중에 안 바뀐다. 즉 **플러그인은 자기 세션의 진짜 id 를 알 수 없다.**
 *
 * (실사례: 전사는 0e86d25f 인데 서버는 fbc4f84e 로 기동 → 상태줄이 자기 파일을 못 찾아
 *  "플러그인 미동작" 을 띄웠다. 메시지 송수신은 내내 정상이었다.)
 *
 * 그래서 맞추려 들지 않고 **statusline 쪽에서 받아낸다** — 살아 있는 게이트웨이 파일이
 * 하나뿐이면 그게 내 것이다. 둘 이상이면 고르지 않는다.
 */
export function statePath(sessionId: string): string {
  return join(STATE_DIR, `state-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
}

/**
 * 끝난 세션의 상태 파일 청소.
 *
 * 1시간이다(전에는 24시간). 상태 파일은 **쓰는 쪽이 살아 있는 동안만** 뜻이 있다 —
 * 30초마다 갱신되므로 1시간이 지난 파일은 그 세션이 끝났다는 뜻이고, 남겨 둬야 할 이유가
 * 없다. 24시간이면 하루치 죽은 파일이 쌓여, "지금 어느 게 살아 있나" 를 볼 때 사람을
 * 헷갈리게 한다 (실사례: 창 하나뿐인데 파일이 4개였고 그중 3개가 시체였다).
 */
export function sweepStaleStates(maxAgeMs = 60 * 60 * 1000, now = Date.now()): void {
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!/^state-.*\.json$/.test(f)) continue
      const full = join(STATE_DIR, f)
      if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full)
    }
    // v0.7.0 의 단일 파일 잔재 — 남아 있으면 상태줄이 엉뚱한 값을 읽는다
    try { unlinkSync(join(STATE_DIR, 'state.json')) } catch { /* 없으면 그만 */ }
  } catch {
    /* 청소 실패는 무해하다 */
  }
}

export interface SessionState {
  /** 마지막 갱신 시각 — 이 값이 낡으면 플러그인이 죽은 것이다 */
  updatedAt: number
  sessionId: string
  /**
   * 나를 띄운 Claude Code 프로세스의 PID.
   *
   * **sessionId 와 달리 이 값은 거짓이 될 수 없다.** 세션 id 는 MCP 가 뜬 뒤에 바뀔 수
   * 있지만(아래 statePath 머리말), 부모 PID 는 그 창이 사는 동안 변하지 않는다. 그리고
   * statusline 은 **바로 그 claude 가 직접 띄우므로** `$PPID` 가 같은 값이다(실측:
   * 창 10개 전부 상태줄의 직속 부모가 claude 였고, MCP 와 1:1 로 맞물렸다).
   *
   * 그래서 세션 id 가 어긋나도 이 값으로 서로를 정확히 찾는다.
   */
  ppid: number
  /** 중계 서버 소켓이 살아 있는가 */
  connected: boolean
  /** 이 세션이 수신을 맡는가 (claude-team alias) */
  gateway: boolean
  /** 이 세션이 담당 중인 방 */
  held: string[]
  /** 소속 방 → 그 방에서의 내 라벨 */
  rooms: Record<string, string>
  /** 소속이지만 **아무 세션도 받고 있지 않은** 방 */
  empty: string[]
  /** 나를 기다리는 보관 메시지 수 */
  queued: number
  away: boolean
  /** 마지막 치명 사유 — plugin_outdated · auth_failed · revoked 등 */
  lastError: string | null
}

export function writeState(s: SessionState): void {
  if (!s.sessionId) return // 세션을 식별할 수 없으면 상태줄이 매칭할 수도 없다
  // 수신을 맡지 않는 세션(평범한 `claude`)은 상태줄을 차지하지 않는다. 파일 자체를 만들지
  // 않아 쌓이지도 않는다 — 스크립트의 gateway 검사는 그 다음 방어선이다.
  if (!s.gateway) return
  try {
    const path = statePath(s.sessionId)
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch {
    /* 상태 내보내기 실패가 팀 채널 동작을 막아선 안 된다 */
  }
}
