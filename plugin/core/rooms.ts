/**
 * 방 담당 상태 분류 — "지금 어느 방이 비어 있는가"를 계산한다.
 *
 * 세 상태로 나뉜다.
 *   🟢 이 세션이 담당 중            (held)
 *   🔵 내 다른 세션이 담당 중        (heldByOther)
 *   ⚪ 아무도 안 받는 중            (나머지)  ← 보통 이걸 고른다
 *
 * ⚪ 를 고르면 아무도 수신을 잃지 않는다. 🔵 를 고르면 그 세션이 잃는다 — 그래서 선택
 * 화면에서 미리 경고해야 한다. 순수 함수라 직접 import 해 검증할 수 있다.
 */
export type RoomMark = 'mine' | 'other' | 'empty'

export interface RoomStatus {
  room: string
  /** 그 방에서의 내 라벨 */
  label: string
  mark: RoomMark
}

export function classifyRooms(
  rooms: Record<string, string>,
  held: string[],
  heldByOther: string[],
): RoomStatus[] {
  const mine = new Set(held)
  const other = new Set(heldByOther)
  return Object.entries(rooms).map(([room, label]) => ({
    room,
    label,
    mark: mine.has(room) ? 'mine' : other.has(room) ? 'other' : 'empty',
  }))
}

const ICON: Record<RoomMark, string> = { mine: '🟢', other: '🔵', empty: '⚪' }
const NOTE: Record<RoomMark, string> = {
  mine: '이 세션이 받는 중',
  other: '다른 세션이 담당 중',
  empty: '비어 있음 — 지금 아무도 받지 않습니다',
}

/** 목록 렌더 — 텍스트 출력과 폴백에서 함께 쓴다 */
export function renderRooms(list: RoomStatus[]): string {
  return list.map(r => `  ${ICON[r.mark]} ${r.room} (${r.label})   ${NOTE[r.mark]}`).join('\n')
}

/** 선택지 라벨 — 🔵 는 "그 세션이 수신을 잃는다"를 **고르기 전에** 알린다 */
export function choiceLabel(r: RoomStatus): string {
  const tail = r.mark === 'other' ? ' · 고르면 그 세션은 수신을 잃습니다' : ''
  return `${ICON[r.mark]} ${r.room} (${r.label}) — ${NOTE[r.mark]}${tail}`
}

/** 아무도 안 받는 방 */
export function emptyRooms(list: RoomStatus[]): string[] {
  return list.filter(r => r.mark === 'empty').map(r => r.room)
}
