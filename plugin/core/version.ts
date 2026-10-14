/** 버전 상수 — 와이어 협상과 진단에 쓰인다 */

/**
 * 와이어 프로토콜 버전 — 서버의 MIN_PROTO 미만이면 plugin_outdated 로 거절된다 (v1 §2.1).
 * 3: 답장을 reply 프레임(thread 만)으로 보낸다 — 서버가 welcome.v ≥ 3 일 때만 쓴다.
 * 4: 방 메모리 (welcome.memory · memory_* 프레임) — 서버가 welcome.v ≥ 4 일 때만 쓴다.
 */
export const PROTO = 4
/** 플러그인 패키지 버전 — hello/join 에 동봉 (서버 로그·doctor 진단용) */
export const PLUGIN_VERSION = '0.10.0'
