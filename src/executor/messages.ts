/** 工单与 trigger 的消息格式化、执行元数据与临时失败判定；不依赖任何宿主。 */
import { join } from 'node:path'
import { key, threadKey } from '../core/index.ts'
import type { AssessmentOutcome, Execution, Mandate, PolicyEffect, Ticket, TicketInput, Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { executionRoot } from '../app/execution-environment.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'

/** 返回工单对应的 worker 会话 ID（`worker-<ticketId>`）。 */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** 返回 worker 会话 ID（`worker-<ticketId>`）对应的工单 ID；非 worker 会话返回 undefined。 */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * 当错误表示临时的网络或模型提供方失败时为 true：HTTP 408、429 或 5xx 状态，
 * 或连接被拒绝、被重置、超时，或无法解析主机。
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** 在校验通过的英文 worktree 名称后追加稳定的 12 字符工单 ID 后缀。 */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** 在 Store 中查找工单的来源 trigger。 */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * 返回请求之外、给 worker 的附加系统提示词 mandate 指令：对于按规则主动接受的工作
 * （`strength === 'inferred'`），把授权限制为规则范围内的小型内部改动；显式请求返回 `''`。
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? '该工单只有有限的主动授权。请独立核实它是在已接受规则范围内、单个模块内部的小型改动。'
    + '若它需要公开接口或行为变更、新的交互、产品决策或澄清，请停下来并汇报 dropped；不要扩大范围。' : ''
}
/** 构建新接受工单的 Execution 元数据：worktree 名称、工作区目录与 assignment 文本。 */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const note = outcome.note ? `\n路由说明（不是来源请求）：${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\n匹配到的规则；它们的过程与沟通指令优先于该工单默认的确认与消息发送 Policy：${rules}` : ''
  // 来源 trigger 会与 assignment 一同投递，因此 `assignment` 中省略 trigger 文本。
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `依据 ${ruleIds.join(', ')} 主动接受。范围：${outcome.scope}。${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** worker 消息中内联 assignment 与 trigger 文本的字符上限；更长的文本通过其资源读取。 */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** 返回不超过 `limit` 个字符的 `text`；超长时返回截断预览，并给出总字符数和读取全文的资源路径。 */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * 把 Trigger 格式化为向 worker 投递的形式：作者、线程、时间戳、不超过 `TRIGGER_CHARS` 的文本、来源消息链接、
 * 可选的路由说明，以及 worker 尚未见过时被回复消息的预览。
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** 把工单接受批次中的同批 trigger 格式化：作者、时间戳、160 字符预览和读取资源路径。 */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** 返回工单来源批次中的其他 trigger（不含主 `origin.triggerId`），按时间从旧到新。 */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = '该工单此前已结束，其后在它的 Thread 上出现的消息已在同一 mandate 下恢复它。若它在原始范围内要求更多，'
  + '请检查 worktree、git 历史与 PR 状态并继续；若它要求超出该范围的工作或另一个工单的工作，请用 orchestrator_trigger_handback '
  + '交还，并汇报 dropped；若它不需要任何事，例如只是道谢，请不发消息地汇报 dropped。'
  + '后续完成时汇报 ready。不要重复已完成的工作。'
/** 为 worker 格式化策略变更输入；在 `effect` 出现之前记录的输入退回为通用通知。 */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy 变更：访问或准入规则已改变。请检查剩余工作是否仍在该 Assignment 内。'
  return ['Policy 变更：',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `该工单接受时所依据的规则 ${rule.name} (${rule.id}) 已不再适用：只完成其范围内的改动，或汇报 dropped。`
      : `该工单接受时所依据的规则 ${rule.name} (${rule.id}) 已变更。请按它现在的表述，让剩余工作保持在其范围内：${rule.instruction}`),
    ...effect.proactive === false ? ['由规则推断出的工作不再被接受，因为接受模式已不再是 auto：只完成该 Assignment 内正在进行的工作，'
      + '或汇报 dropped，并且不承接任何新工作。'] : [],
    ...effect.requesterAllowed === false ? [`${effect.requester ? `该工单所针对的发送者 ${effect.requester.id}（来源 ${effect.requester.source}）` : '该请求的发送者'}`
      + '已不能再在此启动工作：请在其范围内完成该 Assignment，并且不再受理来自该发送者的新请求。'] : []].join('\n')
}
/** worker 会话读取工单输入全文所使用的资源路径。 */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * 把工单输入格式化为向 worker 投递的形式：经 `trigger` 渲染的 `trigger`（缺席时按其 ID 与读取路径）、
 * `policy-changed` 通知、`resumed` 通知、编排器 `note`，或原样输出的 `text` 输入。
 * 对遗留的 `reopen` 输入返回 `undefined`；它们只具历史意义，因为 schema 11 迁移已把待处理的 reopen 输入转成了 text 输入。
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // 标记通过仅上下文订阅到达的 trigger，让 worker 知道它们并非发给该工单。
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `来自 orchestrator 的说明，仅供上下文参考：${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
