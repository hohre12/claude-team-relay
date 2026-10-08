#!/usr/bin/env bun
/**
 * team-relay 채널 플러그인 — 게이트웨이 세션과 중계 서버 사이의 다리.
 *
 * Claude Code 가 세션 기동 시 stdio 서브프로세스로 스폰한다.
 *  - 수신: 중계 서버 웹소켓 → notifications/claude/channel → <channel> 태그로 세션 주입
 *  - 발신: team_send MCP 도구 → 중계 서버 → 상대 팀원 게이트웨이
 *  - 대화 규약(3단 라우팅·꼬리표·권한 경계·자동답장 토글)은 instructions 로 시스템 프롬프트에 주입
 *
 * 설정: TEAM_RELAY_CONFIG 경로(기본 ~/.claude/channels/team-relay/config.json)
 *       { url, token, name, routes?, autoReply? } — team_join/team_route/team_status 가 생성·갱신.
 *       파일 권한 600.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config, ProtocolCache, RelayFrame, RouteEntry } from './core/types'
import {
  FALLBACK_INSTRUCTIONS, PROTOCOL_TIMEOUT_MS, fetchProtocolOnce, loadProtocolCache, saveProtocolCache,
} from './core/protocol'
import { PLUGIN_VERSION, PROTO } from './core/version'
import { choiceLabel, classifyRooms, emptyRooms, renderRooms } from './core/rooms'
import { addRoute, labelOf, removeRoute, renderRoutes } from './core/routes'
import { type SessionState, statePath, sweepStaleStates, writeState } from './core/state'
import WS from './core/ws'
import { createClaudeHost } from './host/claude'
import {
  CONFIG_PATH, bindRooms, loadConfig, myRooms, normalizeUrl, saveConfig,
} from './core/config'

/** 이 파일(또는 번들)이 놓인 자리 — 소스는 plugin/, 번들은 plugin/dist/ */
const PKG_DIR = new URL('.', import.meta.url).pathname
/** plugin/ 루트 — 번들이면 한 단계 위다 */
const PLUGIN_DIR = /\/dist\/?$/.test(PKG_DIR) ? dirname(PKG_DIR.replace(/\/$/, '')) : PKG_DIR.replace(/\/$/, '')

/**
 * 상태줄 스크립트의 **고정 경로**.
 *
 * 설치본 경로에는 버전이 들어간다(…/team-relay/0.7.0/plugin/…). 그 경로를 settings.json 에
 * 넣으면 **업데이트할 때마다 설정을 고쳐야 한다**. 그래서 기동할 때마다 설정 폴더로
 * 복사해 두고, 사용자는 버전이 없는 이 경로만 한 번 등록한다.
 */
const STATUSLINE_PATH = join(dirname(CONFIG_PATH), 'statusline.sh')
/**
 * 설정에 적을 형태 — 홈 아래면 `~` 로 줄인다.
 * statusLine 의 command 는 **셸에서 실행**되므로 `~` 가 펼쳐진다(공식 문서 예시도 이 형태).
 * 사용자 이름이 안 박히니 **그대로 복사해 다른 머신에서도 쓸 수 있다**.
 */
const STATUSLINE_CONFIG_PATH = STATUSLINE_PATH.startsWith(homedir() + '/')
  ? `~${STATUSLINE_PATH.slice(homedir().length)}`
  : STATUSLINE_PATH

