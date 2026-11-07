/** 格式化通过 effect 队列投递给主 Session 的后台通知与引导中继。 */
import { randomUUID } from 'node:crypto'
import { followupOwners, key, liveTicket, type DomainEvent, type Ticket, type WorkerReport } from '../core/index.ts'
import { triggerMessage } from '../executor/messages.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { repliedTo } from './links.ts'
import type { Store } from './store.ts'
import { ticketCard } from './cards.ts'

/**
 * 面向主 Session 的后台通知元组：`[name, value, summary]`，其中 `name` 是 `Effects` 中的合并键
 * （同一 `name` 的较新通知会覆盖尚未发送的等待通知，而不是永久去重后续通知）。
 */
export type Notice = readonly [name: string, value: Record<string, unknown>, summary: string]
/** 为已保存的提示词配置修订构建通知，按 `'prompts'` 合并。 */
export const promptsNotice = (revision: number): Notice =>
  ['prompts', { prompt_config_saved: revision, effect: 'next-request', read: `prompts/${revision}` }, `提示词配置已保存（修订 ${revision}）`]
/**
 * 为已保存的设置块构建通知，附带变更的点分路径（按块在 `settings:<block>` 下合并）；
 * 对未记录块的旧版保存则针对整体设置。
 */
export const settingsNotice = (block?: string, changed: string[] = []): Notice => block
  ? [`settings:${block}`, { settings_saved: block, changed, read: `settings/${block}` }, `设置已保存：${block}`]
  : ['settings', { settings_saved: true, read: 'settings' }, '设置已保存']
/** 返回最多 20 个两值不同的点分路径（例如 `eval.mode` 或 `policy.rules.1.enabled`）。 */
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [path]
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const at = (value: object, name: string) => (value as Record<string, unknown>)[name]
  return keys.flatMap(name => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name)).slice(0, 20)
}
/** 当 relay 已携带或无需该摘要时，从工单卡片中去掉最新报告的预览。 */
function brief(ticket: Ticket) {
  const { preview: _preview, ...card } = ticketCard(ticket)
  return card
}
/** 创建带唯一 `name` 键的一次性回执通知，使同一事件的多次发生各自投递而不合并。 */
export const receiptNotice = (value: Record<string, unknown>, summary: string): Notice => [key('receipt', randomUUID()), value, summary]
/** 构建“某人在 `at` 时刻移除了 thread 订阅”的通知；同一 thread 之后再次移除会替换尚未发送的等待通知。 */
export const subscriptionNotice = (thread: string, at?: string): Notice => [`subscription:${thread}`,
  { subscription_changes: [{ thread, removed: true }], ...at ? { at } : {} }, `已移除 Thread ${thread} 上的订阅`]

/**
 * 把非请求触发的领域事件转换为主 Session 通知（`ticket.ended`、`trigger.requeued`，或由真人或执行器触发的
 * `thread.unsubscribed`）；无需通知的事件返回 `undefined`。
 */
export function eventNotice(event: DomainEvent, ticket: (id: string) => Ticket | undefined = () => undefined): Notice | undefined {
  const { at } = event
  if (event.type === 'ticket.ended') {
    const { ticketId, by, outcome, reason = outcome } = event.data
    const ended = ticket(ticketId)
    return receiptNotice(ended ? { ticket_ended: brief(ended) } : { ticket_ended: ticketId, by, outcome, reason, at }, `工单 ${ticketId} 已结束（${reason}）`)
  }
  if (event.type === 'trigger.requeued') {
    const id = event.data.triggerId
    return receiptNotice({ trigger_requeued: id, read: `trigger/${id}`, at }, `Trigger ${id} 已排队等待重新评估`)
  }
  if (event.type === 'thread.unsubscribed' && event.data.by === 'person') return subscriptionNotice(event.data.threadKey, at)
  if (event.type === 'thread.unsubscribed') {
    const { ticketId, threadKey: thread, reason } = event.data
    const note = '其 Executor 阅读后认为该 Thread 不相关；只有当后续 Trigger 明确指向该 Thread 时，才把它们关联到本工单。'
    return receiptNotice({ thread_unrelated: { ticket_id: ticketId, thread, reason }, at, note },
      `工单 ${ticketId} 不再关注 Thread ${thread}：${reason}`)
  }
  return undefined
}

