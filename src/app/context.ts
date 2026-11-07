/** 面向 orchestrator 与 worker Session 的内置提示词片段、角色策略与对话记录投影。 */
import { bundledSkills, promptFile } from './skill-files.ts'
export { textPage } from './cards.ts'

/** 一条落库的对话记录：只保留角色与文本/工具块，省略推理与用量统计。 */
export interface TranscriptEntry {
  type: 'user/message' | 'assistant/message' | 'tool/result'
  message: { role: 'user' | 'assistant'; content: { type: string; text?: string }[] }
}

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

export const autoMergeThreshold = (lines: number): string => `变更行数少于 ${lines} 行（新增与删除合计）；`

/** 原样返回一条落库的对话记录；保留此投影是为了让资源视图与历史引用保持稳定。 */
export const transcriptEntry = (entry: TranscriptEntry): TranscriptEntry => entry
