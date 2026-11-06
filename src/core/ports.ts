/** 核心依赖的端口。Source、policy、评估器、executor 与通道属于具体项目。 */
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome, Trigger }
  from './model.ts'
import type { Reason } from './reasons.ts'

/** 闸门准入结果：要么不可准入并给出原因码，要么可准入并给出强度与 MandateBasis。 */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Source 是否接收某个 Trigger；`observed` 表示它也接收未对 agent 说话的消息，`row` 是 Policy 准入表所指的接收 scope（例如某个会话）。 */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** 领域视角下的 Source 配置：按 trigger 或按已记录的 Mandate basis 判定监听 scope。 */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** 带版本的规则；`gate` 决定谁可以发起工作。Source scope 不属于 Policy 的一部分。 */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** 在该 policy 下重新检查 mandate 的闸门层 basis，例如在已结束 ticket 恢复之前。 */
  revalidate(mandate: Mandate): boolean
  /** 推断候选是否可以按其评估命中的规则被接受：接受需由评估给出，且每条规则都已启用。 */
  admitsInferred(rules: readonly string[]): boolean
  /** 评估者最多可以花费多长时间，超过后该评估即记为 unavailable。 */
  evalTimeoutMs: number
}

/** 评估者收到的内容：有界的事实，绝不包含授权。 */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** thread 上的每个 ticket（含已结束的），用于判断重复。 */
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** 一次接受：`rules` 是评估命中的规则，`name` 是请求的 ticket 简称，`note` 是给其 worker 的路由说明。 */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** 语义判定。`request` 把评估排入队列，按 `evalId` 幂等；结果通过 `Engine.decide` 返回。 */
export interface Assessor {
  request(candidate: Candidate): void
  /** 每当一次评估结束（无论是否已裁决）时调用，以便评估者丢弃为它保留的内容。 */
  release?(evalId: string): void
}

/**
 * 执行 assignment；并发与工作区管理由它自行负责。Engine 在其命令内部调用它，
 * 因此每个方法只负责把工作排队，结果通过 Engine 的回调返回。
 */
export interface Executor {
  /** 将一个待启动的 assignment 排队启动；结果通过 `Engine.assignmentStarted` 或 `failed` 报告返回。 */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * 把 ticket 等待中的 Input 排队投递给其运行中的 assignment；结果通过 `Engine.inputsDelivered` 或 `Engine.deliveryFailed`
   * 返回，并在其 worker 的 Session 将其带入步骤后通过 `Engine.inputsRead` 返回。
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** 结束 assignment 的工作，例如取消其 Session 的一轮；在领域内 ticket 或 assignment 已结束后调用。 */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** 发往某个 Channel 的消息；若存在对应的 Ticket，`ticketId` 指明它。 */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** 排队中的消息在等待（`pending`）、已发出（`sent`），或因所在会话永远无法接收而被丢弃（`dropped`）。 */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** 为各 Channel 排队的消息；Engine 在其命令内部排队，之后由发送方投递。 */
export interface Outbox {
  /** 幂等地排队一条消息；此前已排队的 id 保留其最早的消息。 */
  send(message: OutboundMessage): void
  /** 消息是否已排队，以及它的后续状态。 */
  status(id: string): ReplyStatus | undefined
  /** 撤回一条尚未发出的消息。 */
  withdraw(id: string): void
}

/** Engine 在变更后按事件类型上报的内容。 */
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
  /** 某人取消了所有 ticket 的订阅，或某个 ticket 的 Executor 取消了自己的订阅，原因为 `reason`。 */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** 某人的后续消息已抵达 ticket，而旧版本又把它排入 Eval 队列，现在它已离开该队列。 */
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** 持久化状态。所有方法都是同步的，以便 `atomic` 能包裹一个工作单元。 */
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
    /** 有 Trigger 排队等待评估、或正在评估中的 Thread。 */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** 有未投递 Input、或有 pending/running Assignment（且总是最新那个）的 Ticket。 */
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
