/**
 * 버전이 적힌 곳 셋을 맞춰 둔다 — 안 맞으면 빌드를 막는다.
 *
 *   plugin/core/version.ts     PLUGIN_VERSION  (번들에 박혀 서버·doctor 가 본다)
 *   plugin/package.json        doctor 의 '번들 신선도' 가 번들과 대조한다
 *   .claude-plugin/plugin.json 마켓플레이스·설치본 폴더 이름이 된다
 *
 * 세 곳을 손으로 맞추다 0.7.4~0.7.6 에서 package.json 하나를 빠뜨렸고, 팀원 doctor 에
 * "번들 v0.7.6 ≠ 패키지 v0.7.3" 이 떴다. 기능엔 지장이 없지만 사람을 놀라게 한다.
 * 빌드 때 한 번 확인하면 조용히 어긋날 일이 없다.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(new URL(import.meta.url).pathname)
const read = (p: string): string => readFileSync(join(here, p), 'utf8')

const bundled = /PLUGIN_VERSION = '([^']+)'/.exec(read('core/version.ts'))?.[1]
const pkg = (JSON.parse(read('package.json')) as { version: string }).version
const manifest = (JSON.parse(read('../.claude-plugin/plugin.json')) as { version: string }).version

const all = { 'core/version.ts': bundled, 'package.json': pkg, '.claude-plugin/plugin.json': manifest }
const uniq = [...new Set(Object.values(all))]
if (uniq.length !== 1) {
  console.error('✗ 버전이 어긋났습니다 — 셋을 같게 맞추세요:')
  for (const [f, v] of Object.entries(all)) console.error(`    ${f.padEnd(28)} ${v}`)
  process.exit(1)
}

/* 업데이트 내역 — 버전을 올리면 CHANGELOG.md 에 그 버전 항목(`## 0.10.1 …`)이 있어야 한다.
   0.10.0 까지는 기록이 커밋 메시지에만 있어서 팀원이 "뭐가 바뀌었지" 를 알 길이 없었다. */
const v = uniq[0]!
const changelog = ((): string => { try { return read('../CHANGELOG.md') } catch { return '' } })()
if (!new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) {
  console.error(`✗ CHANGELOG.md 에 v${v} 항목이 없습니다 — "## ${v} · <제목> — <날짜>" 로 업데이트 내역을 적으세요`)
  process.exit(1)
}
console.log(`✓ 버전 v${v} — 세 곳 일치 · CHANGELOG 항목 있음`)
