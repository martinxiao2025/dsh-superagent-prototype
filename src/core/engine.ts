/** 领域 Engine：核心的唯一入口，以及其调用方所获得的角色接口。 */
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
 * 变更 Trigger、Thread、Decision、Ticket 与 Assignment 的单一事务入口。
 * 在同步的仓储事务内协调 Intake、Evals、Tickets、Assignments 与 Replies，同时通过端口把副作用排入队列。
 * 调用方获得按角色收窄的 `Pick` 接口，而非完整引擎。
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

  // Source

  /**
   * Source 请求接收一个 Trigger：只存储一次；将其分发给订阅其 Thread 的 ticket（对已结束的 ticket 只分发人的消息，
   * 且除非处理已暂停，会立即恢复它；被人停止的 ticket 不分发任何内容）；再把它排入其主 Thread 的评估队列，
   * 除非该 ticket 的 worker 会裁决它（见 `followupOwners`）。在该 Thread 的评估进行期间到达的 Trigger 会一起等待下一次评估。
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * Source 请求让一个开放的 ticket 跟随其某个 Thread（例如某个 pull request 的），`own` 表示该 ticket 开启了它：
   * ticket 会订阅它，而 ready 报告只有在 `followsDone` 成立后才结束 ticket（见 `Tickets.followsDone`）。
   * @throws UserError 当 ticket 未知或已结束。
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * Source 给出的「某个 Thread 已关闭」这一事实（例如其 pull request 的合并）及其发生时间。跟随它的开放 ticket
   * 在其跟随的 Thread 均结清之后结束，除非关闭之后恢复的工作尚未完成，或其 worker 在最近一次报告之后接手了
   * 由该 ticket 裁决的人的消息。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // 把 source 时间戳（例如 GitHub 的整秒时间）规范化为标准 ISO 形式。
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // 时钟

  /**
   * 把超期的 Eval 重新排队最多 `REQUEUES` 次，之后记为 `unavailable`（未投递的 Eval 永不过期）；启动排队 Trigger
   * 正在等待的 Thread 的 Eval；并恢复那些在处理暂停期间收到人的消息的已结束 ticket。处理暂停期间任何东西都不过期：
   * 进行中的 Eval 会记下暂停开始的时刻，恢复后其截止时间顺延暂停时长。每次 Eval 与每个 ticket 更新各占一个事务。
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

  /** 持有某个 Trigger 的 Eval 的候选（评估者视角）；没有 Eval 持有时为 undefined。 */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * 裁决一个 Trigger：由持有它的 Eval 裁决，若无则对它单独做一次直接 Eval（例如主 Session 路由的人的显式请求）。
   * 主动候选只在 `auto` 模式且其评估命中的规则均已启用时才被接受；已经启动过 ticket 的 Trigger 会返回该 ticket 的
   * Decision。无效的 stop 记为 `ignore`；在旧 Policy 下判定的则记为 `unavailable`。
   * @throws UserError 当 Trigger 未知或不可准入、`outcome.evalId` 指向已结束的 Eval、某个 ticket 的 worker 仍在裁决
   * 该 Trigger 而结果不是 stop，或在 `auto` 之外、或没有已启用且命中的规则时接受推断候选。
   */
  decide(triggerId: string, outcome: Outcome): Decision { return this.repo.atomic(() => this.evals.decide(triggerId, outcome)) }
  /**
   * 把 Trigger 附加到消息所指的 ticket：该 ticket 跟随 Trigger 的 Thread，并连同路由说明作为 Input 接收它，
   * 而持有该 Trigger 的 Eval 随之结束（ticket 现在已拥有它）；同批的其他 Trigger 等待新的 Eval。若 worker 已经收到
   * 该 Input，说明会作为新的 Input 发出；ticket 已放手、仅作上下文读取、或在其结束前就已拥有的消息也同样处理。
   * 已结束的 ticket 会在其 Mandate 下恢复，除非处理已暂停，否则立即恢复。
   * @throws UserError 对于被人停止（其 Mandate 已撤回）的 ticket，或 Policy 不再持有其 Mandate 的 ticket。
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // 该 ticket 的 worker 已交还的消息不属于它的工作：若在此附加，就没有 worker 会裁决它，也无法再次交还。
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
   * 向处于 `waiting` 状态的运行中 worker 询问其状态；其他 worker 不受影响。
   * @returns 是否已向该 worker 发出询问。
   * @throws UserError 当 ticket 未知。
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * 按用途把消息排入相应的 Channel：确认或回答发往该人的消息所在处，attention 发往提出问题的消息所在处，
   * 否则与结果一样，发往 ticket 起始的会话。此前已排队的消息不会再次排队（见 `Replies.reply`）。
   * @throws UserError 当 ticket 或 trigger 未知，或该用途的规则拒绝它，例如 ticket 未就绪、未完成、未合并或未丢弃时的结果。
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // 人，通过面板或主 Session

  /** 评估者已把某个 Eval 的候选投递到其 Session：该 Eval 的截止时间从此起算。 */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * 将已存储的 Trigger 排入新的 Eval（例如人的重放）；当某个 Eval 持有时返回 false。
   * @throws UserError 当 trigger 未知。
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * 有人忽略了某个 unavailable Decision 所显示的问题：概览不再列出它。
   * @throws UserError 对于未知或并非 unavailable 的 Decision。
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * 取消所有 ticket 对某个 Thread 的订阅，直到新的 Decision 再次订阅为止。
   * @returns 是否取消了某个订阅。
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * 有人停止某个 ticket，并撤回其 Mandate：ticket 结束，不再接收任何内容。
   * @throws UserError 当 ticket 未知。
   */
  stopTicket(ticketId: string, reason?: string): Ticket { return this.repo.atomic(() => this.tickets.stop(ticketId, reason)) }
  /**
   * 有人重试一个 worker 报告 failed 或 blocked（或其 input 投递失败）的 ticket：停滞的 Assignment 结束，
   * 在同一 Mandate 下启动新的 Assignment。
   * @throws UserError 当 ticket 未知、已结束或不可重试。
   */
  retryTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId)) }

  // Executor

  /**
   * Executor 给出的「某个 Assignment 正在运行」这一事实；等待它的 Input 会随之发出。
   * @throws UserError 当 ticket 未知。
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * Executor 给出的「Input 已抵达运行该 ticket 的 Assignment」这一事实，会清除投递失败记录。关于已不再运行的
   * Assignment 的事实会被丢弃。其 worker 会在 Session 把每条带入步骤后读取它（`inputsRead`）。
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * Executor 给出的「开放 ticket 的 worker Session 已把承载 Input 的消息带入步骤」这一事实，其模型从此读取它们：
   * 此后的一次报告或一轮结束，会在 ticket 结束时把它们计为已读。
   * @throws UserError 当 ticket 未知。
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** Executor 给出的「运行该 ticket 的 Assignment 的 worker 一轮已结束」这一事实，报告之后也是如此。 */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId) })
  }
  /** Executor 给出的「向运行该 ticket 的 Assignment 投递 Input 失败」这一事实；在投递成功之前 ticket 会显示它。 */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * worker 通过其 Executor 请求把附加到其 ticket 的某个 Thread 标记为不相关，原因为 `reason`：只取消该 ticket 的订阅，
   * 直到新的 Decision 再次订阅它。
   * @throws UserError 当 ticket 未知，或该 Thread 是 ticket 的起始 Thread、Source 绑定给它的 Thread（例如其 pull request 的），
   * 或它并未跟随该 Thread。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * Executor 为其发现相关的 Thread 建立订阅，仅用于上下文：见 `Tickets.followForContext` 与 `Thread.context`。
   * @returns 当 ticket 已跟随该 Thread 时返回 false。
   * @throws UserError 当 ticket 未知或已结束。
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * 主 Session 提供给开放 ticket 的 Executor 的一条事实：见 `Tickets.note`。
   * @throws UserError 当 ticket 未知或已结束。
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * Executor 把一条已抵达其 ticket 但要求超出该 ticket 范围的消息交还：见 `Evals.handback`。
   * @returns 是否已排入 Eval：当另一个 ticket 仍在裁决它，或该 ticket 并未裁决它时为 false（见 `Evals.handback`）。
   * @throws UserError 当 ticket 或 trigger 未知、trigger 未抵达该 ticket，或该 ticket 已交还过它。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * 在开放 ticket 当前的 Assignment 上记录一次报告。它向人提出的问题（`attention`）会被提出、保留或清除
   * （`null` 或 `ready` 报告）；被替换且回复尚未发出的 attention 问题会从 outbox 撤回。`blocked` 或 `failed` 报告
   * 会拦下自动 input，直到人的消息到达。`dropped` 报告结束 ticket；`ready` 报告也会结束 ticket：没有跟随 Thread 时为
   * `completed`，否则在 `followsDone` 成立后取它的结果。
   * @throws UserError 对于未知或已结束的 ticket、已结束的 assignment、与 ready 结果或回答同来的问题，
   * 或指向非人所发、未抵达该 ticket 的消息的问题或回答。
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * 处理宿主机停止时仍在运行的 assignment：除非其最近报告为 `waiting`、`ready`、`blocked` 或 `failed` 且该报告之后
   * 没有 Input 抵达其 worker，否则带恢复说明重启它；后一种情况下它保留自己的 Session 与状态，并接收等待它的 Input。
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
  }

  // 设置

  /**
   * Policy 发生变更：`effects` 中的每个开放 ticket 都会被告知变更如何影响它，进行中的 Eval 会在新版本下重新开始。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** Source 向 Engine 询问与告知的内容。 */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** 主 Session 向 Engine 请求的内容。 */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'>
/** 人通过面板或主 Session 向 Engine 请求的内容。 */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'>
/** Settings 告知 Engine 的内容。 */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** Executor 告知 Engine 的内容，以及其 worker 向它请求的内容。 */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply'>
