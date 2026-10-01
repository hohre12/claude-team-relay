/**
 * 웹소켓 구현 선택 — 런타임이 전역 `WebSocket` 을 주면 그걸 쓰고, 없으면 번들된 `ws` 를 쓴다.
 *
 * Bun 과 Node 22+ 는 전역으로 제공한다. Node 18~21 은 제공하지 않으므로 폴백이 필요하다.
 * `ws` 는 순수 JS 라 번들에 그대로 들어가고 **사용자가 설치할 것이 없다**.
 * 우리가 쓰는 표면은 addEventListener('open'|'message'|'close'|'error') · send · close ·
 * readyState · ev.data 뿐이고, 둘 다 같은 모양을 제공한다.
 */
const WS: typeof WebSocket =
  (globalThis as { WebSocket?: typeof WebSocket }).WebSocket ??
  ((await import('ws')).default as unknown as typeof WebSocket)

export default WS
