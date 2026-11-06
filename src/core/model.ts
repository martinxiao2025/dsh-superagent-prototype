/** 主动式 agent 的领域模型：概念及其不变量，独立于任何 source、policy 或 executor。 */
import type { Reason } from './reasons.ts'

/** 用 source 自身词汇表示的行为者身份；由 Policy 决定哪些行为者可以在该 Source 上发起工作。 */
export interface ActorRef { source: string; id: string }
/** Thread 身份；从原生事件推导出 `id` 的规则属于该 source。 */
export interface ThreadRef { source: string; id: string }
/** thread 上的只写地址；地址格式属于该 source。 */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** thread 在整个领域内的稳定键。 */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/**
 * 将合法时间戳规范为 `Date#toISOString` 形式，使存储的时间戳在内存与 SQL 中可按字典序比较；
 * 无法解析为时间戳的值原样返回。
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** 由 source 产生的一条不可变事件。`text` 与 `meta` 属于不可信的外部数据。 */
export interface Trigger {
  id: string
  source: string
  /** 该 trigger 所属的全部 thread；第一个（`threads[0]`）是承载其评估的主 thread。 */
  threads: ThreadRef[]
  actor: ActorRef
  /** 由 source 声明：该事件由人而非机器人、CI 或本 agent 写入。 */
  human: boolean
  /** 由 source 声明：发送者明确对 agent 说话，方式是提及它或给它发直接消息。 */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** 供适配器使用的 source 原生细节；核心从不解释它们。 */
  meta: Record<string, unknown>
}

/** trigger 进入 intake 之后的去向；它不授予任何权限，但决定由谁裁决某个人的后续消息（见 `followupOwners`）。 */
export interface TriggerDisposition {
  /** 在进入领域之前被 source scope 过滤器拒绝，原因为该 Source 给出的原因。 */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * 它通过订阅分发抵达、或被主 Session 附加到的 ticket；已结束的 ticket，或没有 worker 接手就无法恢复的
   * ticket 不再计入。
   */
  fanout: string[]
  /** `fanout` 中仅在 Executor 出于上下文而跟随的 Thread 上抵达的 ticket，对这些 ticket 而言它不属于它们。 */
  context?: string[]
  /** 由人或（对没有 ticket 裁决的消息而言）主 Session 再次把它送到 Eval；hand-back 不会设置它。 */
  requeued?: true
  /** 其 Executor 将其作为超出 ticket 范围而交还的 ticket，每个仅一次，并附原因；当无人裁决它时进入 Eval。 */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** 其 Executor 确认或回答了它、把它视为 ticket 范围内的 ticket。 */
  acked?: string[]
  at: string
}
/** 裁决某个后续消息的负责方时所读取的内容：按 Store 与核心保存形式存放的 ticket、Thread 与处置记录。 */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * 由哪些 ticket 的 worker 裁决某个人的后续消息：消息在其自身 Thread 上抵达、仍能裁决它且没有交还的那些 ticket。
 * 仍开放的 ticket 可以，人取消其对 Thread 的订阅后也可以，由非人原因结束、且 Trigger 仍在等待恢复它的 ticket 也可以。
 * 一旦有人把它送到 Eval，或某个 Eval 持有它（旧版本可能把它排过队），就没有这样的 ticket。当 ticket 拥有它时，
 * 消息不会进入任何 Eval，主 Session 只能停止其上的工作。
 */
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  // 仅凭处置记录就能排除大多数消息，因此只有可能存在负责方的消息才会去读 Thread 或 ticket。
  const returned = new Set(disposition.handbacks?.map(item => item.ticketId))
  const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id))
  if (!reached.length || records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)) return []
  return reached.filter(id => {
    const ticket = records.tickets.get(id)
    return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))))
  })
}
/**
 * 某个 Decision 是否已裁定一个人的消息所要求的事：针对它的 stop（无论采纳还是拒绝）只裁定该 ticket 的工作，
 * 把它路由到某个 ticket 则留给该 ticket 的 worker，而 unavailable 的决策什么都没有裁定。
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** 准入表中接收 scope 所在行的单元格，按发送者是否在名单内、是否明确对 agent 说话区分。 */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * 主动候选是被评估并接受（`auto`）、仍被评估但只由 Decision 记录它将接受什么（`would_accept`）而不实际接受（`observe`），
 * 还是不被准入（`off`）。
 */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** Mandate 对应的 Trigger 是在哪里收到的：它的 Source、Source 记录的接收 scope，以及它所在的准入行。 */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * 闸门是如何准入 Mandate 所来自的 Trigger 的，`revalidate` 会重新检查（见 `docs/002`）：
 * - `addressed`：Source 名单内的发送者明确对 agent 说话；
 * - `followup`：有 ticket 的 Thread 上的一条消息；
 * - `admission`：接收 scope 所在准入行的单元格；若在某种接受模式下产生了推断候选，则为 `observation`；
 * - `listed`：在 Mandate 记录 basis 之前接受的，来自一个必须仍在名单内的发送者；`authority` 是旧版本记录的内容。
 * `sender` 是接受时被允许的发送者名称，`rules` 是评估命中的规则。
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** 某 Source 机器人列表中机器人发来的消息：最多只是推断候选，永远不会是显式请求或 stop。 */
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
)