/** 当工单的 worker 仅为上下文而关注相关 thread 时，构建后台通知。 */
export const threadFollowedNotice = (ticketId: string, thread: string, reason: string): Notice =>
  receiptNotice({ thread_followed: { ticket_id: ticketId, thread, reason },
    note: '仅供上下文参考：其消息会送达本工单，但不授予任何权限。' },
    `工单 ${ticketId} 为获取上下文而关注 Thread ${thread}：${reason}`)

/** 面向主 Session 的引导中继载荷：`id` 是保证投递幂等的 request ID，`text` 是消息正文。 */
export interface Relay { id: string; text: string }
/** 后续跟进对主 Session 的要求：除了真人要求的停止之外别无其他，因为该工单的 worker 会自行决定。 */
const FOLLOWUP_NOTE = '该工单的 worker 已接手并自行决定；仅当此人要求停止该工作时才行动'
  + '（使用 orchestrator_route，kind 为 stop，并带上该 trigger_id）。'
/**
 * 为至少送达一个未结束工单的真人后续 trigger 构建引导中继（包括因该后续跟进而复活的已结束工单），
 * 其中 trigger 按 worker 读取的形式呈现，并附上所回复的消息与它送达的未结束工单；
 * 当没有任何工单的 worker 决定它（见 `followupOwners`），或它未送达任何未结束工单时返回 `undefined`。
 */
export function followupNotice(store: Store, sources: SourceRegistry, triggerId: string): Relay | undefined {
  const trigger = store.triggers.get(triggerId)
  const disposition = store.triggers.disposition(triggerId)
  if (!trigger || !followupOwners(trigger, store).length) return undefined
  const tickets = disposition!.fanout.flatMap(id => {
    const ticket = store.tickets.get(id)
    const context = disposition!.context?.includes(id) ? { context: true } : {}
    return ticket && liveTicket(ticket) ? [{ ticket_id: id, title: ticket.title, state: ticketCard(ticket).state, ...context }] : []
  })
  if (!tickets.length) return undefined
  return followupRelay(triggerMessage(trigger, {}, undefined, repliedTo({ store, sources }, trigger)), tickets)
}
/**
 * 真人消息送达工单后，主 Session 听到的版本：消息按各 worker 读取的形式呈现，并附上它送达的工单及其状态。
 * 由各 worker 决定处理；主 Session 只能停止其上的工作。
 */
export function followupRelay(message: { trigger_id: string },
  tickets: readonly { ticket_id: string; title: string; state: string; context?: boolean }[]): Relay {
  return { id: `followup:${message.trigger_id}`, text: JSON.stringify({ kind: 'follow_up', ...message, delivered_to: tickets,
    note: FOLLOWUP_NOTE }) }
}
/** 为主 Session 格式化 worker 报告中继（超过 600 字符的摘要截断，完整内容在 `ticket/<id>/result`）；`replyTo` 指明它所回答的真人提问 trigger。 */
export function resultRelay(ticket: Ticket, state: string, text: string, replyTo?: string): Relay {
  const id = key('worker-result', ticket.id, ticket.updatedAt, text)
  const summary = text.length > 600 ? { summary: text.slice(0, 600), chars: text.length } : { summary: text }
  const report = { kind: 'worker_report', ticket: brief(ticket), trigger_id: ticket.origin.triggerId, state, ...replyTo ? { answer_to: replyTo } : {},
    ...summary, read: `ticket/${ticket.id}/result` }
  return { id: `report:${id}`, text: JSON.stringify(report) }
}
/**
 * 把记录在 `ticket` 上的 worker 报告转换为主 Session 中继：向真人提出的问题会生成
 * `worker_attention` 中继；结果、阻塞、结束或对提问的回答会生成 `worker_report` 中继；
 * 而不带 `answers` 的常规 `progress` 报告保持内部。
 * @returns 引导用的 `Relay`；报告不向主 Session 中继时返回 `undefined`。
 */
export function reportRelay(ticket: Ticket, report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>): Relay | undefined {
  const asked = report.question ? ticket.attention : undefined
  if (asked) {
    return { id: `attention:${ticket.id}:${asked.id}`,
      text: JSON.stringify({ kind: 'worker_attention', ticket: brief(ticket), state: report.state, read: `ticket/${ticket.id}/result` }) }
  }
  if (report.state === 'progress' && !report.answers) return undefined
  return resultRelay(ticket, report.state, report.summary, report.answers)
}
