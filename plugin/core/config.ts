/**
 * 설정 파일 입출력 — 이 머신의 신원·소속 방·세션 담당 바인딩.
 *
 * config.json 은 한 머신의 **모든 세션이 공유하는 단일 파일**이라, 저장은 원자적이어야
 * 하고 남의 세션 기록을 덮어써서도 안 된다 (v0.6.1 에서 수리).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './types'

/** 이 세션의 고유 id — Claude Code 가 플러그인 프로세스에 넘겨준다 (2026-09-21 실측) */
export const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID ?? ''
/** 세션 바인딩 보관 상한 — 세션 id 가 무한 누적되지 않게 (v2 §3.2) */
const SESSION_KEEP = 50

/** 이 세션이 담당할 방 — 설정에 바인딩이 없으면, 소속 방이 하나뿐일 때만 자동 담당 */
export function myRooms(cfg: Config): string[] {
  const bound = SESSION_ID ? cfg.sessions?.[SESSION_ID] : undefined
  if (bound && bound.length) return bound
  const all = Object.keys(cfg.rooms ?? {})
  return all.length === 1 ? all : []
}

/** 이 세션의 담당 방을 설정에 기록 (LRU — 오래된 세션 항목부터 밀어낸다) */
export function bindRooms(cfg: Config, rooms: string[]): Config {
  if (!SESSION_ID) return cfg
  const sessions = { ...(cfg.sessions ?? {}), [SESSION_ID]: rooms }
  const keys = Object.keys(sessions)
  if (keys.length > SESSION_KEEP) for (const k of keys.slice(0, keys.length - SESSION_KEEP)) delete sessions[k]
  return { ...cfg, sessions }
}

/** 설정 파일 — 머신당 하나, 홈 디렉토리 고정. cwd·세션 id 와 무관하다 */
export const CONFIG_PATH =
  process.env.TEAM_RELAY_CONFIG ?? join(homedir(), '.claude', 'channels', 'team-relay', 'config.json')

export function loadConfig(): Config | null {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config
    // v1 → v2: 단일 이름을 rooms 맵으로 승격 (방 이름은 서버 welcome 이 채운다)
    if (cfg.name && !cfg.rooms) cfg.rooms = {}
    return cfg
  } catch {
    return null
  }
}

/**
 * 설정 저장 — 원자적으로 쓰고, 디스크의 최신본과 병합한다.
 *
 * config.json 은 이 머신의 **모든 세션이 공유하는 단일 파일**이다. 통째로 덮어쓰면
 *  ① 읽은 뒤 쓰기까지의 사이에 다른 세션이 적은 변경이 사라지고(특히 세션별 담당 기록),
 *  ② 쓰는 도중 끊기면(절전·강제종료·디스크 부족) 반쪽 JSON 이 남아 토큰까지 유실된다.
 * 그래서 두 가지를 지킨다:
 *  · sessions — 담당 기록은 **내 세션 항목만** 쓴다. 남의 항목은 언제나 디스크가 진실.
 *  · rooms    — 서버가 진실이다. 서버 응답으로 받은 값일 때만(roomsFromServer) 덮어쓰고,
 *               아니면 디스크 값을 유지해 오래된 캐시가 최신본을 지우지 못하게 한다.
 * 쓰기는 임시 파일 → rename. rename 은 원자적이라 "옛 내용" 아니면 "새 내용"만 존재한다.
 */
export function saveConfig(cfg: Config, opts: { roomsFromServer?: boolean } = {}): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const disk = loadConfig()
  const next: Config = { ...(disk ?? {}), ...cfg }
  if (disk) {
    const sessions: Record<string, string[]> = { ...(disk.sessions ?? {}) }
    const mine = SESSION_ID ? cfg.sessions?.[SESSION_ID] : undefined
    if (SESSION_ID && mine) { delete sessions[SESSION_ID]; sessions[SESSION_ID] = mine } // 항상 최신 = 맨 뒤
    const keys = Object.keys(sessions)
    if (keys.length > SESSION_KEEP) for (const k of keys.slice(0, keys.length - SESSION_KEEP)) delete sessions[k]
    if (keys.length) next.sessions = sessions
    if (!opts.roomsFromServer && disk.rooms) next.rooms = disk.rooms
  }
  if (opts.roomsFromServer) delete next.name // v1 잔재는 서버 진실을 받는 순간 정리
  const tmp = CONFIG_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, CONFIG_PATH)
}

/** "10.0.1.23:8765" · "ws://10.0.1.23:8765" · "ws://…/ws" 전부 정식 ws URL 로 */
export function normalizeUrl(address: string): string {
  let u = address.trim()
  if (!/^wss?:\/\//.test(u)) u = 'ws://' + u
  if (!u.endsWith('/ws')) u = u.replace(/\/+$/, '') + '/ws'
  return u
}