/** 由 accept 决策产生的不可变授权；执行受其约束，且它永不变更。 */
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** 闸门准入它的方式，用于重新校验与审计。 */
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** thread 上正在进行的 trigger 评估；每个 thread 至多存在一个。 */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** 使该批次获得其强度的可准入 Trigger；该 Eval 启动的 ticket 以它作为 origin。 */
  primary?: string
  strength: Strength
  /** 最强可准入 trigger 的行为者与闸门 basis；接受时它们构成 mandate 的初始值。 */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** 候选抵达评估者 Session 的时间戳；在此之前不会过期，其截止时间从此时起算。 */
  delivered?: string
  /** 过期时间戳，从投递时刻起算（投递前则从开始时刻起算）；处理暂停会把截止时间向后推迟暂停时长。 */
  deadline: string
  /** 处理暂停开始的时刻；恢复时会把 `deadline` 向后推迟暂停时长，并在恢复后清除。 */
  pausedAt?: string
}

/** Thread 聚合：评估的一致性边界，持有订阅与决策历史。 */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** thread 上最新 trigger 的时间。 */
  lastAt?: string
  /** 订阅了该 thread 的 ticket；仍开放的 ticket 会通过分发把每个 trigger 作为上下文接收。 */
  subscriptions: string[]
  /**
   * 已订阅、但其 Executor 只为只读上下文而跟随该 thread 的 ticket，例如它发现的某个 Issue 或另一个 pull request：
   * 其消息会抵达这些 ticket 但不授予任何权限，那里的人的消息也不会恢复其中已结束的 ticket。
   */
  context?: string[]
  /** 与本 thread 共享过同一个 trigger 的 thread 键；仅作上下文。 */
  correlated: string[]
  /** 等待下一次评估的 trigger（去抖缓冲）。 */
  pending: string[]
  evaluating?: Evaluation
  /** 其排队 Trigger 的 Eval 连续过期了多少次（每次过期都会把它们重新排队）；一个 Decision 会清除该项。 */
  expired?: number
  /**
   * 通道或读取方所需的 source 原生属性（例如飞书 thread id）。其 Source 也可以为人们描述该 thread：
   * `label`（显示名）与 `facts`（{@link ThreadFacts} 映射）。
   */
  meta: Record<string, unknown>
}
/** 两种界面语言下的文本，或两种语言相同的文本。 */
export type Text = string | { zh: string; en: string }
/** Source 就自己的 thread 陈述的一条事实，例如 issue 编号或 CI 结果；`problem` 标记需要人工处理的那条。 */
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** thread 的按 id 索引的事实，按显示顺序排列；每个写入方拥有自己的事实 id。 */
export type ThreadFacts = Record<string, ThreadFact>

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'
/** 一次评估的结果，记录在 thread 上。 */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** 原因，按码表示：一个原因，或它涉及的批次中每个 Trigger 各一个。 */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** 评估者提供的审计数据（规则评估、方向、证据）。 */
  audit?: Record<string, unknown>
  /** 有人已忽略某个 unavailable Decision 所显示的问题。 */
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * Assignment 报告的内容：工作正在进行（`progress`）、其 worker 在等待 Trigger（`waiting`）、结果已就绪（`ready`）、
 * 需要人工介入才能解阻或恢复（`blocked` 或 `failed`），或已无事可做（`dropped`）。
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** ticket 与某个 executor 实例之间的绑定。 */
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
  /** Input 最近一次抵达 worker 的时间；若其不早于 `report.at`，说明 worker 自该报告后一直忙于处理 Input。 */
  deliveredAt?: string
  /**
   * 其 worker 的一轮最后一次在既无待执行任务、也无待处理消息的情况下结束的时间：此前其 Session 已带入步骤的内容，
   * 该 worker 都已读取。
   */
  idleAt?: string
}

