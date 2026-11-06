/** 面向 orchestrator 与 worker Session 的内置提示词片段、角色策略与对话记录投影。 */
import { bundledSkills, promptFile } from './skill-files.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
export { textPage } from './cards.ts'

/** 所有 Session 共享的内置宿主投递与工具使用规则；团队可以覆盖（`builtInParts`）。 */
export const sharedPrompt = promptFile('shared')
export const masterPrompt = promptFile('orchestrator')
export const workerPrompt = promptFile('worker')
/** 角色提示词引用的内置策略片段；团队可以覆盖。 */
export const guides: Readonly<Record<string, string>> = Object.fromEntries(['subscriptions', 'replies', 'dispatch', 'work']
  .map(name => [name, promptFile(name)]))
/** 由 dsh-superagent 注册的捆绑 Source 技能；团队可以覆盖其文本。 */
export const sourceSkills: Readonly<Record<'feishu' | 'github', string>> = { feishu: bundledSkills.feishu.content, github: bundledSkills.github.content }
export const cliNotes = promptFile('cli')
/** 团队可编辑的提示词片段（沟通、工单范围与 PR 投递）的默认文本。 */
export const teamDefaults = {
  communication: promptFile('team/communication'), scope: promptFile('team/scope'), delivery: promptFile('team/delivery'),
}

export const mainAdmissionPolicy = promptFile('admission')

const handoff = { shared: promptFile('handoff'), orchestrator: promptFile('handoff-orchestrator'), worker: promptFile('handoff-worker') }
export const handoffPolicy = (role: 'orchestrator' | 'worker'): string => `${handoff.shared}\n${handoff[role]}`

export const autoMergeThreshold = (lines: number): string => `it changes fewer than ${lines} lines (additions plus deletions);`

/** 保留消息内容，同时省略流式分块、用量统计与推理块。 */
export function transcriptEntry(event: SessionEvent) {
  if (event.type !== 'user/message' && event.type !== 'tool/result' && event.type !== 'assistant/message') return undefined
  const message = event.type === 'user/message' ? event.data : event.data.message
  return { type: event.type, message: { role: message.role, content: message.content.filter(block => block.type !== 'reasoning') } }
}
