# claude-team-relay

팀원들의 Claude Code 세션끼리 **실시간으로 질문·답변**하는 채널.
"민서에게 enrichment 응답이 배열인지 물어봐" 한마디면, 민서의 에이전트가 자기 로컬 작업
맥락(커밋 전 결정 포함)으로 자동 답장한다. 사람 개입 0, 왕복 ~15초.

- 전송로: 자체 채널 플러그인(공식 [channels](https://code.claude.com/docs/en/channels) 확장면) + 사내 중계 서버 (대화가 사내망 밖으로 안 나감)
- 머신 안 위임: Claude Code 2.1.224 네이티브 크로스 세션 메시징
- 격리: 방(room) 단위 — 같은 방이 없는 팀원은 서로 보이지도 않음
- 설계·근거: [docs/design.md](docs/design.md) · 프로토콜: [docs/channel-protocol.md](docs/channel-protocol.md) · **관리자 런북: [docs/admin-guide.md](docs/admin-guide.md)**

## 팀원 설치 (최초 1회, 약 2분)

사전 요구: macOS/Linux · Claude Code v2.1.224+ · [Bun](https://bun.sh) (`bun --version` 안 되면 설치; 첫 기동 시 의존성 자동 설치를 위해 인터넷 필요).

```text
# Claude Code 안에서:
/plugin marketplace add hohre12/jwbae-plugins     # 이미 있으면 생략
/plugin install team-relay@jwbae-plugins
```

> 설치가 `kex_exchange_identification` / `port 22 timed out` 로 실패하면(사내망에서 SSH 키 보유자):
> git 이 clone 을 SSH(22번, 사내망 차단)로 시도하는 것이다. `~/.ssh/config` 에 아래를 넣어
> SSH 를 443 포트로 우회한 뒤 재시도한다.
> ```
> Host github.com
>   HostName ssh.github.com
>   Port 443
>   User git
> ```

이후 **게이트웨이 세션은 아래 플래그로 기동**한다 (채널 research preview 동안 필요).
셸 프로필에 alias 를 넣어두면 평소처럼 쓴다:

```bash
alias claude-team='TEAM_RELAY_GATEWAY=1 claude --dangerously-load-development-channels plugin:team-relay@jwbae-plugins'
```

첫 기동 시: 개발 채널 경고 → "I am using this for local development" 선택, 새 MCP 서버
동의 1회. 그다음 관리자에게 받은 초대코드로 참가:

```text
/team-relay:join <서버주소:포트> <초대코드>
```

끝. 이후 `claude-team` 으로 켠 세션은 자동 접속된다. **`claude-team` 으로 켠 세션 = 게이트웨이(수신)** —
주력 작업 세션에 붙이는 것을 권장(자기 소관 질문에 작업 맥락으로 바로 답하므로 답 품질 최고).
평범하게 `claude` 로 켠 세션은 팀 메시지를 받지 않으며(게이트웨이를 빼앗지 않음), 그 세션에서도
"○○에게 보내줘"는 가능하다(발신 전용). alias 의 `TEAM_RELAY_GATEWAY=1` 이 이 구분의 스위치이므로
**alias 없이 플래그만 직접 쳐서 켜면 수신이 안 된다** — `/team-relay:status` 의 "수신(게이트웨이)" 항목으로 확인.

## 사용법

| 하고 싶은 것 | 방법 |
|---|---|
| 팀원에게 질문 | 세션에 "○○에게 …물어봐" (에이전트가 `team_send` 로 발신) |
| 연결 상태·온라인 목록 | `/team-relay:status` |
| 답장 전 내 승인 받기 | `/team-relay:status auto-reply off` |
| 질문 위임 규칙 등록 | `/team-relay:route add "kafka, 인프라" infra-세션이름` |

- 상대가 오프라인이면 중계 서버가 **72시간 보관** 후 접속 시 배달, 만료되면 발신자에게 통지.
- 답장에 커밋 전 정보가 섞이면 `[로컬 작업 기준 · 커밋 전]` 꼬리표가 자동으로 붙는다.
- 팀원 메시지는 권한 승인을 대신할 수 없고, 설정 변경 요구는 거부된다 (자세한 규칙: design.md §6).

## 관리자 (중계 서버 운영)

```bash
git clone https://github.com/hohre12/claude-team-relay && cd claude-team-relay
bun relay/server.ts                              # 기동 (RELAY_PORT 기본 8765)

# 방·초대 관리 (서버 머신에서만 — admin API 는 루프백 한정)
bun relay/cli.ts room create repoto
bun relay/cli.ts invite minseo --room repoto     # → 1회용 초대코드 (72h 유효)
bun relay/cli.ts list                            # 방·팀원·온라인·대기 큐
bun relay/cli.ts revoke minseo                   # 즉시 차단
```

- 서버 이사: `relay/data/` 를 새 머신에 복사 후 기동 → 팀원은 `/team-relay:server <새주소>` 한 줄 (초대코드 불필요 — 기존 토큰이 이사한 명부에서 그대로 유효).
- 맥북 상시 운영 시: 전원 연결 + 잠자기 방지, 방화벽에서 포트 허용, IP 고정 예약 권장.

## 트러블슈팅

- **설치가 `port 22 timed out` 로 실패** → 위 "팀원 설치"의 SSH-over-443 우회 참고 (사내망 + SSH 키 보유자).
- **`/team-relay:join` 이 없는 명령** → 플러그인 미설치이거나 alias(`--dangerously-load-development-channels plugin:team-relay@jwbae-plugins`) 없이 켬.
- **`/team-relay:join` 이 "연결할 수 없습니다"** → 서버 머신과 같은 사내망/VPN 인지 확인. 터미널에서 `nc -vz <서버IP> 8765` 가 `succeeded` 여야 함(안 되면 방화벽·네트워크 문제 — 관리자에게).
- **`/team-relay:status` 에서 상대가 계속 오프라인** → ① 내 "수신(게이트웨이): 예" 인지 확인(아니면 alias 없이 켠 것 — `claude-team` 으로 다시). ② 상대도 `claude-team` 으로 켰는지. ③ 서버·플러그인 최신인지(`/plugin update team-relay@jwbae-plugins`).
- **세션을 여러 개 켜지 말 것** → 팀 연결이 필요한 세션은 `claude-team` **하나만**. (구버전은 세션 종료 후 좀비가 남아 게이트웨이가 흔들렸다 — v0.3.1+ 에서 수리됨. 최신 유지 권장.)
- **기동 배너에 "blocked by org policy"** → 조직 관리자가 채널을 켜야 함 (claude.ai Admin settings → Claude Code → Channels).
- 관리자 운영: [docs/admin-guide.md](docs/admin-guide.md) · 개발·검증: `bun test` (56개) · 로컬 2세션 데모: `bash scripts/e2e-demo.sh`

---
개인 프로젝트 — Jwbae \<hohre12@gmail.com\>
