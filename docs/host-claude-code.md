# Claude Code 연결 계약 (호스트: Claude Code)

> 플러그인과 **Claude Code** 사이의 약속이다. 플러그인과 **중계 서버** 사이의 약속(와이어 프로토콜)은
> 서버 저장소의 `docs/wire-protocol.md` 에 있다.
>
> 플러그인 코드에서 Claude Code 에 묶인 부분은 `plugin/host/claude.ts` 하나다(코어는 `plugin/core/`).
> 다른 AI 도구를 붙이면 이 문서와 같은 자리에 `host-<도구>.md` 가 생긴다.
>
> 출처: [channels-reference](https://code.claude.com/docs/en/channels-reference) · 공식 discord 플러그인 소스(2026-08-10 조사) ·
> 운영 중 실측(2026-09 ~ 10). 채널은 **research preview** 다 — Claude Code 가 바뀌면 다시 확인할 것.
> 기준: 플러그인 0.10.2 (2026-10-15)

---

## 1. 채널이란

채널 = Claude Code 가 **stdio 하위 프로세스로 띄우는 MCP 서버** 중, 서버 쪽에서 세션으로 메시지를 밀어 넣을 수 있는 것.
세션을 켜면 Claude Code 가 플러그인의 `.mcp.json` 을 읽어 우리 플러그인 프로세스를 띄우고, 플러그인이 그 안에서
중계 서버로 웹소켓을 연다. **따로 띄울 서버가 없다.**

## 2. 플러그인이 지키는 약속

### 2.1 채널 선언

```ts
const mcp = new Server(
  { name: 'team-relay', version: PLUGIN_VERSION },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },   // 이 키가 채널 등록의 전부
      tools: {},
    },
    instructions: '<팀 규약 + 방 메모리 — 시스템 프롬프트에 들어간다>',
  },
)
```

### 2.2 받은 메시지를 세션에 넣기 (서버 → 세션)

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: '<본문>', meta: { from: '임규영', room: 'web3', thread: 't-1a2b3c4d', ... } },
})
```
세션에는 `<channel from="임규영" room="web3" thread="t-1a2b3c4d" ...>본문</channel>` 로 보인다.

**meta 로 싣는 것** (`plugin/server.ts` `deliverToSession`)

| 키 | 언제 | 뜻 |
|---|---|---|
| `from` · `room` · `ts` | 항상 | 보낸 사람(그 방에서의 이름) · 방 · 보낸 시각 |
| `thread` | 대화에 속한 메시지 | 답장할 때 `team_reply` 에 그대로 넣는다 |
| `expect` | 서버가 실어 보냄 | `reply` 면 답을 기대함 |
| `queued` | 보관됐다 늦게 온 것 | `true` |
| `kind` | 일반 메시지가 아닐 때 | `notice` · `agree_propose` · `memory_propose` · `system`(서버 알림) · `noack` · `expired` · `memory` |
| `agree` | 합의 제안 | 합의 id |

- **meta 키는 영문·숫자·밑줄만.** 하이픈이 있으면 **조용히 빠진다**.
- 알림은 **보내고 끝**이다. await 는 전송까지만 보장하고, 세션이 채널을 안 물고 있으면 조용히 버려진다.
  배달 확인은 서버(`sent.state`)가 맡는다.
- 세션이 작업 중이면 다음 턴에 묶여 순서대로 들어간다.
- 팀 채널인지는 `source` 가 아니라 `from`·`room` 속성으로 가린다 — `source` 는 설치 방식마다 다르다
  (`plugin:team-relay:team-relay` · `team-relay`).

### 2.3 보내기 (세션 → 서버)

표준 MCP 도구다. 채널 특화가 없다.
`team_send` · `team_reply` · `team_ack` · `team_agree` · `team_history` · `team_memory` · `team_room` · `team_status` ·
`team_away` · `team_owner` · `team_join` · `team_server` · `team_doctor` · `team_route`

### 2.4 instructions = 팀 규약이 들어가는 곳

팀 규약 본문은 서버가 배포한다(`welcome.protocol`). 플러그인은 세션을 켤 때 서버에 짧게 접속해 받아 오고,
못 받으면 지난번 사본, 그것도 없으면 내장된 최소 규약(보안 경계 조항만)을 넣는다.
`claude-team` 이 아닌 일반 세션에는 "이 세션은 팀 세션이 아니다" 한 줄만 넣는다.

### 2.5 보낸 사람 확인

공식 요구는 "알림을 쏘기 전에 보낸 사람을 확인하라" 다. 우리 구조에서는 중계 서버가 1차 관문이다(토큰 인증 · 방 검사 ·
보내는 사람 위조 불가). 플러그인은 인증된 연결로 온 메시지를 믿는다. 대신 서버 주소가 바뀌지 않도록 설정 파일 권한은 600 이다.

### 2.6 대화상자 (MCP elicitation)

방 고르기처럼 사용자가 골라야 할 때 `elicitInput` 으로 Claude Code 가 대화상자를 띄운다(`host.choose`).
지원하지 않으면 글로 안내하는 방식으로 내려간다.

---

## 3. 하지 말 것

- **`claude/channel/permission` 을 선언하지 않는다.** 선언하면 "채널로 답할 수 있는 상대가 이 세션의 도구 실행을
  원격 승인" 할 수 있다. 우리 채널의 상대는 본인이 아니라 **팀원**이다 — 팀원이 내 권한 확인을 대신 누르게 된다.
  (`plugin/server.ts` 의 capabilities 주석에도 "추가 금지")
- meta 키에 하이픈을 쓰지 않는다.

---

## 4. 세션 · 실행

### 4.1 켜는 법

| 형태 | 명령 |
|---|---|
| 팀 세션 (팀원) | `TEAM_RELAY_GATEWAY=1 claude --dangerously-load-development-channels plugin:team-relay@jwbae-plugins` — `claude-team` alias |
| 개발 | 프로젝트 `.mcp.json` 에 서버 등록 → `claude --dangerously-load-development-channels server:team-relay` |

- 개발 채널 플래그는 켤 때 경고 화면이 한 번 뜬다. 정식 기능이 되면 조직 관리자가 `allowedChannelPlugins` 에 등록해야 플래그 없이 쓸 수 있다.
- 조직 정책 `channelsEnabled` 는 플래그로 우회할 수 없다.
- `TEAM_RELAY_GATEWAY=1` 이 이 세션이 방을 **받는** 팀 세션이라는 선언이다. 일반 `claude` 세션은 서버에 붙지 않는다(0.10.0~).

### 4.2 세션을 가리키는 값

| 값 | 어디서 | 주의 |
|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | 환경변수 | 플러그인이 **뜰 때**의 값이다. `--resume` 으로 대화를 고르면 세션 id 가 바뀌는데 이미 뜬 프로세스의 값은 안 바뀐다 |
| 부모 PID (`process.ppid`) | 프로세스 | 그 Claude Code 창이 사는 동안 안 바뀐다. 상태줄 스크립트의 `$PPID` 와 같다 — 상태줄과 플러그인이 서로를 찾는 열쇠 |
| `CLAUDE_PROJECT_DIR` | 환경변수 | 작업 폴더. 서버에 `hello.dir` 로 보낸다 |
| 세션 이름 (`/rename`) | **상태줄 입력 JSON 의 `session_name` 에만** 있다 | MCP 에는 오지 않는다. 상태줄 스크립트가 `name-<PPID>` 파일로 적고 플러그인이 읽는다. 상태줄을 안 쓰면 없다 |

### 4.3 업데이트와 새 규약 (실측 2026-10-14)

- `/reload-plugins` 는 플러그인 프로세스·도구·명령을 새것으로 바꾼다. 그러나 **세션을 켤 때 들어간 instructions(팀 규약)는 바꾸지 않았다.**
- `--resume` 으로 다시 켠 세션에서도 옛 규약이 남아 있었다. 다만 그때 Claude Code 가 team-relay 를 "연결 실패" 로 잘못
  표시하고 있어서, resume 때문인지 그 표시 때문인지는 가리지 못했다.
- **새 규약이 확실히 들어가는 건 새 세션뿐이다.** 그래서 프레임·도구 쪽에서 옛 규약으로 도는 세션도 잘못 동작하지 않게
  받아 줄 수 있는지 먼저 본다.

### 4.4 도구 불러오기 (tool search)

- Claude Code 는 MCP 도구가 많으면 처음엔 **이름만** 알려 주고, 쓸 때 불러오게 한다(기본 켜짐).
- 대화 중간에 새로 생긴 도구(예: 업데이트로 생긴 `team_reply`)는 이름만 있는 상태라, 에이전트가 이미 써 본 도구
  (`team_send`)를 고르기 쉽다 — 2026-10-14 답장이 새 대화로 나간 사고의 원인이었다.
- 도구마다 `_meta: { "anthropic/alwaysLoad": true }` 를 주면 처음부터 쓸 수 있는 상태로 올라온다 (아직 적용 안 함 —
  서버 로드맵의 플러그인 0.10.3 보류 항목).

---

## 5. 디버깅

- `/mcp` — 채널 서버 연결 상태. "Failed to connect" 면 플러그인 파일의 의존성·임포트 오류
- 플러그인 stderr: `~/.claude/debug/<세션 id>.txt`
- 켤 때 배너 아래 `Channels (experimental) messages from plugin:team-relay… inject directly in this session` 가 보이면 채널 등록 성공
- `/team-relay:doctor` — 설정 · 팀 세션 여부 · 플러그인 버전 · 서버 연결 · 받는 방 · 보관 큐를 한 번에 점검
- 메시지가 안 들어오는데 서버는 멀쩡하면 → `/mcp` 상태, 그리고 이 세션이 그 방을 받고 있는지(`/team-relay:status`)
