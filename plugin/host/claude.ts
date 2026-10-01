/**
 * Claude Code 호스트 구현 — 이 파일이 Claude Code 에 대한 결합의 전부다.
 *
 *  · 수신: `notifications/claude/channel` 로 세션에 주입되어 <channel> 태그가 된다
 *  · 세션 식별: `CLAUDE_CODE_SESSION_ID` (2026-09-21 실측)
 *  · 수신 자격: `TEAM_RELAY_GATEWAY=1` (claude-team alias 가 선언)
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SESSION_ID } from '../core/config'
import type { Host } from './types'

declare const Bun: { version: string } | undefined

export function createClaudeHost(mcp: Server): Host {
  return {
    sessionId: SESSION_ID,
    isGateway: process.env.TEAM_RELAY_GATEWAY === '1',
    runtime: typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`,
    notify(content, meta = {}) {
      return mcp.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      })
    },
  }
}
