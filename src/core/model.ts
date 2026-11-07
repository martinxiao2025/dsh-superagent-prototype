/** 主动式 agent 的领域模型：概念及其不变量，独立于任何 Source、策略或执行器。 */
import type { Reason } from './reasons.ts'

/** 以 Source 自身词汇表示的行动者身份；由策略决定哪些行动者可以在该 Source 上发起工作。 */
export interface ActorRef { source: string; id: string }
/** 线程身份；从原生事件推导 `id` 的规则属于 Source。 */
export interface ThreadRef { source: string; id: string }
/** 线程上只写的地址；地址格式属于 Source。 */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** 线程在整个领域中的稳定键。 */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/**
 * 把有效的时间戳规范化为 `Date#toISOString` 形式，使存储的时间戳在内存与 SQL 中都能按字典序比较；
 * 无法解析为时间戳的值原样返回。
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** Source 产生的一条不可变事件。`text` 与 `meta` 是不受信任的外部数据。 */
export interface Trigger {
  id: string
  source: string
  /** 触发所属的每个线程；第一个（`threads[0]`）是承载其评估的主线程。 */
  threads: ThreadRef[]
  actor: ActorRef
  /** Source 声明：该事件由人而非 bot、CI 或本 agent 写下。 */
  human: boolean
  /** Source 声明：发件人点名了 agent，或在发给它的单聊消息中写道。 */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** 供适配器使用的 Source 原生细节；核心从不解释它们。 */
  meta: Record<string, unknown>
}

/** 触发在接收之后的去向；它不授予任何权限，但决定由谁来决定一个人的跟进消息（见 `followupOwners`）。 */
export interface TriggerDisposition {
  /** 在进入领域之前被 Source 范围过滤器拒绝，附 Source 给出的理由。 */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * 它所到达的工单，经由订阅扇出或由主 Session 附加；已结束、或在其 worker 接手前无法恢复
   * 的工单不再计入。
   */
  fanout: string[]
  /** `fanout` 中仅经由其执行器为上下文而跟进的线程到达的工单，这使它不属于它们。 */
  context?: string[]
  /** 由人、或由主 Session（针对没有任何工单决定的消息）再次送去评估；交回不会设置它。 */
  requeued?: true
  /** 其执行器把该触发交回为超出工单范围的工单，每个工单一次，并附原因；在没有任何工单决定它时送去评估。 */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** 其执行器确认或答复了该触发的工单，将其接手为工单范围内的事。 */
  acked?: string[]
  at: string
}
/** 决定跟进消息的归属者时所需读取的内容：按 Store 与核心保存的形式存储的工单、线程与处置记录。 */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * 其 worker 决定一个人的跟进消息的工单：该消息经由工单自己的线程到达、仍可决定它
 * 且未曾交回它的那些工单。工单在存续期间可以决定，即便有人已取消其对线程的订阅；
 * 工单已结束但并非被人停止、且触发正等待恢复它时也可以。一旦有人把它送去评估，
 * 或某个评估正持有它——更早版本可能排的队——就没有归属者。工单持有该消息期间，消息不会进入评估，
 * 主 Session 只能停止其上的工作。
 */
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  // 处置记录本身就能排除大多数消息，因此只有可能存在归属者的消息才会去读线程或工单。
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
 * 某个决定是否已就人的消息所求作出处置：针对它的 stop（无论执行还是拒绝）只决定该工单的
 * 工作，把它路由到某个工单则交给该工单的 worker，而 unavailable 什么也没有决定。
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** 准入表中接收范围所在行的各单元格，按发件人是否已列出以及是否点名 agent 划分。 */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * 主动候选是被研判并接受（`auto`），是仍被研判、由决定记录下本会接受什么
 * （`would_accept`）但不接受（`observe`），还是不被接纳（`off`）。
 */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** 授权的触发在哪里被接收：其 Source、Source 记录的接收范围，以及其准入行。 */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * 准入如何接纳授权所来自的触发，`revalidate` 会重新检查它（见 `docs/002`）：
 * - `addressed`：Source 列表上的发件人点名了 agent；
 * - `followup`：一条到达拥有工单的线程上的消息；
 * - `admission`：接收范围准入行中的单元格；当它在一
 *   种接单模式下成为推断候选时附 `observation`；
 * - `listed`：在授权开始记录其依据之前接受的，来自仍必须留在列表上的发件人；`authority` 是
 *   更早版本记录的替代字段。
 * `sender` 记录接受时被允许的发件人，`rules` 记录研判所匹配的规则。
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** 其 Source 的 bot 列表上某个 bot 的消息：至多是推断候选，绝不是显式请求，也不是 stop。 */
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
)

