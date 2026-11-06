/** Tickets：从 accept 到结束的生命周期，以及它们的订阅与 Input。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, readUntil, runningAssignment, settled, threadKey, waitsForPerson } from './model.ts'
import type { Assignment, ChannelRef, Evaluation, Follow, Mandate, PolicyEffect, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome,
  Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Input 是否为非人撰写的消息，例如 CI、机器人或主 Session 的 note。 */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * ticket 的 worker 是否在 `until`（其最近一次报告或一轮结束）之前读取了某个 Trigger Input：其 Session 在此前已把该消息
 * 带入步骤。在记录读取之前投递的，只要在此前已抵达 worker 就算作已读。
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * 管理每个 ticket 的生命周期：为 accept 决策创建带 Mandate、订阅与首个 Assignment 的 ticket，绑定并附加 Thread，
 * 添加 Input，恢复、重试、重启与结束 ticket，并取消订阅。与 Replies 协调 accept 携带的确认，与 Executor 协调
 * 启动、投递与停止 assignment。Intake、Evals、Assignments 与 Engine 把 ticket 和订阅的变更委托到这里。
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * 按 accept 决策创建 ticket：在 `mandate` 下，带上该 Eval 各 Trigger 的 Channel 与 Thread、它的首个 Assignment，
   * 以及 accept 携带的确认，并排队启动。其 origin 是使该 Eval 获得强度的可准入 Trigger；对于记录于 `primary` 出现之前的
   * Eval，则用该 Eval 的最后一个 Trigger。
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // 对于记录于 `primary` 出现之前的 Eval，回退到最后一个 trigger。
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * 让开放 ticket 订阅 `thread`，并记录到 `ticket.follows`（ticket 开启的则为 `own`）。
   * @throws UserError 当 ticket 未知或已结束。
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // 重新绑定一个 thread 会在它先前已关闭时重新打开它；`own` 一旦为真便保持为真。
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * 记录一个被开放 ticket 跟随的 Thread 已关闭，并结束每个已与其 Thread 结清的 ticket（见 `followsDone`），
   * 除非其工作尚未完成（见 `unfinished`）；这类工作会在报告 ready 后结束 ticket。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // 在关闭之后恢复并已完成的工作，现在就结束。
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * 跟随 Thread 的 ticket 如何算作与它们结清：它开启（`own`）的 Thread 都不再开放时，或它没有开启任何 Thread 时，
   * 它跟随的每个 Thread 都已关闭。它按那些 Thread 中最近一次关闭的结果结束；尚未结清时为 undefined。
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * 返回可附加给 ticket 的 Trigger，前提是该 ticket 可以接收它。
   * @throws UserError 当 trigger 或 ticket 未知、某个 ticket 的 worker 仍在裁决该 trigger、有人停止了该 ticket，
   * 或已结束 ticket 的 Mandate 不再通过校验。
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 已抵达某个 ticket 的后续消息，只有在裁决它的 worker 交还后才会去别处。
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * 让 ticket 订阅所附加 Trigger 的 Thread，并把该 Trigger 连同其 note 作为 Input 加入。之后由该 ticket 的 worker 裁决它，
   * 就像裁决在其自身 Thread 上抵达 ticket 的消息一样；若 worker 不认为该消息属于其 ticket，就会把它当作新的 Input，
   * 而任何被附加的消息都会以此唤醒已结束的 ticket。
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // 有人把它送到 Eval（并由此路由到这里）这件事已经结束，ticket 仅将其作为上下文读取的状态也一并结束。
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // 有人把它送到 Eval，或 ticket 在其 worker 接手前放手、仅作上下文读取、或在其 worker 持有后结束，因此 worker
    // 会再次收到它。
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // worker 已持有该消息，因此 note 会随它再次送达。
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * 向最近报告为 `waiting` 的运行中 worker 请求状态报告；其他 ticket 不受影响。
   * @returns 状态请求 input 是否已排队。
   * @throws UserError 当 ticket 未知。
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * 代表人工停止 ticket，并结束任何活跃的 assignment。
   * @throws UserError 当 ticket 未知。
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * 结束可重试开放 ticket（`failed`、`blocked` 或 input 投递失败）的停滞 assignment，并启动新的 assignment。
   * @throws UserError 当 ticket 未知或不可重试。
   */
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    this.endAssignment(ticket, latest, 'retried')
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * 取消 ticket 对其 worker 认为不相关的 Thread 的订阅，并以 `reason` 交还那里由该 ticket 裁决的人的消息。
   * @throws UserError 当 ticket 未知，或 `thread` 是起始 thread、已绑定的 `follows` thread，或并未被订阅。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // 其 worker 认为该 Thread 不属于它的 ticket：于是带原因交还那里由它裁决的人的消息。
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * 按由旧到新的顺序，告知每个受 Policy 变更影响的开放 ticket；这样它们的投递会按接受顺序排队，其他 ticket 不受影响。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // 按由旧到新的顺序遍历 ticket，使投递按接受顺序排队。
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // 在 input 键中包含 `at`，使相同 policy 版本之间的反复切换仍记录为新的 input。
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * 取消某个 Thread 的订阅（所有 ticket 的，或仅 `ticketId` 的），并发出通知；没有取消任何订阅时返回 false。
   * 曾跟随该 Thread 的 ticket 不再跟随它，因此它的关闭不再结束该 ticket。每个 ticket 仍裁决它从该 Thread 收到的消息。
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * 幂等地添加一个 Input，并让 Executor 投递它；或者，当不再等待人工处理时，重新启动一个启动失败的 pending Assignment：
   * 仅凭 Policy 变更不会重新启动它。
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // 当 worker 正在等待人工处理时，拦下自动 input。
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * 当某个人的消息在其某个 Thread 上等待时，在 Mandate 不变的情况下恢复已结束的 ticket：不经过 Eval 也不产生 Decision，
   * 因为没有新的授权。当前 Policy 不再持有其 Mandate 的 ticket 保持结束状态，不接收任何内容（见 `refuse`）。
   * 处理暂停期间消息会等待，暂停后的第一轮会在当时的 Policy 下恢复该 ticket。函数会重新读取 ticket，因此是幂等的，
   * 并且不会影响已经恢复的 ticket。
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // 只有人的消息才会恢复已结束的 ticket；机器人/CI 的 trigger 会与 ticket 结束前已有的 input 一起等待。
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // 把恢复标记插到最前，使其先于等待中的消息被投递。
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** ticket 的 trigger Input 所对应的 Trigger；给出 `ids` 时只取其中 Input id 匹配的那些。 */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * ticket 的 worker 是否通过确认或回答接手了某条人的消息。在确认被记录到消息上之前就已确认的消息，
   * 只有确认消息本身留在 outbox 中。
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** ticket 的 Input `ids` 中由它裁决、且其 worker 未接手的人的消息。 */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * 已结束或无法恢复的 ticket 会放手其 worker 从未收到的消息（`waiting`），以及它裁决过但可能未接手的人的消息（`left`）：
   * 它不再算作消息的接收方；`left` 中没有其他 ticket 裁决的每条都会进入 Eval，就像未抵达任何 ticket 的人的消息一样——
   * 除非有 ticket 接手了它、某个 Decision 已裁定它，或它就是使该 ticket 结束的 stop 消息。
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // 以该消息停止此 ticket 的主 Session 会自行裁决该消息的其余部分，除非有 ticket 交还了它。
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** 无法恢复的已结束 ticket 不会接收任何等待它的消息（见 `letGo`）。 */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** 用一个新的 Assignment 替换 ticket 运行中的 Assignment，后者会先收到 `note`，并将其排队启动。 */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * 把已投递给 `replaced`、但未被其 worker 任何步骤取走的 Trigger Input 放回等待队列的最前面：取消可能丢弃了它们，
   * 或取走它们的步骤被中断；新 Assignment 启动时会从 Session 中取走仍在等待的副本，因此这次投递是唯一的一次。
   * 更早的结束已经放手了更早 Assignment 遗留的内容。
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * 以给定结果结束 ticket。`at` 记录结束事实发生的时间（例如 PR 合并），`reason` 用文字说明原因，默认为结果本身。
   * ticket 会放手（见 `letGo`）其 worker 从未收到的消息，以及它裁决过、但其 worker 在最近一次报告或一轮结束（包括
   * 结束该 ticket 的报告，见 `readBefore`）之前未读、且既未确认、未回答也未交还的人的消息：这类消息可能是在 worker
   * 撰写结束报告期间或在其一轮结束后到来的，无论如何它已无法再交还。
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // 时间更早的结束（例如 PR 合并）不会把 ticket 的最后变更时间往回拨。
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // 该结束所停止的 Assignment 随之结束；原因由 ticket 的结束记录说明。
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * 在 `at` 时刻的关闭时，ticket 的工作是否尚未完成：其 worker 接手了一条由该 ticket 裁决的人的消息，且自其 Session
   * 把该消息带入步骤以来没有报告过 progress 之外的状态、也没有结束过一轮；或者关闭之后恢复的工作，其 Assignment 在
   * 关闭之后启动，且没有 ready 报告，或在该报告之后有 Input 到达。Policy 变更不会要求任何工作。
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /** 添加一个 pending 的 Assignment；此前那个 Assignment 的投递失败不再与该 ticket 相关。 */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now() }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * 把一条事实作为 note Input 交给开放 ticket 的 Executor，例如另一个 ticket 的发现；它不授予任何权限（见 `TicketInput`）。
   * @throws UserError 当 ticket 未知或已结束。
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * 让开放 ticket 订阅其 Executor 认为相关的 Thread，仅用于上下文：见 `Thread.context`。
   * @returns 当 ticket 已跟随该 Thread 时返回 false。
   * @throws UserError 当 ticket 未知或已结束。
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** 让 ticket 订阅某个 Thread；其后的 Trigger 会作为 Input 抵达该 ticket，若原本仅用于上下文则转为该 ticket 自己的。 */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
