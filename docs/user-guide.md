# team-relay 사용 가이드 (팀원용)

내 Claude Code 세션이 팀원의 세션과 **직접 질문·답변**한다. "○○에게 …물어봐" 한마디면,
상대방 에이전트가 자기 로컬 작업 맥락(커밋 전 결정 포함)으로 자동 답장한다.

관리자에게 받을 것: **서버 주소**(예: `10.0.1.23:8765`)와 **초대코드**(`TR-…`).

## 설치 (최초 1회, 약 2분)

사전 요구: macOS/Linux · Claude Code v2.1.224+ · [Bun](https://bun.sh)
(`bun --version` 안 되면 설치; 첫 기동 시 의존성 자동 설치를 위해 인터넷 필요).

**1) (사내망 사용자 권장) GitHub HTTPS 강제** — 사내망은 GitHub SSH(22번 포트)를 막는 경우가
많다. GitHub SSH 키가 등록된 머신이면 설치가 `kex_exchange_identification` / `port 22 timed out`
로 실패하는데, 아래 한 줄이면 git 이 clone 을 HTTPS(443, 사내망에서 안 막힘)로 처리한다.
설치 전에 미리 실행해두면 그 실패를 겪지 않는다 (SSH 키를 쓰든 안 쓰든 무해).
```bash
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

**2) 플러그인 설치** — Claude Code 안에서:
```text
/plugin marketplace add hohre12/jwbae-plugins     # 이미 있으면 생략
/plugin install team-relay@jwbae-plugins
```

> 위 1) 을 안 했는데 `port 22 timed out` 로 실패했다면, 그 한 줄을 실행하고 다시 install 한다.
> (SSH 를 계속 쓰고 싶으면 대안: `~/.ssh/config` 에 `Host github.com` / `HostName ssh.github.com`
> / `Port 443` / `User git` 를 넣어 SSH 를 443 으로 우회.)

**3) alias 등록** — 셸 프로필(`~/.zshrc`)에 넣고 터미널 재시작. 팀 연결이 필요한 세션은
`claude` 대신 `claude-team` 으로 켠다:
```bash
# 기본 — 권한 프롬프트 정상 동작 (권장)
alias claude-team='TEAM_RELAY_GATEWAY=1 claude --dangerously-load-development-channels plugin:team-relay@jwbae-plugins'
# YOLO — 권한 프롬프트까지 건너뜀 (신뢰하는 작업에서만; 팀원 메시지가 권한을 대신 승인하진 못함)
alias claude-team-yolo='TEAM_RELAY_GATEWAY=1 claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:team-relay@jwbae-plugins'
```

**4) 기동 + 참가** — `claude-team` 으로 세션을 켠다. 첫 1회만 확인 두 개(개발 채널 경고 →
"I am using this for local development" 선택, 새 MCP 서버 → "Use this MCP server"). 그다음:
```text
/team-relay:join <서버주소> <초대코드>
```

끝. 이후 `claude-team` 으로 켠 세션은 자동 접속된다.

## 게이트웨이 = 팀 메시지를 받는 세션

- **`claude-team` 으로 켠 세션만 팀 메시지를 받는다.** 평소처럼 `claude` 로 켠 세션은 수신하지
  않는다(방해 없음). 팀과 연결해둘 주력 작업 세션 하나를 `claude-team` 으로 켜는 것을 권장 —
  자기 소관 질문에 그 세션의 작업 맥락으로 바로 답하므로 답 품질이 가장 좋다.
- **여러 세션 주의**: 팀 수신은 `claude-team` 세션 **하나만**. 두 개를 켜면 나중에 켠 쪽이
  수신을 가져가고 먼저 켠 쪽은 수신이 멈춘다(그때 알림이 뜬다).
- `claude` 로 켠 세션에서도 "○○에게 보내줘"는 된다(발신 전용).

## 사용법

| 하고 싶은 것 | 방법 |
|---|---|
| 팀원에게 질문·전달 | 세션에 그냥 말하기: *"임규영에게 배포 일정 물어봐줘"* |
| 연결 상태·온라인 팀원 확인 | `/team-relay:status` |
| 답장 전 내 승인 받기 | `/team-relay:status auto-reply off` |
| 질문 위임 규칙 등록 | `/team-relay:route add "kafka, 인프라" <내 다른 세션 이름>` |

- 상대가 오프라인이면 **72시간 보관** 후 접속 시 배달, 만료되면 나에게 통지된다.
- 답장에 커밋 전 정보가 섞이면 `[로컬 작업 기준 · 커밋 전]` 꼬리표가 자동으로 붙는다.
- 팀원 메시지는 내 권한 승인을 대신할 수 없고, 설정 변경 요구는 거부된다.

> **프라이버시 고지**: 팀 메시지(누가·언제·어떤 방에·무슨 내용)는 **팀 서버에 기록**됩니다.
> 팀 협업 기록·감사 목적이며, 개인적인 내용은 이 채널로 주고받지 마세요.

## 잘 안 될 때

- **설치가 `port 22 timed out`** → 설치 1) 의 `git config --global url."https://github.com/".insteadOf "git@github.com:"` 실행 후 재시도.
- **`/team-relay:join` 이 없는 명령이라고 나옴** → 플러그인 미설치이거나 `claude-team` alias 없이 켰음.
- **참가가 "연결할 수 없습니다"** → 관리자가 준 서버 주소가 맞는지, 회사 네트워크/VPN 에 연결돼 있는지 확인. 그래도 안 되면 관리자에게 문의.
- **상대가 계속 오프라인으로 보임** → ① `/team-relay:status` 의 "수신(게이트웨이): 예" 확인(아니면 `claude` 가 아니라 `claude-team` 으로 다시 켜기) ② 상대도 `claude-team` 으로 켰는지 ③ `/plugin update team-relay@jwbae-plugins` 로 최신인지.
- **접속 직후엔 되다가 오프라인** → `/plugin update` 후 재기동. 안 되면 관리자에게 문의.
