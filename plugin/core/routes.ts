/**
 * 라우팅 등록표 — "이런 질문이 오면 이 머신의 저 세션에 위임하라"는 명시 규칙 (3단 위임의 1단).
 *
 * 전부 순수 함수다. 파일 입출력도 네트워크도 없어서 **직접 import 해 단위 테스트할 수 있다**.
 * 방 바인딩은 키워드보다 우선한다 (v1 §6.5).
 */
import type { RouteEntry } from './types'

/** 등록표 한 줄의 사람이 읽는 라벨 */
export function labelOf(r: RouteEntry): string {
  return r.room ? `[방 ${r.room}] → ${r.session}` : `"${r.keywords}" → ${r.session}`
}

/** 같은 키워드·같은 방의 기존 항목을 골라낸다 (교체/제거의 공통 술어) */
function matches(r: RouteEntry, keywords?: string, room?: string): boolean {
  return Boolean((keywords && r.keywords === keywords) || (room && r.room === room))
}

export interface AddResult { routes: RouteEntry[]; entry: RouteEntry; replaced: boolean }

/**
 * 등록 — 같은 키워드/같은 방의 기존 항목은 **새 세션으로 교체**한다(중복 누적 방지).
 * keywords 와 room 은 둘 중 하나 이상이 있어야 하며, 검증은 호출부 책임이다.
 */
export function addRoute(routes: RouteEntry[], session: string, keywords?: string, room?: string): AddResult {
  const rest = routes.filter(r => !matches(r, keywords, room))
  const entry: RouteEntry = { session }
  if (keywords) entry.keywords = keywords
  if (room) entry.room = room
  return { routes: [...rest, entry], entry, replaced: rest.length !== routes.length }
}

/** 제거 — 지워진 게 없으면 removed:false (호출부가 "해당 항목 없음"을 안내한다) */
export function removeRoute(routes: RouteEntry[], keywords?: string, room?: string): { routes: RouteEntry[]; removed: boolean } {
  const rest = routes.filter(r => !matches(r, keywords, room))
  return { routes: rest, removed: rest.length !== routes.length }
}

/** 목록 렌더 — 비어 있으면 null (호출부가 안내 문구를 고른다) */
export function renderRoutes(routes: RouteEntry[]): string | null {
  if (routes.length === 0) return null
  return ['라우팅 등록표 (방 바인딩이 키워드보다 우선):', ...routes.map(r => `  ${labelOf(r)}`)].join('\n')
}
