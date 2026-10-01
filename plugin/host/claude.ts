/**
 * Claude Code 호스트 구현 — 이 파일이 Claude Code 에 대한 결합의 전부다.
 *
 *  · 수신: `notifications/claude/channel` 로 세션에 주입되어 <channel> 태그가 된다
 *  · 세션 식별: `CLAUDE_CODE_SESSION_ID` (2026-09-21 실측)
 *  · 수신 자격: `TEAM_RELAY_GATEWAY=1` (claude-team alias 가 선언)
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SESSION_ID } from '../core/config'
import type { ChoiceSpec, Host } from './types'

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
    /**
     * MCP elicitation (Claude Code v2.1.x+) — **서버가 직접** 대화상자를 띄운다.
     * 모델이 중간에 끼지 않으므로 결정적으로 동작한다. 미지원 클라이언트에서는 null 을
     * 돌려 호출부가 텍스트 폴백으로 내려가게 한다.
     */
    async choose(spec: ChoiceSpec): Promise<string | null> {
      if (!mcp.getClientCapabilities()?.elicitation) return null
      try {
        const res = await mcp.elicitInput({
          mode: 'form',
          message: spec.message,
          requestedSchema: {
            type: 'object',
            properties: {
              choice: {
                type: 'string',
                title: spec.title,
                enum: spec.options.map(o => o.value),
                enumNames: spec.options.map(o => o.label),
              },
            },
            required: ['choice'],
          },
        })
        if (res.action !== 'accept') return null
        const v = (res.content as { choice?: unknown } | undefined)?.choice
        return typeof v === 'string' ? v : null
      } catch {
        return null // 지원한다고 선언했지만 실패 — 폴백이 안전하다
      }
    },
  }
}
