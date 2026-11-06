/** Engine 发往各 Channel 的消息，每条都按允许它的规则发出。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * 发往某个 Channel 的消息，按用途区分：Executor 对其正在处理的某人请求的确认；worker 报告后对某人问题的回答；
 * 处于 `ready`、`completed`、`merged` 或 `dropped` 的 ticket 的结果；或 ticket 当前向人提出的 `question`（`attention`）。
 * 省略 `ticketId` 时，使用 `triggerId` 所抵达的 ticket。
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** 一条已排队的消息：其 id、是否已发出，以及此前是否已有请求排过队。 */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies 通过 Outbox 端口把 Engine 的消息写入各 Channel：确认、对某人问题的回答、ticket 的结果，以及 ticket 向人提出的
 * 问题；每条都只在规则允许时发出，并使用确定性的 id 防止重复发送（幂等）。Engine 把 `reply` 路由到这里；Tickets 向它
 * 索取 accept 携带的确认，Assignments 请它撤回被报告替换的问题。
 */
export class Replies extends EnginePart {
  /**
   * 按用途把消息排入相应的 Channel：确认或回答发往该人的消息所在处，attention 发往提出问题的消息所在处
   * （或 ticket 起始的会话），结果发往 ticket 起始的会话（`result` 只允许用于处于 `ready`、`completed`、`merged`
   * 或 `dropped` 的 ticket）。每条消息至多排队一次（幂等）。确认即使已排过队，也会记录 ticket 的 worker 已接手该消息。
   * @throws UserError 当 ticket 或 trigger 未知，或该用途的规则拒绝它，例如 ticket 未就绪、未完成、未合并或未丢弃时的结果。
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * 把 accept 携带的确认排入启动该 ticket 的消息所在处，前提是该消息有 Channel 且由人撰写。
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** 把 ticket 向人提出的问题从 outbox 撤回，除非它已经发出。 */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 仅用于上下文的 thread 是只读的，不能接收确认。
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // 保留自动生成或最先排队的确认。
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // attention 回复必须匹配 ticket 当前未决问题的文本。
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** ticket 起始的会话：其 origin Trigger 的 Channel，否则为其第一个 Channel。 */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
