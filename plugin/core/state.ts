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
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_PATH } from './config'

export const STATE_PATH = join(dirname(CONFIG_PATH), 'state.json')

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
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const tmp = `${STATE_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
    renameSync(tmp, STATE_PATH)
    chmodSync(STATE_PATH, 0o600)
  } catch {
    /* 상태 내보내기 실패가 팀 채널 동작을 막아선 안 된다 */
  }
}