export type TicketInput =
  /** 位于其某个 Thread 上、或被附加到它的 Trigger；由人撰写时 `human` 为真。 */
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** 它仅在 Executor 出于上下文而跟随的 Thread 上抵达该 ticket。 */
    context?: true
    /**
     * worker 的 Session 把承载它的消息带入步骤的时间，其模型从那时起读取它；在 Session 中等待时为 `null`。
     * 在记录读取之前投递的没有该值，视为自 `deliveredAt` 起已读取。
     */
    readAt?: string | null
    /** 它最近一次被投递到的 Assignment。 */
    deliveredTo?: string
    /** 旧版本将其交给 worker 的时间。 */
    deliveredAt?: string }
  /** Policy 以 `effect` 所述方式影响到该 ticket 的变更；早于 effect 写入的 Input 没有该字段。 */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** 某个 Decision 重新打开了该 ticket；写于已结束 ticket 自行恢复之前。 */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** 其某个 Thread 上的人的消息，在 Mandate 不变的情况下恢复了已结束的 ticket。 */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** 主 Session 从其他工作带给该 ticket 的事实：仅作上下文，既不要求也不授予任何权限。 */
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * 一次 Policy 变更如何影响某个 ticket：其接受时所依据的规则中，已变更的规则及它们当前的 instruction，或不再适用的规则；
 * 一旦推断工作不再被接受（例如接受模式离开 `auto`），则为 `proactive: false`；而当它所面向的发送者 `requester`
 * （人或机器人）不再能在那里发起工作时，则为 `requesterAllowed: false`。
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** ticket 如何结束：随其结果、随其 pull request 被合并或以未合并关闭、无事可做，或被人工停止。 */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** 向人提出的问题；`triggerId` 是提出它的人的消息，回答会回到该消息所在的会话。 */
export interface Attention { id: string; question: string; triggerId?: string }
/** Ticket 聚合：一个经授权的工作项，及其 assignment、通道、thread 绑定与 input。 */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** 它被接受时所依据消息的 Channel，回复会发往这些通道。 */
  channels: ChannelRef[]
  /** ticket 结束的时间、结束方与方式，以及超出 outcome 之外由人或宿主机给出的原因；开放的 ticket 没有该字段。 */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** 向人提出的未决问题；由 executor 清除，或在 ticket 结束时清除。 */
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  /** 尚未交给运行中 assignment 的 Input。 */
  undelivered: string[]
  /**
   * Source 让该 ticket 跟随的 Thread，例如其 pull request 的：`ready` 报告只有在 `followsDone` 成立后才结束 ticket；
   * 使其成立的那次关闭会以该结果结束 ticket，除非其工作尚未完成（见 `Tickets.unfinished`），那时则由它下一次
   * `ready` 或 `dropped` 报告结束。
   */
  follows?: Follow[]
  /** worker 已回答的人的问题，主 Session 可以发送这些回答。 */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** 它被接受时所依据的 Trigger：启动它的那个，以及其 Eval 持有的那一批。 */
  origin: { triggerId: string; triggerIds: string[] }
  /** 其 Executor 选择的内容：简称、目录与 assignment 文本。 */
  execution?: Execution
  /** 最近一次向 worker 投递 Input 的失败，直到某次投递成功为止。 */
  delivery?: { error: string; at: string }
}
/**
 * ticket 跟随的 Thread，以它的键表示：`own` 表示该 ticket 开启了它（例如它自己的 pull request），以及它何时、
 * 以何种方式关闭。当它自己的 Thread 都不再开放时 `followsDone` 成立；若 ticket 没有 `own` Thread，则所有被跟随的
 * Thread 都关闭时成立；此后 ticket 即结束，除非其工作尚未完成（见 `Tickets.unfinished`）。
 */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Execution { name: string; directory: string; assignment: string }

/** ticket 是否开放：即它尚未结束。 */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** ticket 的结束方式。 */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/**
 * Trigger 是否抵达某个 ticket：它启动了该 ticket、作为 Input 到达，或位于该 ticket 订阅的 Thread 上；
 * 当 `context` 为 false 时，不包括仅为上下文而跟随的 Thread，在那里其 worker 只能读不能写。
 */
export function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context = true): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id)
  return trigger.threads.some(ref => {
    const current = thread(threadKey(ref))
    return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id))
  }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))))
}
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
/** ticket 各 Assignment 中最近的一份报告，即该 ticket 最后陈述的内容。 */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * ticket 的 worker 最晚到何时还有机会读取抵达它的内容：取它最近的报告（当 `progress` 为 false 时排除 progress 报告）
 * 与它最近一轮结束时间中较晚的那个。
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * ticket 是否在等待人工处理：其最近一个 Assignment 报告了 blocked 或 failed，且此后没有人的消息抵达它。
 * 之后既非 blocked 也非 failed 的报告、人的消息，或开启新 Assignment 的重试，都会解除该状态。
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
}
