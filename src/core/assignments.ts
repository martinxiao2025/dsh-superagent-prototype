/** 执行器及其 worker 对运行工单的派工所上报的内容。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** 一次派工上报的内容：worker 的报告，或执行器自己的报告（空闲一轮后为 `waiting`，出错后为 `failed`）。 */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** 向人提出的待回答问题：字符串表示提出，`null` 表示清除现有问题，`undefined` 表示保持现状。 */
  question?: string | null
  /** 该人的消息，其请求引发了此问题；用于把问题路由到当初写这条消息的渠道。 */
  askedBy?: string
  /** 本报告所回答的那个人的问题，worker 由此接手该问题；授权主 Session 发送一条答复回复。 */
  answers?: string
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments 记录执行器及其 worker 对运行工单的派工所上报的内容：某次派工已启动、输入
 * 已送达或未能送达、worker 的执行器 Session 把输入带入某一步骤、worker 的一轮对话结束、宿主重启
 * 打断了派工，以及 worker 带着向人提出问题的报告。它依赖
 * Tickets 来重启或结束工单，依赖 Replies 来撤回被新报告取代的问题；引擎把
 * 执行器的生命周期回调和其 worker 的报告路由到这里。
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** 将未结束的派工标记为运行中，把未结工单上等待投递的输入排队送达，并发出 `assignment.started`。 */
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
   * 将 `inputIds` 标记为已送达工单正在运行的派工，并清除先前的 `delivery` 失败；若派工已
   * 不在运行则忽略。其 worker 在执行器 Session 把每条输入带入某一步骤时才会读取它（见 `read`）。
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
  /** 记录未结工单的执行器 Session 何时把 `inputIds` 带入某一步骤，其模型从该步骤中读取它们。 */
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
   * 处理被宿主重启打断的运行中派工：除非其最新报告为
   * `waiting`、`ready`、`blocked` 或 `failed` 且该报告之后没有输入送达——此时保留其
   * session 并冲刷所有等待投递的输入——否则附带一条恢复说明重启派工。
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
   * 在未结工单的当前派工上记录 worker 状态报告，更新 `attention`、`answers`、被扣住的自动
   * 输入，并在 `dropped` 时、或 `ready` 且不再等待所跟进的线程时（`followsDone`）结束工单。
   * @throws UserError，当工单未知或已结束、派工已结束、问题与 ready 结果或 answers 同时出现，
   * 或问题/答复引用了非人类的触发或未送达的触发时抛出。
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
    // 被取代或清除的 attention 问题会从发件箱撤回先前问题所有待发送且未发送的回复。
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    // 跟进线程的工单随线程一起结束：ready 报告只有在 followsDone 成立时才以该结果结束工单。
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // 在工单推迟了一次关闭之后的 dropped 报告，会按该关闭本应有的结果结束工单，其最终通知会说明这一点。
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** 返回该工单，前提是它仍未结且由 `assignmentId` 运行。 */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