/** 由 accept 决定产生的不可变授权；执行以其为界，且它永不改变。 */
export interface Mandate {
  strength: Strength
  policyVersion: string
/** 准入如何接纳它，供重新校验与审计使用。 */
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** 线程上正在进行的触发评估；每个线程至多一个。 */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** 给出该批次强度的可接纳触发，评估所开启的工单以它为源头。 */
  primary?: string
  strength: Strength
  /** 最强可接纳触发的行动者与准入依据；accept 时它们构成授权的雏形。 */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** 候选到达研判者 Session 的时间戳；在此之前它不会过期，其截止时间从那一刻起算。 */
  delivered?: string
  /** 过期时间戳，从送达起算（送达前从开始起算）；处理暂停会使其按暂停时长顺延。 */
  deadline: string
  /** 处理暂停开始的时间戳；恢复时 `deadline` 按暂停时长顺延；恢复时清除。 */
  pausedAt?: string
}

/** 线程聚合：评估的一致性边界，订阅与决定历史的持有者。 */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** 线程上最新一个触发的时间。 */
  lastAt?: string
  /** 订阅了该线程的工单；存续的工单通过扇出把每个触发作为上下文接收。 */
  subscriptions: string[]
  /**
   * 其执行器为只读上下文而跟进该线程的订阅工单，例如它发现的某个 Issue 或另一条 pull request：
   * 线程上的消息会到达它们，但不授予任何权限，其中人的消息也不能恢复其中任何一个已结束的工单。
   */
  context?: string[]
  /** 与本线程共享过触发的其他线程的键；仅作上下文。 */
  correlated: string[]
  /** 等待下一次评估的触发（去抖缓冲区）。 */
  pending: string[]
  evaluating?: Evaluation
  /** 其排队触发的评估连续过期的次数，每次过期都会把它们重新排队；决定会清除它。 */
  expired?: number
  /**
   * 渠道或读取方所需的 Source 原生属性（例如飞书线程 id）。其 Source 还可以为
   * 人描述该线程：`label` 为显示名，`facts` 为一个 {@link ThreadFacts} 映射。
   */
  meta: Record<string, unknown>
}
/** 两种界面语言各自的文本，或两者相同的一段文本。 */
export type Text = string | { zh: string; en: string }
/** Source 就其线程陈述的一条事实，例如 issue 编号或 CI 结果；`problem` 标记需要人处理的事实。 */
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** 线程的事实，按 id 索引、按展示排序；每个写入方拥有自己的事实 id。 */
export type ThreadFacts = Record<string, ThreadFact>

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'
/** 一次评估的结果，记录在线程上。 */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** 理由，按 code：一条理由，或其所涉批次中每个触发各一条。 */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** 研判者提供的审计数据（规则研判、落点、证据）。 */
  audit?: Record<string, unknown>
  /** 有人关闭了 unavailable 决定所显示的问题。 */
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * 派工上报的内容：工作正在进行（`progress`）、其 worker 在等待触发（`waiting`）、结果
 * 已就绪（`ready`）、需要人介入以解除阻塞或恢复（`blocked` 或 `failed`），或已无事可做（`dropped`）。
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** 工单与一个执行器实例之间的绑定。 */
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
  /** 输入最后一次到达 worker 的时间；有一条不早于 `report.at` 即表示自该报告以来 worker 一直在处理输入。 */
  deliveredAt?: string
  /**
   * 其 worker 最后一轮对话结束、且既没有留给它运行的也没有等待它的内容的时间：在此之前其
   * Session 带入某一步骤的内容，worker 都已读过。
   */
  idleAt?: string
}

