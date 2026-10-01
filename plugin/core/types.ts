/** team-relay 코어 타입 — 호스트(Claude Code 등)와 무관한 순수 데이터 모양 */

/** 라우팅 등록표 항목 — 3단 위임의 1단(명시 등록표). keywords 또는 room 중 하나 이상 */
interface RouteEntry {
  keywords?: string // 매칭 키워드 (사람이 읽는 자유 문자열)
  room?: string // 방 바인딩 (v1 §6.5) — 이 방 꼬리표의 질문은 이 세션으로 (키워드 매칭보다 우선)
  session: string // 이 머신에서 위임받을 세션 이름
}

interface Config {
  url: string // ws://host:port/ws
  /** 이 머신의 신원 — 불변, 최초 join 1회 생성 (v2 §2) */
  token: string
  /** 방 → 그 방에서의 내 라벨 (서버가 진실, 표시용 캐시) */
  rooms?: Record<string, string>
  /** 세션 id → 담당 방 목록 — --resume 시 담당이 복원된다 (v2 §2.2) */
  sessions?: Record<string, string[]>
  /** v1 호환 — 옛 설정의 단일 이름 (마이그레이션 후 rooms 로 승격) */
  name?: string
  routes?: RouteEntry[] // 라우팅 등록표 (선택 — 미등록이어도 동작)
  autoReply?: boolean // 자동답장 토글 (기본 true)
}


/** 중계 서버와 주고받는 프레임 — type 만 고정, 나머지는 프레임별 */
export type RelayFrame = Record<string, unknown> & { type: string }

/** thin client 규약 캐시 (v1 §2.4) */
export interface ProtocolCache {
  rev: number
  instructions: string
}
