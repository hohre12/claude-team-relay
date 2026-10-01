/**
 * 호스트 경계 — 이 플러그인이 "어느 에이전트 안에서 도는가"에 의존하는 **전부**.
 *
 * 코어(core/)는 중계 서버와의 대화만 알고, 사용자에게 무언가를 보여주거나 세션을 식별하는
 * 일은 전부 이 인터페이스를 통한다. 다른 호스트(Codex 등)를 지원하게 되면 구현체 하나만
 * 추가하면 되고, 코어와 도구 구현은 손대지 않는다. (v0.7 §3.1)
 */
export interface Host {
  /** 이 세션의 고유 id — 담당 방 바인딩의 키. 모르면 빈 문자열 */
  readonly sessionId: string
  /** 이 세션이 팀 메시지 **수신**을 맡는가 (발신은 항상 가능) */
  readonly isGateway: boolean
  /** 런타임 표시 문자열 — 진단용 */
  readonly runtime: string
  /**
   * 사용자·모델에게 보이는 **유일한 출구**.
   * Claude Code 는 채널 알림으로 세션에 주입하고, 다른 호스트는 다른 수단을 쓸 수 있다.
   */
  notify(content: string, meta?: Record<string, string>): Promise<void>
  /**
   * 선택지를 띄우고 하나를 받아온다.
   *
   * 호스트가 대화형 UI 를 제공하면 그걸 쓰고, 못 하면 **null** 을 돌려준다 — 호출부는
   * null 을 받으면 텍스트 안내로 폴백한다(기능이 사라지지 않고 한 단계 낮아질 뿐).
   * 사용자가 취소해도 null 이다. "고르지 않음"과 "못 고름"을 구분할 필요가 없다 —
   * 둘 다 아무것도 하지 않는 것이 맞기 때문이다.
   */
  choose(spec: ChoiceSpec): Promise<string | null>
}

export interface ChoiceSpec {
  /** 대화상자 상단 문구 */
  message: string
  /** 필드 라벨 */
  title: string
  /** 선택지 — value 는 호출부가 해석하는 값, label 은 사람이 읽는 줄 */
  options: Array<{ value: string; label: string }>
}
