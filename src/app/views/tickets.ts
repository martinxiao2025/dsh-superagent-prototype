/** 工单列表、工单详情、Mandate 依据格式化与执行器负载视图。 */
import { liveTicket, threadKey, ticketStage, type AcceptMode, type AdmissionCell, type MandateBasis, type Ticket,
  type TicketStage } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { Store } from '../store.ts'
import { channelLink, decisionView, newestFirst, page, snapshot, threadSummary, ticketLine, type Snapshot,
  type ViewHost } from './records.ts'
import { markdown, preview } from './text.ts'

export type BasisFact =
  | { name: 'addressed'; value: 'mention' | 'direct' } | { name: 'followup' } | { name: 'admission'; value: AdmissionCell } | { name: 'observation' }
  | { name: 'mode'; value: AcceptMode } | { name: 'rules'; value: { id: string; name: string }[] } | { name: 'sender'; value: string }
  | { name: 'legacyAuthority'; value: string } | { name: 'bot' }
/**
 * 按阅读顺序提取可展示的 Mandate 准入事实（省略仅为复验而保存的接收范围），
 * 并把只有 `authority` 的早期版本记录标记为 `legacy`。
 */
export function basisFacts(basis: MandateBasis, rule: Snapshot['rule']): { facts: BasisFact[]; legacy: boolean } {
  const facts: BasisFact[] = []
  if (basis.sender) facts.push({ name: 'sender', value: basis.sender })
  if (basis.via === 'bot') facts.push({ name: 'bot' })
  if (basis.via !== 'followup' && basis.addressed) facts.push({ name: 'addressed', value: basis.addressed })
  // 导入的依据已在 `authority` 中记录了它的后续跟进。
  if (basis.via === 'followup' && !basis.authority) facts.push({ name: 'followup' })
  if (basis.via === 'admission') facts.push({ name: 'admission', value: basis.cell })
  const observation = basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot' ? basis.observation : undefined
  // 被列入列表的机器人消息无论在何处接收都算推断候选，因此 `observation` 中只展示接受模式。
  if (observation && basis.via !== 'bot') facts.push({ name: 'observation' })
  if (observation?.mode) facts.push({ name: 'mode', value: observation.mode })
  if (basis.rules?.length) facts.push({ name: 'rules', value: basis.rules.map(rule) })
  const authority = basis.via === 'followup' || basis.via === 'listed' ? basis.authority : undefined
  if (authority) facts.push({ name: 'legacyAuthority', value: authority })
  return { facts, legacy: authority !== undefined }
}
export function ticketList(host: ViewHost, stage: 'open' | TicketStage['stage'], offset: number, limit: number) {
  const view = snapshot(host)
  const { store } = view
  const shown = (ticket: Ticket) => stage === 'open' ? liveTicket(ticket) : ticketStage(ticket).stage === stage
  const tickets = (stage === 'ended' ? store.tickets.list() : store.tickets.open()).filter(shown).sort(newestFirst)
  const result = page(tickets, offset, limit)
  return { ...result, items: result.items.map(ticket => ticketRow(view, ticket)) }
}
export type TicketListView = ReturnType<typeof ticketList>
export function ticketRow(view: Snapshot, ticket: Ticket) {
  const line = ticketLine(view, ticket)
  const channel = ticket.channels[0]
  const reply = line.stage === 'person' && channel ? channelLink(view, channel) : undefined
  return { ...line, ...reply ? { reply } : {} }
}
/** 执行器槽位占用：处于活跃回合的 `running` worker Session（占用槽位，重启会被打断），以及排队等待槽位的工单数 `queued`。 */
export interface ExecutorLoad { running: number; queued: number }
export function executorLoad(store: Store, running: number): ExecutorLoad {
  const queued = (ticket: Ticket) => { const stage = ticketStage(ticket); return stage.stage === 'working' && stage.action === 'queued' }
  return { running, queued: store.tickets.open().filter(queued).length }
}
export function ticketDetail(host: ViewHost, id: string) {
  const { store } = host
  const ticket = store.tickets.get(id)
  if (!ticket) return undefined
  const view = snapshot(host)
  const { stage } = ticketStage(ticket)
  const decision = store.decisions.get(ticket.decisionId)
  const input = (value: Ticket['inputs'][number]) => {
    const trigger = value.kind === 'trigger' ? store.triggers.get(value.triggerId) : undefined
    const handback = trigger && store.triggers.disposition(trigger.id)?.handbacks?.find(item => item.ticketId === id)
    const shown = trigger && { id: trigger.id, actor: view.actor(trigger.actor, trigger.human), human: trigger.human,
      preview: preview(trigger.text), thread: threadKey(trigger.threads[0]!),
      ...handback ? { handback: { reason: handback.reason, at: handback.at } } : {} }
    const text = (value.kind === 'text' || value.kind === 'note') && value.text ? { text: markdown(value.text) } : {}
    return { ...value, ...text, delivered: !ticket.undelivered.includes(value.id), ...shown ? { trigger: shown } : {} }
  }
  // 对机器人发起的 Mandate 传 `human = false`，这样即使该 actor 已从策略列表移除，Source 类型仍会把它标记为机器人。
  const human = ticket.mandate.basis.via !== 'bot'
  return { ...ticketLine(view, ticket), mandate: { ...ticket.mandate, actor: view.actor(ticket.mandate.actor, human) },
    basis: basisFacts(ticket.mandate.basis, view.rule), paused: store.settings().paused,
    channels: ticket.channels.map(channel => channelLink(view, channel)),
    decision: decision ? decisionView(view, decision) : undefined,
    // 每个已启动的 Assignment 都在该工单唯一的 worker Session 中运行。若运行中的 assignment 的 worker 报告了非 progress 状态，则其回合已结束，除非有真人回应让工单继续。
    assignments: ticket.assignments.map(assignment => ({ ...assignment, ...assignment.startedAt ? { ref: workerSessionId(ticket.id) } : {},
      ...assignment.state === 'running' && assignment.report && assignment.report.state !== 'progress' && stage !== 'working'
        ? { turnEndedAt: assignment.report.at } : {} })),
    inputs: ticket.inputs.slice().reverse().map(input),
    // 仅为上下文而关注的 thread（例如相关 issue）不授予授权，并以 `context: true` 标记。
    threads: view.threadsOf(id).map(thread => ({ ...threadSummary(view, thread),
      ...thread.context?.includes(id) ? { context: true as const } : {} })) }
}
export type TicketDetailView = NonNullable<ReturnType<typeof ticketDetail>>