function installStatusline(): void {
  try {
    const src = join(PLUGIN_DIR, 'statusline.sh')
    const body = readFileSync(src, 'utf8')
    let current: string | null = null
    try { current = readFileSync(STATUSLINE_PATH, 'utf8') } catch { /* 처음 */ }
    if (current === body) return // 같은 내용이면 건드리지 않는다
    mkdirSync(dirname(STATUSLINE_PATH), { recursive: true })
    const tmp = `${STATUSLINE_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o755 })
    renameSync(tmp, STATUSLINE_PATH)
    chmodSync(STATUSLINE_PATH, 0o755)
  } catch {
    /* 설치 실패가 팀 채널 동작을 막아선 안 된다 — doctor 가 미설정으로 안내한다 */
  }
}

/** 요청 응답 타임아웃 — 테스트에서 줄일 수 있게 env 로 노출 */
const REQUEST_TIMEOUT_MS = Number(process.env.TEAM_RELAY_REQUEST_TIMEOUT_MS ?? 5000)


let protocolCache = loadProtocolCache()
if (!protocolCache) {
  const cfg0 = loadConfig()
  if (cfg0) {
    protocolCache = await fetchProtocolOnce(cfg0, PROTOCOL_TIMEOUT_MS)
    if (protocolCache) {
      try { saveProtocolCache(protocolCache) } catch { /* 캐시 실패는 기동을 막지 않는다 */ }
    }
  }
}

/** 현재 이 세션이 잡은 담당 방 (welcome/room_ok 가 알려준 값) */
let heldRooms: string[] = []

/** 마지막 치명 사유 — statusline 이 "왜 안 되는지"까지 보여줄 수 있게 (v0.7 §3.3) */
let lastError: string | null = null
/** 서버가 알려준 부가 상태 — 하트비트(doctor)가 갱신한다 */
let lastEmpty: string[] = []
let lastQueued = 0
let lastAway = false

/**
 * 상태 파일 내보내기 — 플러그인 밖(statusline)에서 읽는다.
 * 호출은 싸고(파일 1개 rename) 실패해도 삼키므로, 상태가 바뀌는 자리마다 부담 없이 부른다.
 */
/**
 * 방 3상태 — 서버에 doctor 1프레임을 물어 계산한다.
 * 연결이 없으면 로컬 캐시만으로 추정한다(이 세션 담당은 알고, 남의 세션은 모른다).
 */
async function roomStatuses(cfg: Config): Promise<ReturnType<typeof classifyRooms>> {
  const rooms = cfg.rooms ?? {}
  if (!wsReady) await connectWithConfig()
  if (!wsReady) return classifyRooms(rooms, heldRooms, [])
  try {
    const d = await request({ type: 'doctor' })
    if (d.type !== 'doctor') return classifyRooms(rooms, heldRooms, [])
    return classifyRooms(
      (d.rooms ?? rooms) as Record<string, string>,
      (d.held as string[] | undefined) ?? heldRooms,
      (d.heldByOther as string[] | undefined) ?? [],
    )
  } catch {
    return classifyRooms(rooms, heldRooms, [])
  }
}

function exportState(): void {
  const cfg = loadConfig()
  const state: SessionState = {
    updatedAt: Date.now(),
    sessionId: host.sessionId,
    /* 세션 id 는 어긋날 수 있다 — 상태줄이 확실히 짝을 찾는 열쇠는 이쪽이다 */
    ppid: process.ppid,
    connected: wsReady,
    gateway: host.isGateway,
    held: [...heldRooms],
    rooms: cfg?.rooms ?? {},
    empty: [...lastEmpty],
    queued: lastQueued,
    away: lastAway,
    lastError,
  }
  writeState(state)
}

/**
 * welcome 반영 — 서버가 진실인 방·라벨을 로컬 캐시에 저장하고, 실제 담당(held)을 기록한다.
 * 담당을 못 잡은 방(lost)이 있으면 사용자에게 알린다 (다른 세션이 가져간 상태를 조용히 두지 않는다).
 */
function applyWelcome(frame: RelayFrame): void {
  const cfg = loadConfig()
  if (!cfg) return
  const rooms = (frame.rooms ?? {}) as Record<string, string>
  heldRooms = ((frame.held as string[] | undefined) ?? []).slice()
  const lost = (frame.lost as string[] | undefined) ?? []
  let next: Config = { ...cfg, rooms }
  delete next.name // v1 잔재 제거
  if (heldRooms.length) next = bindRooms(next, heldRooms)
  try { saveConfig(next, { roomsFromServer: true }) } catch { /* 저장 실패는 동작을 막지 않는다 */ }
  if (lost.length) {
    void host.notify(
      `[담당 실패] 다음 방은 이 세션이 수신을 맡지 못했습니다: ${lost.join(', ')} — 대개 다른 세션이 이미 그 방을 담당 중이기 때문입니다(세션 시작만으로는 남의 담당을 뺏지 않습니다). 이 세션으로 가져오려면 team_room 을 실행하세요 — 그때는 그 세션이 수신을 잃습니다. 참가하지 않은 방이라면 초대코드가 필요합니다.`,
      { kind: 'system' },
    )
  }
}

/** welcome 의 protocol 로 캐시 갱신 — 이번 세션은 그대로, 다음 세션 기동에 반영된다 */
function maybeUpdateProtocolCache(frame: RelayFrame): void {
  const p = frame.protocol as { rev?: number; instructions?: string } | undefined
  if (!p || typeof p.instructions !== 'string') return
  const next = { rev: Number(p.rev ?? 0), instructions: p.instructions }
  if (protocolCache && protocolCache.rev === next.rev) return
  protocolCache = next
  try {
    saveProtocolCache(next)
    log(`규약 rev ${next.rev} 캐시 저장 — 다음 세션 기동부터 적용`)
  } catch (e) {
    log(`규약 캐시 저장 실패: ${(e as Error).message}`)
  }
}


// ── MCP 서버 ─────────────────────────────────────────────
const mcp = new Server(
  { name: 'team-relay', version: PLUGIN_VERSION },
  {
    capabilities: {
      // 이 키가 채널 등록의 전부. claude/channel/permission 은 의도적으로 미선언 —
      // 선언하면 팀원이 이 세션의 도구 실행을 원격 승인할 수 있게 된다 (보안 경계 — 추가 금지).
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    // 규약 전문은 서버(relay/protocol.md)가 배포한다 — 캐시/선접속으로 받아오고,
    // 못 받으면 보안 경계 조항만 담은 내장 폴백으로 기동한다 (thin client, v1 §2.4)
    instructions: protocolCache?.instructions ?? FALLBACK_INSTRUCTIONS,
  },
)

/** 호스트 경계 — Claude Code 결합은 전부 여기 뒤에 있다 (v0.7 §3.1) */
const host = createClaudeHost(mcp)

// ── 중계 서버 링크 ────────────────────────────────────────

let ws: WebSocket | null = null
let wsReady = false
let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** 진행 중인 연결 시도의 공유 Promise — 소켓은 하나만 열리고, 뒤에 온 호출자는 같은 시도를 기다린다 */
let connectPromise: Promise<RelayFrame | null> | null = null
/** 진행 중 시도의 종결자 — 실패 시 fallback 을 기다리지 않고 즉시 정리 */
let finishConnect: ((v: RelayFrame | null) => void) | null = null
/** 의도적으로 닫는 소켓 — close 리스너가 재접속을 걸지 않아야 하는 것들 (join 교체·취소) */
const deliberateClose = new WeakSet<WebSocket>()
/** join 연결 타임아웃 — 테스트에서 줄일 수 있게 env 로 노출 */
const JOIN_TIMEOUT_MS = Number(process.env.TEAM_RELAY_JOIN_TIMEOUT_MS ?? 5000)
/** 연결 세대 — join/서버변경 이전에 시작된 연결 시도는 늦게 성공해도 채택하지 않는다 */
let connectEpoch = 0
/** 진행 중 연결 시도의 소켓 — join/서버변경이 즉시 취소할 수 있도록 추적 */
let connectingSock: WebSocket | null = null
/**
 * 자동 재접속 정지 — 회복 불가능한 인증 실패(auth_failed·plugin_outdated·revoked) 후에는
 * 폐기된 토큰으로 30초마다 무한 재시도하지 않는다 (리뷰 m1). 사용자의 명시 행동
 * (join/서버변경 = abandonCurrentLink)이 해제한다.
 */
let reconnectHalted = false
/**
 * join 진행 중 표식 — join 이 소켓을 점유한 동안 다른 도구 호출의 connectWithConfig 가
 * 옛 설정으로 소켓을 열어 ws 를 덮어쓰는 경합을 차단한다 (리뷰 M1).
 */
let joinInProgress = false

/**
 * v1 요청 id 매칭 — 응답은 요청 id 로 짝짓는다. 타임아웃으로 폐기된 id 의 늦은 응답은
 * 버린다(오배정 방지). push 프레임(message·expired·박탈 통지)은 id 없이 온다.
 */
let nextReqId = 0
const pending = new Map<number, { resolve: (f: RelayFrame) => void; timer: ReturnType<typeof setTimeout> }>()

function log(msg: string): void {
  process.stderr.write(`team-relay: ${msg}\n`)
}

async function deliverToSession(frame: RelayFrame): Promise<void> {
  const meta: Record<string, string> = {
    from: String(frame.from ?? ''),
    room: String(frame.room ?? ''),
    ts: String(frame.ts ?? ''),
  }
  if (frame.queued) meta.queued = 'true'
  // 스레드·답기대 — 답장 시 thread 보존, expect=none 이면 답장 불필요 (v1 §3.1)
  if (frame.thread) meta.thread = String(frame.thread)
  if (frame.expect) meta.expect = String(frame.expect)
  // 메시지 구분자 — notice(공지)·agree_propose(합의 제안) 등 (v1 §6.2·§6.3)
  if (frame.kind) meta.kind = String(frame.kind)
  if (frame.agree) meta.agree = String(frame.agree)
  // 서버발 시스템 통지(from=_system)는 팀원 메시지와 구분되도록 표식을 붙인다
  if (frame.from === '_system') meta.kind = 'system'
  await host.notify(String(frame.text ?? ''), meta)
}

/** 게이트웨이 상실(replaced/revoke) 통지 — 자동 재접속은 하지 않는다 */
async function notifyGatewayLost(reason: string): Promise<void> {
  const text =
    reason === 'revoked'
      ? '[팀 연결 종료] 관리자가 이 계정의 접속을 차단했습니다. 팀 메시지 수신·발신이 중단됩니다.'
      : '[팀 수신 이전] 다른 claude-team 세션이 팀 수신(게이트웨이)을 가져갔습니다. 이 세션은 더 이상 팀 메시지를 받지 않습니다. 이 세션에서 다시 받으려면 /team-relay:status 를 실행하세요(그러면 다른 세션이 수신을 잃습니다). 세션은 하나만 게이트웨이로 두는 것을 권장합니다.'
  await host.notify(text, { kind: 'system' })
}

/** 보관 만료 통지 렌더 — 조용한 증발 금지. meta 키는 식별자만(하이픈 금지). */
async function deliverExpired(frame: RelayFrame): Promise<void> {
  const to = String(frame.to ?? '')
  await host.notify(
    `[보관 만료] ${to} 에게 보낸 메시지가 기한 내 배달되지 못해 폐기되었습니다: ${String(frame.preview ?? '')}`,
    { kind: 'expired', to, room: String(frame.room ?? '') },
  )
}

function handleFrame(frame: RelayFrame, sock?: WebSocket): void {
  if (frame.type === 'message') {
    void deliverToSession(frame)
    return
  }
  // expired 는 push — in-flight 응답으로 오소비 금지
  if (frame.type === 'expired') {
    void deliverExpired(frame)
    return
  }
  // room_lost push — 다른 세션이 이 방 담당을 가져갔다 (v2)
  if (frame.type === 'room_lost') {
    const room = String(frame.room ?? '')
    heldRooms = heldRooms.filter(r => r !== room)
    exportState()
    void host.notify(
      `[수신 이전] '${room}' 방의 수신을 다른 세션이 가져갔습니다. 이 세션은 그 방 메시지를 더 이상 받지 않습니다. 이 세션에서 다시 받으려면 team_room 으로 담당을 되찾으세요(그러면 그 세션이 수신을 잃습니다).`,
      { kind: 'system', room },
    )
    return
  }
  // noack push — 내 발신이 기한 내 응답을 못 받았다는 통지 (v1 §3.3)
  if (frame.type === 'noack') {
    void host.notify(
      `[무응답] ${String(frame.to ?? '')}이(가) 아직 답하지 않았습니다 — 세션이 한도 초과·장기 작업·자리 비움 상태일 수 있습니다. 기다릴지, 다른 사람에게 물을지 사용자에게 알려 판단을 받아라. 재발신을 자의로 반복하지 마라.`,
      { kind: 'noack', to: String(frame.to ?? ''), room: String(frame.room ?? ''), thread: String(frame.thread ?? '') },
    )
    return
  }
  // 게이트웨이 박탈(replaced)·차단(revoked) — 재접속하지 않고(핑퐁 방지) 사용자에게 알린다
  if (frame.type === 'error' && (frame.reason === 'replaced_by_new_gateway' || frame.reason === 'revoked')) {
    // 이 통지가 도착한 소켓이 현재 링크일 때만 박탈 처리 (리뷰 C1) — 유령(옛) 소켓으로 온
    // 통지가 멀쩡한 새 링크를 오염시키고 허위 '수신 이전' 알림을 내면 안 된다.
    if (sock && sock !== ws) {
      deliberateClose.add(sock)
      try { sock.close() } catch { /* 이미 닫힘 */ }
      return
    }
    if (ws) {
      deliberateClose.add(ws) // close 리스너가 재접속을 걸지 않게
      wsReady = false
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (frame.reason === 'revoked') reconnectHalted = true // 차단 — 도구 호출로도 루프 부활 금지 (m1)
    lastError = String(frame.reason)
    exportState()
    void notifyGatewayLost(String(frame.reason))
    return
  }
  const id = frame.id
  if (typeof id === 'number' && pending.has(id)) {
    const p = pending.get(id)!
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(frame)
    return
  }
  // 짝 없는 프레임 — 서버 통지(무id error) 또는 타임아웃으로 폐기된 늦은 응답(오배정 방지 폐기)
  if (frame.type === 'error') log(`서버 통지: ${String(frame.detail ?? frame.reason)}`)
}

function openSocket(url: string, onOpen: (sock: WebSocket) => void): WebSocket {
  const sock = new WS(url)
  sock.addEventListener('open', () => onOpen(sock))
  sock.addEventListener('message', ev => {
    try {
      handleFrame(JSON.parse(String(ev.data)) as RelayFrame, sock)
    } catch {
      log('잘못된 프레임 수신 (무시)')
    }
  })
  sock.addEventListener('close', () => {
    // 진행 중이던 연결 시도를 즉시 종결 — 안 하면 다음 재시도가 죽은 Promise 를 기다린다
    finishConnect?.(null)
    if (deliberateClose.has(sock)) return
    if (ws === sock) {
      ws = null
      wsReady = false
      scheduleReconnect()
    } else if (ws === null) {
      // 연결 수립 전 실패한 소켓도 재시도를 걸어야 재접속 사슬이 살아 있다
      scheduleReconnect()
    }
  })
  sock.addEventListener('error', () => {
    /* close 가 뒤따른다 */
  })
  return sock
}

function scheduleReconnect(): void {
  if (reconnectHalted || reconnectTimer || !loadConfig()) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    void connectWithConfig()
  }, reconnectDelay)
}

/** 저장된 설정으로 접속 + hello 인증. 성공 시 welcome 프레임 반환. */
async function connectWithConfig(): Promise<RelayFrame | null> {
  const cfg = loadConfig()
  if (!cfg) return null
  if (joinInProgress) return null // join 이 소켓을 점유 중 — 옛 설정으로 덮어쓰지 않는다 (리뷰 M1)
  if (ws && wsReady) return null
  if (connectPromise) return connectPromise // 진행 중인 시도에 합류 (경합·즉시이탈 둘 다 방지)
  const epoch = connectEpoch
  connectPromise = new Promise(resolve => {
    let settled = false
    const finish = (v: RelayFrame | null): void => {
      if (settled) return
      settled = true
      connectPromise = null
      finishConnect = null
      clearTimeout(fallback)
      resolve(v)
    }
    finishConnect = finish
    // 실패 경로는 close 리스너가 즉시 종결 — 이 fallback 은 그마저 안 올 때의 안전망
    const fallback = setTimeout(() => finish(null), 5000)
    connectingSock = openSocket(cfg.url, s => {
      if (connectingSock === s) connectingSock = null
      // 구세대(그 사이 join/서버변경) 또는 이미 종결된 시도 — 채택 금지
      if (epoch !== connectEpoch || settled) {
        deliberateClose.add(s)
        s.close()
        finish(null)
        return
      }
      ws = s
      void request({
        type: 'hello', v: PROTO, plugin: PLUGIN_VERSION, token: cfg.token, gateway: host.isGateway,
        session: host.sessionId, rooms: host.isGateway ? myRooms(cfg) : [],
      }).then(
        frame => {
          if (frame.type === 'welcome') {
            wsReady = true
            reconnectDelay = 1000
            reconnectHalted = false
            applyWelcome(frame)
            lastError = null
            exportState()
            if (Number(frame.v) > PROTO) log(`서버 프로토콜(v${frame.v})이 플러그인(v${PROTO})보다 새 버전 — /plugin update 권장`)
            maybeUpdateProtocolCache(frame)
            log(`'${cfg.name}' 으로 접속 완료 (${cfg.url})`)
          } else {
            log(`인증 실패: ${String(frame.detail ?? frame.reason ?? frame.type)}`)
            // 회복 불가능한 인증 실패 — 이 소켓을 폐기하고 자동 재접속을 멈춘다 (리뷰 m1)
            if (frame.reason === 'auth_failed' || frame.reason === 'plugin_outdated') {
              reconnectHalted = true
              lastError = String(frame.reason)
              exportState()
              deliberateClose.add(s)
              if (ws === s) { ws = null; wsReady = false }
              try { s.close() } catch { /* 서버가 이미 닫음 */ }
            }
          }
          finish(frame)
        },
        () => {
          // hello 무응답 타임아웃 — 유령 소켓을 남기지 않는다 (리뷰 C1). 소켓을 닫고
          // 현재 링크에서 해제한 뒤 정상 백오프로 재시도한다.
          deliberateClose.add(s)
          if (ws === s) { ws = null; wsReady = false }
          try { s.close() } catch { /* 이미 닫힘 */ }
          finish(null)
          scheduleReconnect()
        },
      )
    })
  })
  return connectPromise
}

/** 요청 발신 — id 를 부여하고 같은 id 의 응답 또는 타임아웃으로 종결 (동시 요청 허용) */
function request(obj: Record<string, unknown>): Promise<RelayFrame> {
  return new Promise((resolve, reject) => {
    if (!ws) {
      reject(new Error('중계 서버에 연결돼 있지 않습니다'))
      return
    }
    const id = ++nextReqId
    const timer = setTimeout(() => {
      pending.delete(id) // 폐기 — 이 id 의 늦은 응답은 handleFrame 이 버린다
      reject(new Error(`중계 서버 응답 타임아웃(${REQUEST_TIMEOUT_MS / 1000}초)`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    ws.send(JSON.stringify({ ...obj, id }))
  })
}

/** 현재 링크·진행 중 시도를 전부 폐기하고 세대를 올린다 — join/서버변경의 선행 절차 */
function abandonCurrentLink(): void {
  connectEpoch += 1
  reconnectHalted = false // join/서버변경 = 사용자의 명시적 재시도 의사 — 정지 해제 (m1)
  // 폐기된 링크의 in-flight 요청 전부 즉시 종결 (체인 블로킹 방지)
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.resolve({ type: 'error', reason: 'link_abandoned' })
  }
  pending.clear()
  finishConnect?.(null)
  if (connectingSock) {
    deliberateClose.add(connectingSock)
    connectingSock.close()
    connectingSock = null
  }
  if (ws) {
    const old = ws
    ws = null
    wsReady = false
    deliberateClose.add(old)
    old.close()
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectDelay = 1000
}

// ── 도구 ─────────────────────────────────────────────────
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'team_join',
      description:
        '초대코드로 팀 중계 서버에 참가한다 (최초 1회 또는 추가 방 합류). 성공하면 토큰이 저장되고 이후 세션마다 자동 접속된다.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: '중계 서버 주소 (예: 10.0.1.23:8765)' },
          code: { type: 'string', description: '관리자에게 받은 일회용 초대코드 (TR-…)' },
        },
        required: ['address', 'code'],
      },
    },
    {
      name: 'team_send',
      description: '팀원의 Claude Code 세션에 메시지를 보낸다. 상대가 오프라인이면 중계 서버가 보관 후 접속 시 배달한다.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '받는 팀원 이름' },
          message: { type: 'string', description: '보낼 내용 (평문)' },
          room: {
            type: 'string',
            description:
              '방 꼬리표 힌트 (선택) — 답장 시 수신 메시지 태그의 room 값을 그대로 넣는다. 생략하면 서버가 공유 방 중 첫 번째를 쓴다.',
          },
          thread: {
            type: 'string',
            description: '스레드 id (선택) — 답장 시 수신 메시지 태그의 thread 값을 그대로 넣는다. 새 질문이면 생략(서버가 생성).',
          },
          expect: {
            type: 'string',
            enum: ['reply', 'none'],
            description:
              '답 기대 여부 (선택) — 질문·요청이면 reply, 단순 전달·공유면 none. 생략 시 서버 기본값: 새 스레드=reply, 답장=none.',
          },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'team_ack',
      description:
        '받은 팀 질문에 아직 답하지 못할 때 수신 확인을 보낸다 — 즉답이 어려우면 status:working, 자동답장 off 로 사용자 승인 대기면 status:approval_pending. 발신자의 무응답 알림을 막는다.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: '수신 메시지 태그의 thread 값' },
          status: { type: 'string', enum: ['working', 'approval_pending'], description: '처리 상태' },
        },
        required: ['thread', 'status'],
      },
    },
    {
      name: 'team_away',
      description:
        '퇴근/출근 전환. 퇴근(on)이면 세션이 켜져 있어도 팀 메시지가 서버에 보관되고(보관 기한 정지), 출근(off)하면 한꺼번에 배달된다. 퇴근 중에도 발신은 가능하다.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['on', 'off'], description: 'on = 퇴근(수신 보관) · off = 출근(보관분 배달)' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'team_route',
      description:
        '로컬 라우팅 등록표 관리 — 팀 질문의 키워드 또는 방(room)을 이 머신의 담당 세션에 매핑한다 (3단 위임의 1단, 방 바인딩이 키워드보다 우선). 팀 질문이 내 소관이 아니면 action:"list" 로 먼저 확인한다.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'], description: '수행할 동작' },
          keywords: { type: 'string', description: '매칭 키워드 (add·remove — keywords 또는 room 중 하나)' },
          room: { type: 'string', description: '방 바인딩 — 이 방 꼬리표의 질문을 지정 세션으로 (키워드보다 우선)' },
          session: { type: 'string', description: '위임받을 세션 이름 (add 에 필요)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'team_server',
      description:
        '중계 서버 주소를 변경한다 (서버 이사 — 초대코드 불필요, 기존 토큰 유지). 이사한 서버는 명부 데이터를 그대로 가져가므로 재참가가 아니라 주소 갱신이다.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: '새 중계 서버 주소 (예: 10.0.2.50:8765)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'team_room',
      description:
        '이 세션이 담당할 방을 지정한다 (초대코드 불필요 — 이미 참가한 방 중에서). 새 세션에서 "어느 방 메시지를 받을지" 고르는 도구. --resume 으로 재시작하면 담당이 자동 복원되므로 보통은 쓸 일이 없다.',
      inputSchema: {
        type: 'object',
        properties: {
          rooms: { type: 'string', description: '담당할 방 이름 (여러 개면 쉼표로 구분). 생략하면 현재 담당·참가 방을 보여준다' },
        },
      },
    },
    {
      name: 'team_owner',
      description:
        '방장 전용 — 내가 방장인 방의 초대코드 발급(invite)·방 단위 추방(kick, 전역 차단 아님)·방 전원 공지(notice). 방장 지정은 서버 관리자가 한다.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['invite', 'kick', 'notice'], description: '수행할 동작' },
          room: { type: 'string', description: '대상 방 (내가 방장인 방)' },
          name: { type: 'string', description: 'invite: 새 팀원 이름 · kick: 제외할 팀원 이름' },
          text: { type: 'string', description: 'notice: 공지 내용' },
        },
        required: ['action', 'room'],
      },
    },
    {
      name: 'team_agree',
      description:
        '팀 인터페이스 합의 대장 — 문답으로 도달한 합의를 양측 확인으로 확정 기록한다. propose(제안, 상대 확인 필요) · confirm/reject(받은 제안 처리 — 직전 대화와 대조 후) · list(확정 합의는 같은 방 전원 열람).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['propose', 'confirm', 'reject', 'list'], description: '수행할 동작' },
          to: { type: 'string', description: 'propose: 합의 상대 팀원 이름' },
          summary: { type: 'string', description: 'propose: 합의 내용 한 문장 (예: "source_ref 는 string[] · 빈 배열 허용")' },
          details: { type: 'string', description: 'propose: 상세 (선택 — 스키마·예시 등)' },
          thread: { type: 'string', description: 'propose: 이 합의가 나온 문답의 thread (선택)' },
          room: { type: 'string', description: 'propose: 방 지정 (선택)' },
          agree_id: { type: 'string', description: 'confirm·reject: 받은 제안의 agree id (수신 meta 의 agree)' },
          reason: { type: 'string', description: 'reject: 거절 사유 — 대화와 어떻게 다른지' },
          peer: { type: 'string', description: 'list: 당사자 필터 (선택)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'team_history',
      description:
        '내가 주고받은 팀 메시지 히스토리를 조회한다 (내 문답만 — 제3자 대화 불가). 과거에 물었던 내용은 상대에게 재질문하기 전에 여기서 먼저 확인한다.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '상대 팀원 이름 필터 (선택)' },
          room: { type: 'string', description: '방 필터 (선택)' },
          thread: { type: 'string', description: '스레드 필터 (선택) — 특정 문답만' },
          limit: { type: 'string', description: '최근 N건 (기본 20 · 최대 100)' },
          before: { type: 'string', description: '이 ts(밀리초) 이전만 — 이전 페이지 조회용' },
        },
      },
    },
    {
      name: 'team_doctor',
      description:
        '팀 연결 자가 진단 — 설정·게이트웨이 선언·규약·서버 연결·보관 큐를 ✓/✗ 로 점검하고 문제마다 처방을 제시한다. "팀 메시지가 안 와요" 류 문제의 1차 진단 도구.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'team_status',
      description:
        '팀 연결 상태 — 내 이름·소속 방·방별 온라인/오프라인 팀원·자동답장 토글. auto_reply 파라미터로 자동답장을 전환할 수 있다.',
      inputSchema: {
        type: 'object',
        properties: {
          auto_reply: {
            type: 'string',
            enum: ['on', 'off'],
            description: '자동답장 토글 전환 (선택) — off 면 답장 전 사용자 승인이 필요해진다',
          },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, string>
  switch (req.params.name) {
    case 'team_join': {
      const url = normalizeUrl(args.address ?? '')
      const existing = loadConfig()
      // 기존 링크·진행 중 시도 전부 폐기 + 세대 상승
      abandonCurrentLink()
      // join 이 끝날 때까지 다른 도구 호출의 접속 시도를 차단 — 옛 설정 소켓이
      // join 의 ws 를 덮어쓰는 경합 방지 (리뷰 M1)
      joinInProgress = true
      try {
      const joined = await new Promise<RelayFrame>((resolve, reject) => {
        // 타임아웃 후 유령 소켓의 join 발신 금지 (초대코드 소모 방지)
        let cancelled = false
        const t = setTimeout(() => {
          cancelled = true
          joinSock.close() // 생성 직후 deliberateClose 등록됨 — 재접속 안 걸림
          reject(new Error(`중계 서버(${url})에 연결할 수 없습니다`))
        }, JOIN_TIMEOUT_MS)
        const joinSock = openSocket(url, s => {
          if (cancelled) {
            s.close()
            return
          }
          clearTimeout(t)
          deliberateClose.delete(s) // 채택 — 이후 이 소켓의 close 는 정상 재접속 대상
          ws = s
          void request({ type: 'join', v: PROTO, plugin: PLUGIN_VERSION, code: args.code ?? '', token: existing?.token }).then(resolve, reject)
        })
        // 조기 실패가 옛 설정으로의 재접속을 걸지 않도록 선등록 (채택 시 해제)
        deliberateClose.add(joinSock)
      })
      if (joined.type !== 'joined') {
        return ok(`✗ 참가 실패: ${String(joined.detail ?? joined.reason ?? joined.type)}`)
      }
      const token = (joined.token as string | undefined) ?? existing?.token
      if (!token) return ok('✗ 서버가 토큰을 주지 않았고 기존 토큰도 없습니다 — 관리자에게 문의')
      // 라우팅 등록표·자동답장 토글 등 로컬 설정은 재참가해도 보존한다.
      // v2: 토큰은 머신당 하나(불변), rooms 는 서버가 준 방→라벨, 이 세션은 새 방을 담당한다.
      const joinedRooms = (joined.rooms ?? {}) as Record<string, string>
      const newRoom = Object.keys(joinedRooms).find(r => !(existing?.rooms ?? {})[r]) ?? Object.keys(joinedRooms)[0]
      let cfgNext: Config = { ...(existing ?? {}), url, token, rooms: joinedRooms }
      delete cfgNext.name
      if (newRoom) cfgNext = bindRooms(cfgNext, [newRoom])
      saveConfig(cfgNext, { roomsFromServer: true })
      // 후속 hello 실패는 참가 실패가 아니다 (리뷰 m2) — 초대코드는 이미 소모·토큰은 저장됨.
      // 원시 예외로 터뜨리면 사용자가 재발급을 요청하는 헛걸음을 하게 된다.
      let welcome: RelayFrame | null = null
      try {
        welcome = await request({
          type: 'hello', v: PROTO, plugin: PLUGIN_VERSION, token, gateway: host.isGateway,
          session: host.sessionId, rooms: newRoom ? [newRoom] : [],
        })
      } catch {
        // hello 무응답 — 유령 소켓을 남기지 않고(리뷰 C1) 백그라운드 재시도로 넘긴다
        if (ws) {
          deliberateClose.add(ws)
          try { ws.close() } catch { /* 이미 닫힘 */ }
          ws = null
          wsReady = false
        }
        scheduleReconnect()
      }
      if (welcome?.type !== 'welcome') {
        return ok(
          `✓ '${newRoom}' 방에 '${joined.name}' 으로 참가 완료. 토큰이 저장됐고 초대코드는 정상 소모됐으니 재발급은 필요 없습니다.\n` +
            '다만 접속 확인 응답이 아직 없어 백그라운드에서 자동 재시도합니다 — 세션 재시작으로도 해결됩니다.',
        )
      }
      wsReady = true
      applyWelcome(welcome)
      maybeUpdateProtocolCache(welcome)
      return ok(
        `✓ '${newRoom}' 방에 '${joined.name}' 으로 참가 완료\n` +
          `  이 세션이 '${newRoom}' 담당입니다 (resume 하면 유지 · 새 세션은 team_room 으로 지정)\n` +
          `  내 소속 방: ${Object.entries(joinedRooms).map(([r, l]) => `${r}(${l})`).join(', ')}\n${formatRoster(welcome)}`,
      )
      } finally {
        joinInProgress = false
      }
    }
    case 'team_send': {
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — /team-relay:join 으로 먼저 참가하세요')
      const frame: Record<string, unknown> = { type: 'send', to: args.to ?? '', text: args.message ?? '' }
      // room·thread·expect 는 지정됐을 때만 와이어에 싣는다 (생략 시 서버 기본값에 위임)
      if (args.room) frame.room = args.room
      if (args.thread) frame.thread = args.thread
      if (args.expect === 'reply' || args.expect === 'none') frame.expect = args.expect
      const res = await request(frame)
      if (res.type === 'sent') {
        const base =
          res.state === 'delivered'
            ? `✓ ${args.to} 에게 즉시 배달됨 (스레드 ${res.thread})`
            : `✓ ${args.to} 는 오프라인 — 중계 서버가 보관, 접속 시 배달됩니다 (스레드 ${res.thread})`
        // 서버가 붙인 상태 노트 — 발신자가 기다릴지 판단할 재료
        const warn =
          res.note === 'unresponsive'
            ? '\n⚠️ 상대가 최근 무응답 상태로 보입니다 (한도 초과·장기 작업·자리 비움 가능) — 답이 늦을 수 있습니다'
            : res.note === 'away'
              ? `\n🌙 ${args.to} 는 퇴근 상태 — 출근 시 배달됩니다`
              : ''
        return ok(base + warn)
      }
      const reason = String(res.reason ?? '')
      if (reason.startsWith('no_shared_room')) return ok(`✗ ${args.to} 와(과) 같은 방이 아닙니다 — 보낼 수 없습니다`)
      if (reason.startsWith('room_not_shared')) return ok(`✗ '${args.room}' 은(는) ${args.to} 와(과) 공유하는 방이 아닙니다 — room 을 빼거나 공유 방을 넣으세요`)
      if (reason.startsWith('unknown_member')) return ok(`✗ '${args.to}' 라는 팀원이 없습니다 (team_status 로 확인)`)
      return ok(`✗ 발신 실패: ${reason}`)
    }
    case 'team_ack': {
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — /team-relay:join 으로 먼저 참가하세요')
      const res = await request({ type: 'ack', thread: args.thread ?? '', status: args.status ?? 'working' })
      if (res.type === 'ack_ok') return ok(`✓ 수신 확인 전송됨 (스레드 ${args.thread}) — 발신자의 무응답 알림이 해제됩니다`)
      return ok(`✗ 수신 확인 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
    }
    case 'team_away': {
      if (args.mode !== 'on' && args.mode !== 'off') return ok('✗ mode 는 "on"(퇴근) 또는 "off"(출근)만 허용됩니다')
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — /team-relay:join 으로 먼저 참가하세요')
      const res = await request({ type: 'away', on: args.mode === 'on' })
      if (res.type !== 'away_ok') return ok(`✗ 전환 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
      lastAway = !!res.away
      exportState()
      return ok(
        res.away
          ? '🌙 퇴근 처리 완료 — 팀 메시지는 서버에 보관되고(보관 기한 정지) 출근 시 배달됩니다. 발신은 계속 가능합니다.'
          : `✓ 출근 처리 완료 — 보관 ${Number(res.pending ?? 0)}건이 곧 배달됩니다. 여러 건이면 개별 반응 전에 부재중 브리핑부터 사용자에게 보고하세요.`,
      )
    }
    case 'team_route': {
      const cfg = loadConfig()
      if (!cfg) return ok('✗ 아직 팀에 참가하지 않았습니다 — /team-relay:join 으로 먼저 참가하세요')
      const routes = cfg.routes ?? []
      switch (args.action) {
        case 'list': {
          const rendered = renderRoutes(routes)
          if (!rendered) return ok('라우팅 등록표가 비어 있습니다 — team_route(action:"add") 로 등록할 수 있습니다')
          return ok(rendered)
        }
        case 'add': {
          if ((!args.keywords && !args.room) || !args.session) {
            return ok('✗ add 에는 session 과 함께 keywords 또는 room 중 하나 이상이 필요합니다')
          }
          const r = addRoute(routes, args.session, args.keywords, args.room)
          saveConfig({ ...cfg, routes: r.routes })
          return ok(`✓ 등록${r.replaced ? ' (기존 항목 교체)' : ''}: ${labelOf(r.entry)}`)
        }
        case 'remove': {
          if (!args.keywords && !args.room) return ok('✗ remove 에는 keywords 또는 room 이 필요합니다')
          const r = removeRoute(routes, args.keywords, args.room)
          if (!r.removed) return ok(`✗ 해당 등록 항목이 없습니다 (action:"list" 로 확인)`)
          saveConfig({ ...cfg, routes: r.routes })
          return ok(`✓ 제거: ${args.room ? `[방 ${args.room}]` : `"${args.keywords}"`}`)
        }
        default:
          return ok(`✗ 알 수 없는 action: ${args.action ?? '(없음)'} — list|add|remove 중 하나`)
      }
    }
    case 'team_server': {
      // 서버 이사 — 토큰·이름·라우팅표는 유지, 주소만 갱신
      const cfg = loadConfig()
      if (!cfg) return ok('✗ 아직 팀에 참가하지 않았습니다 — 이사가 아니라 최초 참가는 /team-relay:join <서버주소> <초대코드>')
      if (!args.address) return ok('✗ 새 서버 주소가 필요합니다 — /team-relay:server <서버주소>')
      const url = normalizeUrl(args.address)
      saveConfig({ ...cfg, url })
      abandonCurrentLink() // 옛 서버로의 시도·연결 전부 무효화
      const welcome = await connectWithConfig()
      if (welcome?.type === 'welcome') {
        return ok(`✓ 중계 서버를 ${url} 로 변경 — '${cfg.name}' 으로 접속 완료 (기존 토큰 유지)\n${formatRoster(welcome)}`)
      }
      return ok(`서버 주소를 ${url} 로 저장했습니다 — 지금은 연결되지 않아 백그라운드에서 자동 재시도합니다 (기존 토큰 유지)`)
    }
    case 'team_owner': {
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — /team-relay:join 으로 먼저 참가하세요')
      const room = args.room ?? ''
      const notOwner = (res: RelayFrame): string | null =>
        res.reason === 'not_room_owner' ? `✗ '${room}' 방의 방장이 아닙니다 — 방장 지정은 서버 관리자(relay room owner)가 합니다` : null
      switch (args.action) {
        case 'invite': {
          if (!args.name) return ok('✗ invite 에는 name(새 팀원 이름)이 필요합니다')
          const res = await request({ type: 'room_invite', room, name: args.name })
          if (res.type !== 'room_invite_ok') return ok(notOwner(res) ?? `✗ 초대 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
          return ok(`✓ 초대코드 (1회용 · '${room}' 방 · '${args.name}'):\n\n  ${res.code}\n\n팀원에게 전달하세요 → /team-relay:join <서버주소> ${res.code}`)
        }
        case 'kick': {
          if (!args.name) return ok('✗ kick 에는 name(제외할 팀원 이름)이 필요합니다')
          const res = await request({ type: 'room_kick', room, name: args.name })
          if (res.type !== 'room_kick_ok') {
            if (res.reason === 'not_in_room') return ok(`✗ '${args.name}'은(는) '${room}' 방 소속이 아닙니다`)
            return ok(notOwner(res) ?? `✗ 제외 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
          }
          return ok(`✓ '${args.name}'을(를) '${room}' 방에서 제외했습니다 (다른 방 소속·토큰은 유지 — 전역 차단은 관리자 revoke). 그 방 보관분은 폐기되고 발신자들에게 통지됩니다.`)
        }
        case 'notice': {
          if (!args.text) return ok('✗ notice 에는 text(공지 내용)가 필요합니다')
          const res = await request({ type: 'room_notice', room, text: args.text })
          if (res.type !== 'room_notice_ok') {
            if (res.reason === 'notice_rate_limited') return ok('✗ 공지 발송 한도 초과(분당 상한) — 잠시 후 다시 시도하세요')
            return ok(notOwner(res) ?? `✗ 공지 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
          }
          const skipped = (res.skipped as string[] | undefined) ?? []
          return ok(
            `✓ '${room}' 공지 발송 — 즉시 배달 ${res.delivered}명 · 보관 ${res.queued}명` +
              (skipped.length ? `\n⚠️ 보관함 만석으로 못 받은 팀원: ${skipped.join(', ')} — 직접 전달이 필요합니다` : ''),
          )
        }
        default:
          return ok(`✗ 알 수 없는 action: ${args.action ?? '(없음)'} — invite|kick|notice`)
      }
    }
    case 'team_room': {
      const cfg = loadConfig()
      if (!cfg) return ok('✗ 아직 팀에 참가하지 않았습니다 — /team-relay:join <서버주소> <초대코드>')
      const joinedRooms = cfg.rooms ?? {}
      /** 대화상자로 고른 값 — 인자로 온 rooms 보다 우선한다 */
      let chosen: string | null = null
      // 인자 없음 — 서버에 물어 3상태를 보여주고, 가능하면 **대화상자로 고르게 한다** (v0.7 §3.4)
      if (!args.rooms) {
        const list = await roomStatuses(cfg)
        const header = `이 세션 담당: ${heldRooms.length ? heldRooms.map(r => `${r}(${joinedRooms[r]})`).join(', ') : '(없음)'}`
        if (list.length === 0) return ok(`${header}\n참가 중인 방: (없음)`)
        const body = `${header}\n\n참가 중인 방 ${list.length}개\n${renderRooms(list)}`
        // 고를 것이 없으면(전부 이 세션 담당) 현황만 보여준다
        const selectable = list.filter(r => r.mark !== 'mine')
        if (selectable.length === 0) return ok(body)

        const NONE = '__none__'
        const picked = await host.choose({
          message: '이 세션이 받을 방을 고르세요',
          title: '담당할 방',
          options: [
            ...list.map(r => ({ value: r.room, label: choiceLabel(r) })),
            { value: NONE, label: '받지 않음 (발신 전용으로 둡니다)' },
          ],
        })
        if (picked === null) {
          // 선택 UI 미지원이거나 사용자가 취소 — 목록은 그대로 보여주고 수동 경로를 안내한다
          return ok(`${body}\n\n→ /team-relay:room <방이름> 으로 지정하세요`)
        }
        if (picked === NONE) return ok(`${body}\n\n담당을 변경하지 않았습니다 (이 세션은 발신 전용입니다)`)
        chosen = picked
      }
      const wanted = (chosen ?? args.rooms!).split(',').map(r => r.trim()).filter(Boolean)
      const notJoined = wanted.filter(r => !(r in joinedRooms))
      if (notJoined.length) {
        return ok(`✗ 참가하지 않은 방입니다: ${notJoined.join(', ')} — 관리자에게 초대코드를 받아 /team-relay:join 하세요`)
      }
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — 잠시 후 다시 시도하세요')
      const res = await request({ type: 'room', rooms: wanted })
      if (res.type !== 'room_ok') return ok(`✗ 담당 지정 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
      heldRooms = ((res.held as string[] | undefined) ?? []).slice()
      exportState()
      const lost = (res.lost as string[] | undefined) ?? []
      const stolen = (res.stolen as string[] | undefined) ?? []
      try { saveConfig(bindRooms(loadConfig() ?? cfg, heldRooms)) } catch { /* 저장 실패는 동작을 막지 않는다 */ }
      return ok(
        `✓ 이 세션 담당: ${heldRooms.map(r => `${r}(${joinedRooms[r]})`).join(', ') || '(없음)'}` +
          // 뺏어온 방은 반드시 밝힌다 — 상대 세션은 조용히 수신을 잃는다
          (stolen.length ? `\n↪ 다음 방의 수신을 다른 세션에서 가져왔습니다: ${stolen.join(', ')}` : '') +
          (lost.length ? `\n⚠️ 담당 실패: ${lost.join(', ')}` : '') +
          '\n이 담당은 --resume 으로 재시작하면 유지됩니다.',
      )
    }
    case 'team_agree': {
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — /team-relay:join 으로 먼저 참가하세요')
      switch (args.action) {
        case 'propose': {
          if (!args.to || !args.summary) return ok('✗ propose 에는 to 와 summary 가 필요합니다')
          const frame: Record<string, unknown> = { type: 'agree_propose', to: args.to, summary: args.summary }
          if (args.details) frame.details = args.details
          if (args.thread) frame.thread = args.thread
          if (args.room) frame.room = args.room
          const res = await request(frame)
          if (res.type !== 'agree_ok') return ok(`✗ 합의 제안 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
          return ok(
            res.state === 'delivered'
              ? `✓ 합의 제안 전달됨 (${res.agree}) — 상대 에이전트가 확인(confirm)하면 대장에 기록됩니다`
              : `✓ 합의 제안 보관됨 (${res.agree}) — 상대 접속 시 전달, 72시간 내 미확인이면 만료 통지가 옵니다`,
          )
        }
        case 'confirm':
        case 'reject': {
          if (!args.agree_id) return ok('✗ agree_id 가 필요합니다 (수신 메시지 meta 의 agree 값)')
          const frame: Record<string, unknown> = { type: 'agree_resolve', agree: args.agree_id, result: args.action }
          if (args.reason) frame.reason = args.reason
          const res = await request(frame)
          if (res.type !== 'agree_resolved') {
            if (res.reason === 'agree_not_found') return ok('✗ 해당 제안이 없습니다 — 이미 처리됐거나 만료됐습니다')
            if (res.reason === 'agree_not_mine') return ok('✗ 이 제안의 확인 당사자가 아닙니다')
            return ok(`✗ 처리 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
          }
          return ok(res.result === 'confirm' ? `✓ 합의 확정 (${res.agree}) — 대장에 기록되고 제안자에게 통지됩니다` : `✓ 합의 거절 처리 (${res.agree}) — 제안자에게 사유가 통지됩니다`)
        }
        case 'list': {
          const frame: Record<string, unknown> = { type: 'agree_list' }
          if (args.peer) frame.peer = args.peer
          const res = await request(frame)
          if (res.type !== 'agrees') return ok(`✗ 조회 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
          const entries = (res.entries ?? []) as Array<{ agree: string; ts: number; room: string; a: string; b: string; summary: string; details?: string }>
          const pending = (res.pending ?? []) as Array<{ agree: string; a: string; b: string; summary: string }>
          const lines: string[] = []
          if (entries.length) {
            lines.push(`확정 합의 (${entries.length}건):`)
            for (const e of entries) {
              const t = new Date(e.ts).toISOString().slice(0, 10)
              lines.push(`  [${t}] [${e.room}] ${e.a} ↔ ${e.b}: ${e.summary}${e.details ? ` — ${e.details}` : ''} (${e.agree})`)
            }
          } else {
            lines.push('확정 합의가 없습니다')
          }
          if (pending.length) {
            lines.push(`확인 대기 (당사자만 보임, ${pending.length}건):`)
            for (const p of pending) lines.push(`  ${p.a} → ${p.b}: ${p.summary} (${p.agree})`)
          }
          return ok(lines.join('\n'))
        }
        default:
          return ok(`✗ 알 수 없는 action: ${args.action ?? '(없음)'} — propose|confirm|reject|list`)
      }
    }
    case 'team_history': {
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok('✗ 중계 서버에 연결돼 있지 않습니다 — /team-relay:join 으로 먼저 참가하세요')
      const frame: Record<string, unknown> = { type: 'history' }
      if (args.peer) frame.peer = args.peer
      if (args.room) frame.room = args.room
      if (args.thread) frame.thread = args.thread
      if (args.limit && Number(args.limit) > 0) frame.limit = Number(args.limit)
      if (args.before && Number(args.before) > 0) frame.before = Number(args.before)
      const res = await request(frame)
      if (res.type !== 'history') {
        if (res.reason === 'history_disabled') return ok('✗ 이 서버는 감사 로그가 꺼져 있어 히스토리를 제공하지 않습니다')
        return ok(`✗ 히스토리 조회 실패: ${String(res.detail ?? res.reason ?? res.type)}`)
      }
      const entries = (res.entries ?? []) as Array<{ ts: number; room: string; from: string; to: string; text: string; thread?: string; truncated?: boolean }>
      if (entries.length === 0) return ok('조회 조건에 맞는 기록이 없습니다')
      const lines = entries.map(e => {
        const t = new Date(e.ts).toISOString().replace('T', ' ').slice(5, 16)
        const tail = [e.thread ? `t:${e.thread}` : null, e.truncated ? '(잘림)' : null].filter(Boolean).join(' ')
        return `  [${t}] [${e.room}] ${e.from} → ${e.to}: ${e.text}${tail ? ` ${tail}` : ''}`
      })
      if (res.more) {
        lines.push(`  … 이전 기록이 더 있습니다 — before:${entries[0]!.ts} 로 이전 페이지를 조회할 수 있습니다`)
      }
      return ok([`팀 메시지 히스토리 (${entries.length}건):`, ...lines].join('\n'))
    }
    case 'team_doctor': {
      // 부분 실패 허용 — 서버가 죽어 있어도 로컬 점검 결과는 반드시 출력한다 (§5.1)
      const lines: string[] = ['team-relay 자가 진단']
      const check = (good: boolean, label: string, detail: string, fix?: string): void => {
        lines.push(`  ${good ? '✓' : '✗'} ${label}: ${detail}`)
        if (!good && fix) lines.push(`     → ${fix}`)
      }
      // ── 로컬 점검 ──
      const cfg = loadConfig()
      if (!cfg) {
        check(false, '설정', `없음 또는 파싱 불가 (${CONFIG_PATH})`, '/team-relay:join <서버주소> <초대코드> 로 참가하세요')
      } else {
        const labels = Object.entries(cfg.rooms ?? {}).map(([r, l]) => `${r}(${l})`).join(', ')
        check(true, '설정', `${labels || '(참가한 방 없음)'} @ ${cfg.url}`)
        try {
          const mode = statSync(CONFIG_PATH).mode & 0o777
          check(mode === 0o600, '설정 권한', `0${mode.toString(8)}`, `chmod 600 ${CONFIG_PATH} 를 실행하세요 (토큰 보호)`)
        } catch { /* 존재는 위에서 확인됨 */ }
      }
      check(
        host.isGateway,
        '수신(게이트웨이) 선언',
        host.isGateway ? '예' : '아니요 — 이 세션은 발신 전용',
        '팀 메시지를 받으려면 claude 대신 claude-team 으로 세션을 켜세요 (의도된 발신 전용 세션이면 정상)',
      )
      check(true, '런타임', `${host.runtime} · 플러그인 v${PLUGIN_VERSION} · 프로토콜 v${PROTO}`)
      // 번들 배포본은 빌드 산출물이라, 리빌드를 빠뜨리면 소스와 조용히 어긋난다 (v0.7 §3.2 리스크)
      // 소스 실행은 plugin/, 번들 실행은 plugin/dist/ 에서 돌므로 두 자리를 모두 본다
      const pkgVersion = ((): string | null => {
        for (const dir of [PKG_DIR, dirname(PKG_DIR.replace(/\/$/, ''))]) {
          try {
            const v = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version
            if (v) return v
          } catch { /* 다음 자리 */ }
        }
        return null
      })()
      if (pkgVersion && pkgVersion !== PLUGIN_VERSION) {
        check(false, '번들 신선도', `번들 v${PLUGIN_VERSION} ≠ 패키지 v${pkgVersion}`,
          '배포본이 소스보다 낡았습니다 — 관리자에게 알리세요 (bun run build 누락)')
      }
      // /plugin update 는 디스크만 바꾼다. **이미 떠 있는 세션의 MCP 프로세스는 옛 코드를 계속
      // 물고 돈다** — 설치본 폴더에 더 새 버전이 있으면 이 세션은 재시작이 필요하다는 뜻이다.
      const newerInstalled = ((): string | null => {
        try {
          const versionsDir = dirname(dirname(PLUGIN_DIR)) // …/team-relay/<버전>/plugin → …/team-relay
          const cmp = (a: string, b: string): number => {
            const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
            for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
            return 0
          }
          const found = readdirSync(versionsDir)
            .filter(d => /^\d+\.\d+\.\d+$/.test(d) && cmp(d, PLUGIN_VERSION) > 0)
            .sort(cmp)
          return found.length ? found[found.length - 1]! : null
        } catch { return null }
      })()
      if (newerInstalled) {
        check(false, '실행 중 버전', `v${PLUGIN_VERSION} (설치본은 v${newerInstalled})`,
          '플러그인은 업데이트됐지만 이 세션은 옛 프로세스를 물고 있습니다 — Claude Code 를 완전히 종료한 뒤 다시 켜세요')
      }
      // 상태줄은 플러그인이 죽어도 보이는 유일한 창구다 — 미설정을 조용히 두지 않는다 (v0.7 §3.3)
      const settingsRaw = ((): string | null => {
        try { return readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8') } catch { return null }
      })()
      const slRegistered = !!settingsRaw && /"statusLine"/.test(settingsRaw) && /team-relay/.test(settingsRaw)
      check(slRegistered, '상태줄(statusline)', slRegistered ? '등록됨' : '미설정',
        `~/.claude/settings.json 에 아래를 넣고 Claude Code 를 재시작하세요 — 팀 연결이 끊겨도 상태줄이 알려줍니다:\n     "statusLine": { "type": "command", "command": "${STATUSLINE_CONFIG_PATH}" }`)
      /**
       * 상태줄이 읽는 **그 파일**을 적는다.
       *
       * doctor 는 플러그인 프로세스 안에서 돌고 상태줄은 파일을 읽는다 — 서로 다른 것을
       * 본다. 그래서 "doctor 는 다 ✓ 인데 상태줄은 ✗" 가 나올 수 있고, 실제로 나왔다
       * (플러그인은 state-fbc4f84e 에 쓰는데 상태줄은 state-0e86d25f 를 찾고 있었다).
       * 파일 이름을 적어 두면 그 어긋남이 한눈에 보인다.
       */
      const stateFile = statePath(host.sessionId).replace(/^.*\//, '')
      check(true, '상태 파일', `${stateFile} (30초마다 갱신)`)
      // 설치본 경로에는 버전이 들어간다 — 그 경로를 박아두면 업데이트할 때마다 깨진다
      if (slRegistered && /plugins\/cache\//.test(settingsRaw!)) {
        check(false, '상태줄 경로', '버전이 박힌 설치본 경로',
          `플러그인을 업데이트하면 그 경로가 사라집니다. 아래 **고정 경로**로 바꾸세요:\n     "command": "${STATUSLINE_CONFIG_PATH}"`)
      }
      check(
        !!protocolCache,
        '규약',
        protocolCache ? `rev ${protocolCache.rev} (캐시)` : '캐시 없음 — 내장 최소 폴백으로 동작 중',
        '서버 접속 후 세션을 재시작하면 전체 규약이 적용됩니다',
      )
      // ── 서버 점검 (설정이 있을 때만) ──
      if (cfg) {
        if (!wsReady) await connectWithConfig()
        check(wsReady, '연결', wsReady ? `연결됨 (${cfg.url})` : `연결 실패 (${cfg.url})`, '서버 주소·사내망(VPN)을 확인하세요 — 계속 안 되면 관리자 문의')
        if (wsReady) {
          try {
            const d = await request({ type: 'doctor' })
            if (d.type === 'doctor') {
              if (d.protocolRev !== null && d.protocolRev !== undefined) {
                const same = protocolCache?.rev === Number(d.protocolRev)
                check(same, '규약 rev', same ? `rev ${d.protocolRev} — 최신` : `서버 rev ${d.protocolRev} / 캐시 rev ${protocolCache?.rev ?? '없음'}`, '세션을 재시작하면 새 규약이 적용됩니다')
              }
              const dHeld = (d.held as string[] | undefined) ?? []
              const dOther = (d.heldByOther as string[] | undefined) ?? []
              const dRooms = (d.rooms ?? {}) as Record<string, string>
              check(dHeld.length > 0 || Object.keys(dRooms).length === 0, '이 세션 담당 방',
                dHeld.map(r => `${r}(${dRooms[r]})`).join(', ') || '(없음)',
                'team_room(rooms:"<방>") 으로 이 세션이 받을 방을 지정하세요')
              if (dOther.length) {
                check(false, '수신 자격', `다른 세션이 담당 중인 방: ${dOther.join(', ')}`,
                  '정상일 수 있습니다 — 그 방은 다른 세션이 받고 있습니다. 이 세션에서 받아야 한다면 team_room 으로 가져오세요 (그 세션은 수신을 잃습니다)')
              }
              if (d.away) lines.push('  🌙 퇴근 중 — 수신은 보관됩니다 (team_away mode:"off" 로 출근)')
              const q = Number(d.queueForMe ?? 0)
              if (q > 0 && host.isGateway && !d.away) {
                check(false, '보관 큐', `보관 ${q}건이 배달되지 않고 있습니다`, '/team-relay:status 로 수신 상태 확인 — 다른 claude-team 세션이 수신을 가져갔을 수 있습니다')
              } else {
                check(true, '보관 큐', q === 0 ? '없음' : `보관 ${q}건${d.away ? ' (퇴근 중 — 정상)' : ''}`)
              }
              const skew = Math.abs(Date.now() - Number(d.serverTime ?? Date.now()))
              check(skew < 60_000, '시계 동기', `서버와의 차이 ${Math.round(skew / 1000)}초`, '보관 만료·무응답 판정은 서버 시각 기준입니다 — 머신 시계를 확인하세요')
              lines.push(`  ℹ️ 감사 로그: ${d.audit ? '켜짐 (팀 서버에 대화 기록)' : '꺼짐'}`)
            }
          } catch (e) {
            check(false, '서버 진단', `실패: ${(e as Error).message}`)
          }
        }
      }
      return ok(lines.join('\n'))
    }
    case 'team_status': {
      let cfg = loadConfig()
      if (!cfg) return ok('아직 팀에 참가하지 않았습니다 — /team-relay:join <서버주소> <초대코드>')
      // 자동답장 토글 — 연결 여부와 무관하게 로컬 설정으로 영속
      if (args.auto_reply === 'on' || args.auto_reply === 'off') {
        cfg = { ...cfg, autoReply: args.auto_reply === 'on' }
        saveConfig(cfg)
      } else if (args.auto_reply) {
        return ok(`✗ auto_reply 값은 "on" 또는 "off" 만 허용됩니다: ${args.auto_reply}`)
      }
      const autoLine = `자동답장: ${(cfg.autoReply ?? true) ? '켜짐 (규약 내 자동 발신)' : '꺼짐 (발신 전 사용자 승인 필요)'}`
      // 게이트웨이 여부는 항상 표시 — 선언(alias) 기반이라 조용히 어긋나면 안 된다
      const gwLine = `수신(게이트웨이): ${host.isGateway ? '예' : '아니요 — 이 세션은 발신 전용. 팀 메시지 수신은 claude-team 으로 켠 세션에서'}`
      if (!wsReady) await connectWithConfig()
      if (!wsReady) return ok(`✗ 중계 서버(${cfg.url}) 오프라인 — 내 이름: ${cfg.name}\n${gwLine}\n${autoLine}`)
      const st = await request({ type: 'status' })
      const stRooms = (st.rooms ?? {}) as Record<string, string>
      const stHeld = (st.held as string[] | undefined) ?? []
      const stOther = (st.heldByOther as string[] | undefined) ?? []
      const roomLine = `이 세션 담당: ${stHeld.map(r => `${r}(${stRooms[r]})`).join(', ') || '(없음)'}`
      const otherLine = stOther.length
        ? `⚠️ 다른 세션이 담당 중: ${stOther.join(', ')} — 이 세션에서 받으려면 team_room 으로 되찾으세요`
        : null
      const joinedLine = `참가 중인 방: ${Object.entries(stRooms).map(([r, l]) => `${r}(${l})`).join(', ')}`
      const awayLine = st.myAway
        ? '상태: 🌙 퇴근 중 — 수신은 보관되며(기한 정지), team_away(mode:"off") 로 출근하면 배달됩니다'
        : null
      return ok(
        [`연결됨 (${cfg.url})`, roomLine, joinedLine, otherLine, gwLine, autoLine, awayLine, formatRoster(st)]
          .filter(Boolean)
          .join('\n'),
      )
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

function formatRoster(frame: RelayFrame): string {
  const roster = (frame.roster ?? {}) as Record<string, { online: string[]; offline: string[] }>
  const unresponsive = new Set((frame.unresponsive as string[] | undefined) ?? [])
  const away = new Set((frame.away as string[] | undefined) ?? [])
  const mark = (n: string): string => `${away.has(n) ? '🌙' : ''}${n}${unresponsive.has(n) ? '⚠️' : ''}`
  const lines: string[] = []
  for (const [room, r] of Object.entries(roster)) {
    const on = r.online.map(n => `🟢${mark(n)}`).join(' ')
    const off = r.offline.map(n => `⚪${mark(n)}`).join(' ')
    lines.push(`  [${room}] ${[on, off].filter(Boolean).join(' ') || '(혼자)'}`)
  }
  const legend = [
    away.size ? '🌙 = 퇴근 중 (보관 후 출근 시 배달)' : null,
    unresponsive.size ? '⚠️ = 최근 무응답 (배달돼도 답이 늦을 수 있음)' : null,
  ].filter(Boolean)
  if (legend.length) lines.push(`  ${legend.join(' · ')}`)
  return lines.join('\n')
}

// ── 기동 ─────────────────────────────────────────────────
const transport = new StdioServerTransport()

/** 부모 세션 종료(stdin 닫힘) 시 즉시 자기 종료 — 좀비 프로세스 방지 (onclose + stdin 이중 방어) */
const shutdown = (): void => process.exit(0)
transport.onclose = shutdown
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

await mcp.connect(transport)
// 게이트웨이로 선언된 세션만 자동 접속 — 일반 세션은 도구 호출 시 발신 전용으로만
if (host.isGateway && loadConfig()) void connectWithConfig()

/**
 * 상태 하트비트 — statusline 이 읽는 state.json 을 살려둔다.
 *
 * updatedAt 이 멈추는 것 자체가 "플러그인이 안 돌고 있다"는 신호이므로, 주기는 statusline 의
 * 판정 기준(60초)보다 넉넉히 짧아야 한다. 연결돼 있으면 doctor 프레임 1개로 보관 큐·퇴근·
 * 빈 방까지 함께 갱신한다(비발신 프레임 상한 분당 120건에 비하면 무시할 수준).
 */
const STATE_HEARTBEAT_MS = Number(process.env.TEAM_RELAY_STATE_HEARTBEAT_MS ?? 30_000)
if (host.isGateway) {
  installStatusline() // 버전 무관 경로에 복사 — 업데이트해도 settings.json 을 고칠 필요가 없다
  sweepStaleStates() // 끝난 세션의 상태 파일 정리
  exportState()
  /**
   * 담당 없음 넛지 — 아무 방도 받고 있지 않다는 사실을 **한 번** 알린다.
   *
   * 이게 없으면 사용자는 완전히 조용한 세션을 보고 "오늘은 팀이 한가하네"라고 생각한다.
   * 소속 방이 하나뿐이면 자동 담당되므로 이 상황 자체가 생기지 않는다 — 방이 여럿일 때만
   * 울린다. 상태줄(§3.3)이 상시 표시라면, 이쪽은 세션을 켠 그 순간의 한 번이다.
   */
  const NUDGE_DELAY_MS = Number(process.env.TEAM_RELAY_NUDGE_DELAY_MS ?? 4000)
  const nudge = setTimeout(async () => {
    if (!wsReady || heldRooms.length > 0) return
    const cfg = loadConfig()
    const roomCount = Object.keys(cfg?.rooms ?? {}).length
    if (roomCount < 2) return // 방이 하나면 자동 담당된다 — 알릴 것이 없다
    // 첫 하트비트(30초)보다 먼저 울리므로 ⚪ 목록을 여기서 한 번 채운다
    if (!lastEmpty.length) {
      const list = await roomStatuses(cfg!).catch(() => [])
      lastEmpty = emptyRooms(list)
    }
    const empty = lastEmpty.length ? `\n          ⚪ 비어 있는 방: ${lastEmpty.join(', ')}` : ''
    void host.notify(
      `[담당 없음] 이 세션은 담당 중인 방이 없어 팀 메시지를 받지 않습니다.${empty}\n          /team-relay:room 으로 받을 방을 고르세요.`,
      { kind: 'system' },
    )
  }, NUDGE_DELAY_MS)
  nudge.unref?.()

  const beat = setInterval(() => {
    if (!wsReady) { exportState(); return }
    void request({ type: 'doctor' }).then(
      d => {
        if (d.type === 'doctor') {
          lastQueued = Number(d.queueForMe ?? 0)
          lastAway = !!d.away
          const rooms = (d.rooms ?? {}) as Record<string, string>
          const held = new Set((d.held as string[] | undefined) ?? [])
          const byOther = new Set((d.heldByOther as string[] | undefined) ?? [])
          lastEmpty = Object.keys(rooms).filter(r => !held.has(r) && !byOther.has(r))
        }
        exportState()
      },
      () => exportState(), // 응답이 없어도 updatedAt 은 갱신한다 — 프로세스는 살아 있다
    )
  }, STATE_HEARTBEAT_MS)
  beat.unref?.() // 하트비트가 프로세스 종료를 붙잡지 않게
}
