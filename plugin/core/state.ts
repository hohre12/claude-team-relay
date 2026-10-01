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
 * statusline 은 stdin 으로 받은 session_id 로 자기 파일만 찾는다 — 없으면 아무것도 안 띄운다.
 */
export function statePath(sessionId: string): string {
  return join(STATE_DIR, `state-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
}

/** 끝난 세션의 상태 파일 청소 — 하루 지난 것은 지운다 (무한 누적 방지) */
export function sweepStaleStates(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): void {
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