export type TicketInput =
  /** 其某条线程上的触发，或被附加给它的触发；人写下时带 `human`。 */
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** 它只经由工单执行器为上下文而跟进的线程到达该工单。 */
    context?: true
    /**
     * worker 的执行器 Session 把携带它的消息带入某一步骤的时间，其模型从该步骤读取它；在
     * Session 中等待期间为 `null`。在记录读取机制引入之前送达的输入没有此字段，从 `deliveredAt` 起视为已读。
     */
    readAt?: string | null
    /** 它最后一次被投递到的派工。 */
    deliveredTo?: string
    /** 更早版本把它交给 worker 的时间。 */
    deliveredAt?: string }
  /** 策略发生了与该工单相关的变更，如 `effect` 所述；在效果机制引入之前写入的输入没有此字段。 */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** 某个决定重新打开了工单；在已结束工单可自行恢复之前写入。 */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** 其某条线程上的人的消息在授权不变的前提下恢复了已结束的工单。 */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** 主 Session 从其他工作中给予工单的一条事实：上下文，不求任何结果，也不授予任何权限。 */
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * 策略变更与某工单的关系：其被接受时依据的规则中发生了变化、附其现行 instruction，或已
 * 不再适用的部分；当推断工作不再被接受（例如接单模式离开 `auto`）时为 `proactive: false`；以及
 * 当其针对的发件人 `requester`——一个人或一个 bot——不再能在那里发起工作时为 `requesterAllowed: false`。
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** 工单如何结束：取得其结果、其 pull request 被合并或以未合并状态关闭、无事可做，或被人停止。 */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** 向人提出的问题；`triggerId` 是引发它的那条人的消息，问题会回到其会话中。 */
export interface Attention { id: string; question: string; triggerId?: string }
/** 工单聚合：一项获得授权的工作，连同其派工、渠道、线程绑定与输入。 */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** 它被接受时所来自消息的渠道，其回复发往这里。 */
  channels: ChannelRef[]
  /** 工单何时、由谁、如何结束，并附结果之外由人或宿主给出的原因；未结工单没有此字段。 */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** 向人提出的待回答问题；由执行器清除，或在工单结束时清除。 */
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  /** 尚未交给运行中派工的输入。 */
  undelivered: string[]
  /**
   * Source 让工单跟进的线程，例如其各条 pull request：`ready` 报告只有在
   * `followsDone` 成立时才结束工单；使 `followsDone` 成立的那次关闭会以该结果结束工单，除非其工作尚未完成（见
   * `Tickets.unfinished`），此时其下一个 `ready` 或 `dropped` 报告才会结束工单。
   */
  follows?: Follow[]
  /** worker 已回答的人的问题，主 Session 可以发送其答案。 */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** 它被接受时所来自的触发：开启它的那一个，以及其评估所持有的批次。 */
  origin: { triggerId: string; triggerIds: string[] }
  /** 其执行器选择的内容：短名称、目录与派工文本。 */
  execution?: Execution
  /** 最近一次向其 worker 投递输入的失败，直到某次投递成功为止。 */
  delivery?: { error: string; at: string }
}
/**
 * 工单跟进的一个线程，按其键索引：工单自己开启它（例如其自己的 pull request）时为 `own`，以及它
 * 何时、如何关闭。只要没有自己开启的线程仍处于打开状态，`followsDone` 即成立；若工单没有 `own`
 * 线程，则所有被跟进的线程关闭后成立；此时工单随之结束，除非其工作尚未完成（见 `Tickets.unfinished`）。
 */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Execution { name: string; directory: string; assignment: string }

/** 工单是否未结：它尚未结束。 */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** 工单结束的方式。 */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/**
 * 某触发是否到达过某工单：它开启了该工单、作为输入到达过它，或位于工单订阅的
 * 线程上；`context` 为 false 时排除工单仅为上下文而跟进的线程，其 worker 在那里可以读但不能写。
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
/** 工单各次派工中最新的一份报告，即工单最后一次表态的内容。 */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * 工单的 worker 到何时为止曾有一轮机会读取所到达的内容：其最新报告——`progress`
 * 为 false 时不含进度报告——或其最近一轮对话的结束时间，取其中更晚者。
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * 工单是否在等待人：其最新派工报告为 blocked 或 failed，且此后没有人的消息到达。
 * 之后一份两者皆非的报告、一条人的消息、或一次重试（会开启新的派工）都会解除等待。
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
}
