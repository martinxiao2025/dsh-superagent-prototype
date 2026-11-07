/** Tickets：从 accept 到结束的生命周期，以及它们的订阅与输入。 */
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
/** 某输入是否为并非人写的消息，例如 CI 的、bot 的，或主 Session 的 note。 */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * 工单的 worker 是否在 `until`——其最新报告或回合结束——之前读过某触发输入：其 Session 在那之前
 * 把消息带入过某一步骤。在记录读取机制引入之前送达的输入，只要在那时之前到达了 worker，即视为已读。
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * 管理每个工单的生命周期：为 accept 决定创建工单及其授权、订阅与第一次
 * 派工，绑定和附加线程，添加输入，恢复、重试、重启和结束工单，并取消订阅。
 * 与 Replies 协调 accept 所附带的确认，与执行器协调派工的启动、投递与停止。
 * Intake、Evals、Assignments 与 Engine 把工单和订阅的修改委托到这里。
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * 在 `mandate` 下创建 accept 所决定的工单，带上评估各触发所属的渠道与线程、第一次
   * 派工以及 accept 附带的确认，并把它的启动排队。其源头是给出评估强度的可接纳触发，
   * 对在 `primary` 出现之前记录的评估则取评估的最后一个触发。
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // 对在 `primary` 出现之前记录的评估，回退到最后一个触发。
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
   * 让未结工单订阅 `thread`，并把它记录到 `ticket.follows` 中（工单自己开启时为 `own`）。
   * @throws UserError，当工单未知或已结束时抛出。
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // 重新绑定先前已关闭的线程会重新打开它；`own` 一旦设置就保持为 true。
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * 记录未结工单所跟进的某个线程已关闭，并结束每个已处理完其线程的工单（见 `followsDone`），
   * 除非其工作尚未完成（见 `unfinished`）；这类工作会在报告 ready 后结束工单。
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
      // 关闭之后恢复且现已完成的工作现在结束。
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * 跟进线程的工单如何才算处理完它们：只要它自己开启的（`own`）线程没有仍在打开的，或它没有开启任何线程时，
   * 其跟进的线程全部关闭。工单以这些线程中最晚的一次关闭的结果结束；尚未处理完时为 undefined。
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * 要附加给工单的触发，前提是该工单可以接下它。
   * @throws UserError，当触发或工单未知、某工单的 worker 仍在决定该触发、工单被人停止，或已结束工单的授权不再能通过重新校验时抛出。
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 已到达某工单的跟进消息，只有在决定它的各 worker 交回之后才会去别处。
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * 让工单订阅被附加触发的各线程，并把该触发连同其说明作为输入添加。此后由工单的
     * worker 决定它，正如它决定到达工单自己线程上的消息一样；不把该消息视为其工单
   * 所属的 worker 会把它作为新的输入接下，这会像任何被附加的消息一样唤醒已结束的工单。
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // 人把它送去评估、进而路由到这里的事已结束，工单仅把它作为上下文读取的状态也同样结束。
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
    // 有人把它送去评估，或工单在其 worker 接手之前放过了它、仅把它作为上下文读取、或在其
    // worker 拿到它之后结束了，因此 worker 会再次收到它。
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // worker 已经有这条消息，因此说明会随它再次送达。
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * 向最新报告为 `waiting` 的运行中 worker 请求一份状态报告；不惊动任何其他工单。
   * @returns 状态请求输入是否已排队。
   * @throws UserError，当工单未知时抛出。
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * 代表一个人停止工单，并结束所有仍活动的派工。
   * @throws UserError，当工单未知时抛出。
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * 结束可重试未结工单（`failed`、`blocked` 或输入投递失败）的停滞派工，并开启新的派工。
   * @throws UserError，当工单未知或不可重试时抛出。
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
   * 取消工单对其 worker 发现无关的线程的订阅，并附 `reason` 把该处工单所决定的人的消息交回。
   * @throws UserError，当工单未知，或 `thread` 是源头线程、已绑定的 `follows` 线程，或并未订阅时抛出。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // 其 worker 发现该线程不属于其工单：它附上原因，把该处它所决定的人的消息交回。
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * 告知每个与策略变更相关的未结工单，按从旧到新的顺序，使它们的投递按被接受的顺序排队；
   * 其余工单不受影响。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // 按从旧到新的顺序遍历工单，使投递按接受顺序排队。
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // 把 `at` 放进输入键中，使相同策略版本之间的重复转换仍会记录一条新的输入。
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * 取消某线程的订阅——所有工单的或仅 `ticketId` 的——并宣告这一变化；没有任何订阅被取消时为 false。
   * 曾跟进该线程的工单不再跟进它，因此线程的关闭不再结束该工单。每个工单仍继续决定
   * 它从该线程收到的消息。
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
   * 添加一次输入（幂等），并请执行器投递它，或在不再等待任何人时重新启动一次启动
   * 失败的 pending 派工：仅凭策略变更不会重新启动它。
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // worker 在等待人时扣住自动输入。
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * 当工单某条线程上的人的消息在等待它时，在其授权不变的前提下恢复已结束的工单：没有评估
   * 也没有决定，因为没有授权任何新东西。授权已不被当前策略维持的工单保持结束状态，
   * 什么也不接（见 `refuse`）。处理暂停期间消息会等待，暂停后的第一轮处理会以当时的策略
   * 恢复工单。每次都重新读取工单，因此它是幂等的，且不会惊动已恢复的工单。
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // 只有人的消息才能恢复已结束的工单；bot/CI 触发与工单结束之前到达的输入一起等待。
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // 把 resumed 标记插到最前面，使它先于等待中的消息送达。
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** 工单触发输入所对应的触发，或在给定 `ids`（输入 id）时取其中这些输入对应的触发。 */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * 工单的 worker 是否通过确认或答复接手了某人的消息。在确认被记录到消息上之前
   * 得到确认的消息，只有发件箱里的那条确认消息可供判断。
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** 工单输入 `ids` 中、由它决定且其 worker 尚未接手的人的消息。 */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * 已结束或无法恢复的工单会放开其 worker 从未收到的消息（`waiting`），以及它决定过但可能尚未
   * 接手的人的消息（`left`）：它不再算作已到达这些消息，而 `left` 中没有其他工单决定的每一条
   * 都会像没有到达任何工单的人的消息一样进入评估，除非有工单接手了它、某个决定已对它作出处置，
   * 或它正是 stop 借以结束本工单的那条消息。
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
      // 就该消息停止本工单的主 Session 会自行处理它的其余部分，除非有工单交回过它。
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** 无法恢复的已结束工单不接下任何等待它的消息（见 `letGo`）。 */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** 用一个新的派工替换工单正在运行的派工，新派工最先收到 `note`，并把它的启动排队。 */
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
   * 把投递给了 `replaced`、但其 worker 的任何步骤都未接下的触发输入放回等待队列的最前面：取消可能
   * 丢弃了它们，或认领它们的步骤被中断，而新派工的启动会把仍在 Session 中等待的副本
   * 取出来，因此这次投递是唯一的一次。更早的结束已放开过更早派工留下的内容。
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * 以其结果结束工单。`at` 记录结束这一事实发生的时刻，例如 PR 合并，`reason` 用文字说明
   * 原因，默认为结果本身。工单会放开（见 `letGo`）其 worker 从未收到的消息，以及它决定的、
   * 其 worker 在最新报告或回合结束之前（包括结束工单的那份报告）未曾读过（见 `readBefore`）、
   * 也未确认、未答复、未交回的人的消息：其中某条可能在 worker 撰写结束工单的报告时到达，
   * 或在其回合结束之后到达，无论哪种情况它都已无法再交回。
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
    // 日期更早的结束（例如 PR 的合并）不会把工单的最近变更时间往回调。
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // 结束所叫停的派工随之结束；工单的结束记录说明了原因。
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * 在 `at` 时刻的关闭发生时，工单的工作是否尚未完成：自其 Session 把某人的消息带入某一步骤以来，
   * 其 worker 接手了该工单决定的人的消息、且除进度外没有再报告或结束过回合；或工作在关闭之后
   * 恢复，其派工在关闭之后才启动、没有 ready 报告或该报告之后到达的输入；策略
   * 变更不构成未完成的工作。
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
  /** 添加一次 pending 派工；对前一次派工失败的投递不再与工单相关。 */
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
   * 把一条事实作为 note 输入交给未结工单的执行器，例如另一个工单发现的内容；它不授予任何权限（见 `TicketInput`）。
   * @throws UserError，当工单未知或已结束时抛出。
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * 让未结工单订阅其执行器发现相关的线程，用作上下文：见 `Thread.context`。
   * @returns 工单已跟进该线程时返回 false。
   * @throws UserError，当工单未知或已结束时抛出。
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
  /** 让工单订阅一个线程；其上后来的触发作为输入到达工单，此前仅为上下文时则成为工单自己的。 */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
