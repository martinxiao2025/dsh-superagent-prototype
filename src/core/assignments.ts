/** Executor 及其 worker 就运行 ticket 的 assignment 所报告的内容。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** Assignment 报告的内容：worker 的报告，或 Executor 自己的报告（空闲一轮后为 `waiting`，出错后为 `failed`）。 */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** 向人提出的未决问题：字符串表示提出问题，`null` 清除已有的问题，`undefined` 保持当前问题不变。 */
  question?: string | null
  /** 其请求引出该问题的人的消息；用于把问题路由到该消息所在的通道。 */
  askedBy?: string
  /** 该报告所回答的人的问题，worker 因此接手了它；由此授权主 Session 发送回答回复。 */
  answers?: string
}
const RECOVERY_NOTE = '宿主在该工单期间重启过。继续之前，请检查当前 worktree、git 历史与 GitHub 状态。不要重复已完成的外部操作。完成原 Assignment，并汇报其状态。'

/**
 * Assignments 记录 Executor 及其 worker 就运行 ticket 的 Assignment 所报告的内容：某个 Assignment 已启动、Input 抵达
 * 或投递失败、其 worker 的 Session 把 Input 带入步骤、其 worker 的一轮结束、宿主机重启导致中断，以及带有人工问题的
 * worker 报告。它依赖 Tickets 重启或结束 ticket、依赖 Replies 撤回被报告替换的问题；由 Engine 把 Executor 的生命周期
 * 回调与 worker 报告路由到这里。
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** 把未结束的 assignment 标记为运行中，在开放 ticket 上排队投递等待中的未投递 input，并发出 `assignment.started`。 */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * 在 ticket 运行中的 assignment 上把 `inputIds` 标记为已投递，并清除此前的 `delivery` 失败；若已不再运行则忽略。
   * 其 worker 会在 Session 把每条带入步骤后读取它（见 `read`）。
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** 记录开放 ticket 的 worker Session 何时把 `inputIds` 带入步骤，其模型从此读取它们。 */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * 处理被宿主机重启打断的运行中 assignment：除非其最近报告为 `waiting`、`ready`、`blocked` 或 `failed` 且该报告之后
   * 没有 input 被投递，否则带恢复说明重启它；后一种情况下它保留其 session 并冲刷所有等待中的未投递 input。
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * 在开放 ticket 当前的 assignment 上记录一份 worker 状态报告，更新 `attention`、`answers`、被拦下的自动 input，
   * 并在 `dropped` 时、或在 `ready` 且未在等待跟随的 thread（`followsDone`）时结束 ticket。
   * @throws UserError 对于未知或已结束的 ticket、已结束的 assignment、与 ready 结果或回答同时给出的问题，
   * 或引用了非人或未抵达 trigger 的问题/回答。
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // 被替换或清除的 attention 问题会把此前问题尚未发出的待发回复从 outbox 撤回。
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    // 跟随 Thread 的 ticket 随它们一起结束：ready 报告只有在 followsDone 成立后才以该结果结束它。
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // 在 ticket 推迟的关闭之后到来的 dropped 报告，按该关闭的结果结束它，最终通知会说明这一点。
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** 当 ticket 开放且由 `assignmentId` 运行时，返回该 ticket。 */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
