/** 领域引擎：核心的唯一入口，以及调用方所获得的各角色接口。 */
import { UserError } from './errors.ts'
import { isoTime, liveTicket } from './model.ts'
import type { ChannelRef, Decision, PolicyEffect, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Candidate, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/**
 * 修改触发、线程、决定、工单与派工的单一事务入口。
 * 在同步的仓库事务内协调 Intake、Evals、Tickets、Assignments 与 Replies，同时通过端口把副作用
 * 排队。调用方获得的是按角色裁剪的 `Pick` 接口，而不是完整引擎。
 */
export class Engine {
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake
  constructor(private readonly options: EngineOptions) {
    this.repo = options.repo
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets)
    this.intake = new Intake(options, this.tickets)
  }

  // Source 侧

  /**
   * Source 请求接收一个触发：先存储一次，再扇出到订阅其线程的工单（对已结束的工单只接受人的消息，
   * 它会立即恢复工单，除非处理处于暂停；被人工停止的工单则一概不收），
   * 然后把它在其主线程上排队等待评估，除非某工单的 worker 会决定它（见 `followupOwners`）。
   * 在该线程的一次评估运行期间到达的触发会一起等待下一次评估。
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * Source 请求让一个未结工单跟进它的某个线程（例如某个 pull request 的），当工单
   * 自己开启该线程时传 `own`：工单订阅它，且 ready 报告只有在 `followsDone` 成立时才结束工单（见 `Tickets.followsDone`）。
   * @throws UserError，当工单未知或已结束时抛出。
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * Source 告知某个线程在其发生时刻已关闭，例如其 pull request 已合并。跟进它的未结工单
   * 会在处理完所跟进的线程后结束，除非自关闭以来恢复的工作尚未完成，或
   * 其 worker 接手了一条人的消息——工单会在其最新报告之后再决定它。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // 把 Source 的时间戳（例如 GitHub 的整秒）规范化为标准 ISO 形式。
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // 时钟

  /**
   * 把过期的评估重新排队至多 `REQUEUES` 次后才记录 `unavailable`（未投递的评估永不过期），启动
   * 排队触发仍在等待的那些线程的评估，并恢复在处理暂停期间被人的消息触达的已结束工单。
   * 处理暂停期间没有任何东西过期：每个进行中的评估会记下暂停开始的时间，其截止时间
   * 在处理恢复后按暂停时长顺延。每次评估和每次工单更新各占一个事务。
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => { this.evals.due(thread, policy) })
    if (policy.paused) return
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => { this.tickets.wake(ticket.id) })
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => { this.evals.start(thread.key, policy) })
    }
  }

  // 主 Session

  /** 持有某个触发的评估的候选，按其研判者所见呈现；在没有任何评估持有它时为 undefined。 */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * 决定一个触发：由持有它的评估来决定；若没有评估持有，则单独对它直接评估，例如主 Session
   * 路由来的某个人的显式请求。主动候选只有在 `auto` 模式下且其研判匹配了启用的规则时才被接受，
   * 已经开启工单的触发会返回该工单的决定。无效的 stop 会被记录为
   * `ignore`；在旧策略下作出的判定则记为 `unavailable`。
   * @throws UserError，当触发未知或不可接纳、`outcome.evalId` 指向一个已完成的评估、
   * 工单的 worker 仍在决定该触发而 outcome 不是 stop，或推断候选在 `auto`
   * 模式之外、或在没有启用匹配规则的情况下被接受时抛出。
   */
  decide(triggerId: string, outcome: Outcome): Decision { return this.repo.atomic(() => this.evals.decide(triggerId, outcome)) }
  /**
   * 把一个触发附加到该消息所指向的工单：工单跟进触发的各线程，并把消息作为带路由说明的
   * 输入接收，持有该触发的评估随之结束，因为工单已经拿到它；同批次的其他触发
   * 则等待一次新的评估。针对 worker 已收到输入的说明会作为新输入发出，工单
   * 曾放过、仅作上下文读取、或在结束前就已收到的消息也是如此。已结束的工单在其授权下恢复，
   * 除非处理处于暂停，否则立即恢复。
   * @throws UserError，针对被人停止（授权已撤回）的工单，或授权已不再被策略维持的工单抛出。
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // 该工单的 worker 交回的消息不属于它的活儿：在这里附加的话，不会有 worker 决定它，也无法再次交回。
      const handedBack = this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }
  /**
   * 向处于 `waiting` 状态等待的运行中 worker 询问其状态；其他状态的 worker 不被打扰。
   * @returns 是否已向该 worker 询问。
   * @throws UserError，当工单未知时抛出。
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * 按消息用途指定的渠道排队一条消息：确认或答复发到当初写该人的消息的地方，
   * attention 发到引发问题的消息所在处，否则像结果一样发到工单
   * 开启时的会话。已经排过队的消息不会再次排队（见 `Replies.reply`）。
   * @throws UserError，当工单或触发未知，或该用途的规则拒绝它时抛出，例如工单
   * 并非 ready、completed、merged 或 dropped 的结果。
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // 人，通过管理面板或主 Session

  /** 研判者已把评估的候选送达其 Session：评估的截止时间从现在起算。 */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * 把已存储的触发排队等待一次新的评估，例如人的重放；在某个评估持有它时返回 false。
   * @throws UserError，当触发未知时抛出。
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * 一个人关闭 unavailable 决定所显示的问题：概览不再列出它。
   * @throws UserError，针对未知或并非 unavailable 的决定抛出。
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * 取消所有工单对某线程的订阅，直到新的决定再次订阅为止。
   * @returns 是否有订阅被取消。
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * 一个人停止工单，这会撤回其授权：工单结束且不再接收任何内容。
   * @throws UserError，当工单未知时抛出。
   */
  stopTicket(ticketId: string, reason?: string): Ticket { return this.repo.atomic(() => this.tickets.stop(ticketId, reason)) }
  /**
   * 一个人重试 worker 报告为 failed 或 blocked 的工单（或输入投递失败的工单）：停滞的
   * 派工结束，并在同一授权下开启新的派工。
   * @throws UserError，当工单未知、已结束或不可重试时抛出。
   */
  retryTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId)) }

  // 执行器

  /**
   * 执行器告知某次派工已开始运行；等待它的输入随之发出。
   * @throws UserError，当工单未知时抛出。
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * 执行器告知输入已到达运行工单的派工，这会清除一次失败的投递。关于
   * 不再运行的派工的事实会被丢弃。其 worker 在执行器 Session 把每条输入带入某一步骤时才会读取它（`inputsRead`）。
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * 执行器告知未结工单的执行器 Session 已把携带输入的消息带入某一步骤，其
   * 模型从该步骤中读取它们：此后的一次报告或一轮对话结束时会在工单结束时把它们视为已读。
   * @throws UserError，当工单未知时抛出。
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** 执行器告知运行工单的派工的 worker 结束了一轮对话，报告之后也如此。 */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId) })
  }
  /** 执行器告知向运行工单的派工投递输入失败；工单会显示这一情况，直到某次投递成功。 */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * worker 通过其执行器请求把附加到其工单的某线程标记为无关，并给出 `reason`：只有该
   * 工单的订阅被取消，直到新的决定再次订阅为止。
   * @throws UserError，当工单未知，或线程是工单开启时所在的线程、Source 绑定给它的线程（例如
   * 其 pull request 的），或它并未跟进的线程时抛出。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * 执行器订阅它发现相关的线程，用作上下文：见 `Tickets.followForContext` 与 `Thread.context`。
   * @returns 当工单已跟进该线程时返回 false。
   * @throws UserError，当工单未知或已结束时抛出。
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * 主 Session 给予未结工单执行器的一条事实：见 `Tickets.note`。
   * @throws UserError，当工单未知或已结束时抛出。
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * 执行器交回一条已到达其工单但诉求超出其范围的消息：见 `Evals.handback`。
   * @returns 它是否已被排队等待评估：在另一个工单仍在决定它时为 false；对一条本工单未曾决定的消息也是如此（见 `Evals.handback`）。
   * @throws UserError，当工单或触发未知、触发未曾到达该工单，或工单已交回过它时抛出。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * 在未结工单的当前派工上记录一份报告。其中向人提出的问题（`attention`）会被提出、保留或
   * 清除（`null` 或 `ready` 报告），被取代且其回复尚未发送的 attention 问题会从
   * 发件箱撤回。`blocked` 或 `failed` 报告会扣住自动输入，直到一条人的消息到达。`dropped`
   * 报告结束工单，`ready` 报告同样结束工单：没有跟进的线程时为 `completed`，否则在 `followsDone`
   * 成立时以 `followsDone` 的结果结束。
   * @throws UserError，针对未知或已结束的工单、已结束的派工、与 ready 结果或
   * 答复同时出现的问题，或问题/答复所指的消息并非人的消息或未曾到达工单的情况抛出。
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * 处理宿主停止时正在运行的派工：除非其最新报告为
   * `waiting`、`ready`、`blocked` 或 `failed` 且该报告之后没有输入到达其 worker——此时保留其
   * Session 与状态，并取得等待它的输入——否则附带一条恢复说明重启派工。
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
  }

  // 设置

  /**
   * 策略发生了变更：`effects` 中的每个未结工单都会被告知这次变更与它的关系，进行中的评估
   * 则在新版本下重新开始。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** Source 向引擎请求和告知的内容。 */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** 主 Session 向引擎请求的内容。 */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'>
/** 人通过管理面板或主 Session 向引擎请求的内容。 */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'>
/** 设置告知引擎的内容。 */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** 执行器告知引擎的内容，以及其 worker 向它请求的内容。 */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply'>
