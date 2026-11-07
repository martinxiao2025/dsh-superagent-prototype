/** 核心所依赖的端口。Source、策略、研判者、执行器与渠道都是项目特定的。 */
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome, Trigger }
  from './model.ts'
import type { Reason } from './reasons.ts'

/** 准入结果：要么不可接纳并附理由 code，要么可接纳并附强度与 MandateBasis。 */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Source 是否接收某个触发；`observed` 表示它还接收未点名 agent 的消息，`row` 是策略准入表所指的接收范围，例如某个聊天。 */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** 领域眼中的 Source 配置：针对每个触发或每条已记录授权依据的监听范围。 */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** 带版本的规则；`gate` 决定谁可以发起工作。Source 范围不属于策略。 */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** 在本策略下重新检查授权的准入层依据，例如在已结束工单恢复之前。 */
  revalidate(mandate: Mandate): boolean
  /** 推断候选能否在其研判所匹配的规则上被接受：由研判来接受，且每条规则均已启用。 */
  admitsInferred(rules: readonly string[]): boolean
  /** 研判者可以在评估被记录为 unavailable 之前花费的时长。 */
  evalTimeoutMs: number
}

/** 研判者所收到的内容：有边界的事实，绝非授权。 */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** 线程上的每个工单，包括已结束的，用于重复性判断。 */
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** 一次 accept：`rules` 为研判所匹配的规则，`name` 为工单请求的短名称，`note` 为给其 worker 的路由说明。 */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** 语义研判。`request` 把研判排队，按 `evalId` 幂等；outcome 经由 `Engine.decide` 返回。 */
export interface Assessor {
  request(candidate: Candidate): void
  /** 每当一次评估结束（无论是否作出决定）时调用，使研判者丢弃为它保留的内容。 */
  release?(evalId: string): void
}

/**
 * 执行派工；并发与工作区管理是它自己的职责。引擎在其
 * 命令内部调用它，因此每个方法只把工作排队，结果经由引擎的回调报告回来。
 */
export interface Executor {
  /** 把处于 pending 的派工排队待启动；经由 `Engine.assignmentStarted` 或一份 `failed` 报告报告回来。 */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * 把工单等待的输入排队送达其运行中的派工；经由 `Engine.inputsDelivered`
   * 或 `Engine.deliveryFailed` 报告回来，并在其 worker 的执行器 Session 把它们带入某一步骤时经由 `Engine.inputsRead` 报告。
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** 结束一次派工的工作，例如取消其 Session 的一轮对话；在工单或派工已在领域内结束之后调用。 */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** 发往渠道的一条消息；`ticketId` 指明它所属的工单，如果有的话。 */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** 排队的消息在等待（`pending`）、已发出（`sent`），或因其会话永远无法收到而被丢弃（`dropped`）。 */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** 为渠道排队的消息；引擎在其命令内部把它们排队，发送方随后送达。 */
export interface Outbox {
  /** 幂等地排队一条消息；已排过队的 id 保留其第一条消息。 */
  send(message: OutboundMessage): void
  /** 消息是否已排队，以及它后来的下落。 */
  status(id: string): ReplyStatus | undefined
  /** 撤回一条尚未发出的消息。 */
  withdraw(id: string): void
}

/** 引擎在变更之后按事件类型上报的内容。 */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** 有人取消了所有工单的订阅，或某个工单的执行器取消了自己的，并附 `reason`。 */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** 一条到达了工单、且曾被更早版本排队等待评估的人的跟进消息离开了队列。 */
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** 持久状态。每个方法都是同步的，以便 `atomic` 能包裹一个工作单元。 */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** 有触发排队等待评估、或评估正在进行中的线程。 */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** 有未投递输入、或存在 pending 或 running 派工（必为最新一次）的工单。 */
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
