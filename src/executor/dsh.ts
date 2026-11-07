/** DSH 执行器：为每个工单管理一个持久的 worker Session 与工作区目录。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'

const now = (): string => new Date().toISOString()
/** 返回工单对应的 worker Session ID（`worker-<ticketId>`）。 */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** 返回 worker Session ID（`worker-<ticketId>`）对应的工单 ID，非 worker Session 返回 undefined。 */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** 工作区 prepare 命令的最长运行时间。 */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** 启动或 worker 回合的瞬时失败最大重试次数，以及恢复回合之前的初始退避时长。 */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** worker 的回合结束之后，其后台工作在被停止、并把 worker 报告为 waiting 之前可以继续运行的时长。 */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** 宿主停止时等待各 worker 的后台工作停下的时长。 */
const SHUTDOWN_STOP_MS = 10_000
/** 因瞬时失败而继续的 worker 在两次检查之间等待 worker 槽位或处理恢复的时长。 */
const SLOT_WAIT_MS = 5000
/** 输入是否来自人（非上下文的人类触发，或状态请求等直接的文本输入）。 */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * 工单的工作区 prepare 命令在启动期间失败时抛出的内部错误。
 * DshExecutor 捕获它后立即把工单标记为 failed，而不是自动重试，因为已存在的目录即视为已准备好，自动重试会把失败的 prepare 命令遗留在目录中的任何内容当作已准备好的工作区。
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * 错误是否表示瞬时的网络或模型提供方失败：HTTP 408、429 或 5xx 状态，或
 * 连接被拒绝、被重置、超时，或无法解析主机名。
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** 给已校验的英文 worktree 名称追加稳定的 12 字符工单 ID 后缀。 */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** `DshExecutor` 所使用的宿主依赖。 */
export interface ExecutorHost {
  /** DSH Cordis 上下文：agent 及其事件，以及用于运行 prepare 命令的子进程服务。 */
  readonly context: Context
  /** 执行器向其上报派工与输入所发生情况的地方。 */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** 启动与输入投递所经过的持久效果队列。 */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** `worker` 健康条目，报告后台 worker 事件处理是否失败。 */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session 管理器，用于 worker Session 以及把 worker 报告转发给主 Session。 */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** 处理是否处于暂停，暂停会扣住启动与输入投递。 */
  paused(): boolean
  /** 工单的执行环境变量，传给其工作区 prepare 命令。 */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** `trigger` 所回复消息的已存储触发，当它确实回复了某条消息时。 */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** 在 Store 中查找工单的源头触发。 */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * 在请求之外为 worker 返回额外的系统提示授权指令：对依据规则被主动接受的工作
 * （`strength === 'inferred'`），把授权限制在规则范围内的小型内部改动；显式请求返回 `''`。
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** 构建新接受工单的执行元数据：其 worktree 名称、工作区目录与派工文本。 */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // 源头触发会随派工一起送达，因此 `assignment` 不含触发文本。
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** worker 消息中内联派工与触发文本的字符上限；更长的文本通过其资源读取。 */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** 返回截取到 `limit` 字符的 `text`，或带总字符数与完整文本资源路径的截断预览。 */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * 为投递给 worker 而格式化一个触发：作者、线程、时间戳、截取到 `TRIGGER_CHARS` 的文本、源消息链接、
 * 可选的路由说明，以及 worker 尚未看过时所回复消息的预览。
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** 格式化工单接受批次中的同批触发，含作者、时间戳、160 字符预览与读取资源路径。 */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** 返回工单源头批次中的其他触发（不含主 `origin.triggerId`），按从旧到新排序。 */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** 为 worker 格式化策略变更输入；在 `effect` 出现之前记录的输入回退为一般性通知。 */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** worker Session 读取工单输入完整文本的资源路径。 */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * 为投递给 worker 而格式化一条工单输入：`trigger` 经由 `trigger` 渲染（缺失时用其 ID 与读取路径）、
 * `policy-changed` 通知、`resumed` 通知、orchestrator 的 `note`，或原样的 `text` 输入。
 * 对旧式 `reopen` 输入返回 `undefined`，它们只是历史记录，因为 schema 11 迁移已把待处理的 reopen 输入转换为文本输入。
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // 标记经由仅上下文订阅到达的触发，让 worker 知道它们不是点名给该工单的。
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * 按所配置的并发上限跟踪活动与正在启动的 worker Session：worker 的回合运行期间、该回合结束后
 * 其 shell 作业或子代理运行期间，以及启动或唤醒正在开始该 worker 时，工单都持有一个槽位。
 * DshExecutor 在等待启动或唤醒工作之前同步预留槽位，使两次启动不可能同时抢走最后一个槽位，
 * 并为人的跟进（`by === 'person'`）允许超出上限一个额外槽位，使它们永远不必排在新启动之后。
 */
export class WorkerSlots {
  /** 当前持有启动槽位的工单，映射到该启动是 launch、wake，还是为人的消息而做的 wake。 */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - 返回其 worker 持有槽位的工单 ID（见 `DshExecutor.running`）。
   * @param max - 返回所配置的并发 worker 槽位最大数量。
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** 当前被运行中的 worker 与启动中预留所占用的槽位数量。 */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** 可以并发运行多少次启动：未被运行中的 worker 或唤醒预留占用的槽位。 */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * 为 `ticketId` 预留一个启动槽位；若 `ticketId` 已持有启动中的槽位则幂等。
   * 为人的消息所做的唤醒（`by === 'person'`）可以使用 `max()` 之外的一个额外槽位。
   * 在 worker 回合开始运行、或启动/唤醒尝试结束之后调用 `free(ticketId)`。
   * @throws 没有空闲槽位时抛出 Later。
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** 在 worker Session 开始运行、或启动/唤醒尝试结束之后释放 `ticketId` 的启动槽位。 */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * 在每个工单持久的 DSH worker Session 与隔离的工作区目录中执行工单派工。
 * 通过 Effects 把启动与输入投递排队，用 WorkerSlots 管理并发，在 Cordis 上下文上监听 `agent/status`、
 * `agent/inbox/claimed`、`session/event` 与 `agent/error` 事件，并把状态变化上报回引擎。
 * Runtime、引擎、worker 工具与管理路由使用本类来准备、启动、投递、停止与恢复工单派工。
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** 到目前为止的瞬时失败重试计数：worker 回合以 `assignment.id` 为键，启动以 `launch:<assignment.id>` 为键。 */
  private readonly transient = new Map<string, number>()
  /** 当前正等待瞬时失败退避计时器、以便恢复其 worker 回合的派工 ID。 */
  private readonly resuming = new Set<string>()
  /**
   * 对已空闲 worker 后台工作的检查，按工单索引，检查期间工单持有其槽位；worker
   * 再次运行或其派工结束时检查结束。
   */
  private readonly settling = new Map<string, AbortController>()
  /** 正在进行的工单后台工作停止操作，按工单索引；该工单的启动或投递要等待它完成。 */
  private readonly stopping = new Map<string, Promise<void>>()
  /** worker 交接时留给人的作业，按工单索引，及其结束的收集。 */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
/** 人的消息最近一次在 worker 的 Session 中开启回合的时间，按工单索引。 */
  private readonly personal = new Map<string, string>()
  /** 因瞬时失败而继续的 worker 的计时器，dispose 会清除它们。 */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
/** 注册 `launch` 与 `delivery` 效果处理器；处理暂停期间两者都被扣住（并发上限为 0）。 */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // 每次启动都会预留一个 worker 槽位，使启动在有槽位空闲时并发运行。
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // 失败的输入投递记录在工单本身上，而不是通过 `delivery` 效果的健康条目上报（`quiet: true`）。
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** 填充新接受工单的 `execution` 属性（worktree 名称、工作区目录与派工文本）。 */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * 在新工单工作区的父目录中、带着工单的执行环境变量运行所配置的 `executor.prepare` 命令，
   * 然后按 worker 所见的视角校验该目录。
   * 失败的 prepare 命令抛出 `PrepareFailed`，不会自动重试；它留下的空目录会被移除，非空目录保留。
   * @throws prepare 命令失败时带命令输出抛出 PrepareFailed。
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // 强制超时，使挂起的 prepare 命令（例如卡在凭据提示上）让工单失败，而不是无限期占用一个 worker 槽位。
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // 移除失败的 prepare 命令留下的空目录，使之后的重试不会把它当作已准备好。
        await rmdir(directory).catch(() => { /* 不存在，或装有命令写入的内容，输出中有说明。 */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** 为被接受或恢复的派工把 `launch` 效果排队；随着 worker 槽位空出，启动按队列顺序开始。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** 把 `delivery` 效果排队，把待投递的输入引导进 `ticket` 正在运行的 worker Session。 */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** 启动已排队的派工，除非其工单已结束、或期间有更新的派工取代了它。 */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // 关闭或暂停会把启动重新排队等待恢复，瞬时的网络/提供方错误则带退避重试。
      // 失败的 prepare 命令不会自动重试，因为已存在的目录即视为已准备好，重试
      // 会把失败的 prepare 命令遗留在目录中的任何内容当作已准备好的工作区；因此
      // 工单被标记为 failed，等待新的人类输入或显式重试的到来。
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * 把排队的输入逐条投递给运行中的派工，每次投递之前都重新读取工单状态，使工单已结束
   * 或被其他派工接管时投递立即停止。
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // worker 后台工作的停止以取消收尾，取消会丢弃投递期间送到的内容。
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // 唤醒空闲的 worker 会预留一个槽位（包括为人的跟进保留的额外槽位）。
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // 人的消息会先于新启动唤醒其 worker，使用为它保留的槽位。
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // 若 worker Session 被外部删除则重建它。
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // 在向 Session 投递之前再次检查，因为等待 `sourceLink` 期间工单可能已经结束。
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // 期间开始的 worker 后台工作停止会以取消收尾，取消会丢弃该输入。
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** 为 worker 格式化 `ticket` 上的一个触发，包括 worker 尚未看过时所回复消息的预览。 */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * 在结束事务提交之后执行（回滚会让 worker 继续工作，同一事务排队的启动也会在其后才开始）：
   * 结束对其后台工作的检查，除非其最后的话是一份 `ready` 或 `dropped` 报告、且此后没有输入送达，
   * 否则取消其回合，并停止其 shell 作业与子代理，包括它留给人的作业。
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // 其 shell 作业与子代理随之停止，自己结束回合的 worker 的作业与子代理也一样。
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** 停止工单的 worker 在后台运行的内容（见 `stopBackground`）。 */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox))
  }
  /** 工单后台工作的一次停止，运行期间该工单的启动或投递要等待它。 */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** 等待正在进行的工单后台工作停止，除非宿主先停止。 */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * 在宿主停止时，于有限的时长内：停止每个已加载 worker 的后台工作，保留其收件箱；然后结束
   * 对留给人的作业的收集（它们已被终止），并取消期间开始的 worker 回合，保留其收件箱。
   */
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent-cn stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** 其 worker 持有 worker 槽位的未结工单数量：回合在运行，或回合结束后其 shell 作业或子代理仍在运行。 */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** 工单的 worker 是否持有 worker 槽位：回合在运行，或回合结束后其 shell 作业或子代理仍在运行。 */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** 启动失败之后把工单标记为 failed；工单等待新的人类输入或显式重试的到来。 */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** 在一个事务中把 `failed` 报告记录到工单上，并把失败转发给主 Session。 */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent-cn is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // 只准备一次工作区目录；已存在的目录视为已准备好，包括在 `prepare` 命令机制出现之前创建的 worktree。
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // 被本次派工取代的那次派工的后台工作先停止，使其结束不会清掉本次派工的消息。
    await this.stopped(ticket.id)
    if (!current()) return
    // 为本次派工放回的消息可能仍在 Session 中等待——由重启的取消保留，或在崩溃后持久留存——
    // 此时本次启动的消息会与随后投递的副本一起被带入某一步骤：随后投递的副本才是唯一算数的。
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // 第一条消息承载派工与源头触发；之后派工的消息只说新出现的内容，除非
    // Session 丢失了第一条，例如有人删除了它。
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** 当 `agent` 是 worker Session 时返回其已存储的工单，否则返回 undefined。 */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** 为 worker Session 订阅宿主的 `agent/status`、`agent/inbox/claimed`、`session/event` 与 `agent/error` 事件。启动时调用一次。 */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // 回合开始即结束对其 worker 后台工作的检查；回合自身的空闲会重新检查一次。
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // 被子代理停止操作唤醒并取消的回合不是 worker 自己的回合。
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // 有人在 worker 的 Session 中输入的消息，工单不会记录它。
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // dsh-superagent-cn 的消息所携带的输入，其 worker 在 Session 把消息带入自身
    // 历史后即可读到：认领它的步骤此前可能被取消或失败，那会丢弃它。
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent-cn' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  /** 退订宿主的 agent 事件，并清除所有待处理的瞬时重试计时器。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * 在宿主重启之后对账各未结工单上运行中与 pending 的派工：把被打断的运行中派工
   * 通知引擎，并把 pending 的启动重新排队（更早版本可能把它们留在了效果队列之外），
   * 而失败的启动（`waitsForPerson`）则等待人的消息或一次重试。
   */
  resume(): void {
    // 按从旧到新（即接受顺序）启动 pending 的工单。
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // 本进程内的重启使 DSH 的 Session、作业与子代理仍在运行：先让它们停下。收件箱会保留
        // 已交接但尚未被接下的输入。
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent-cn restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** 运行后台 worker 事件处理，并在失败或恢复时更新 `worker` 健康条目。 */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * 检查 `error` 在 `key` 下是否为仍有剩余重试次数的瞬时失败，会修改 `this.transient`：
   * 要重试时递增尝试计数并返回 `true`；非瞬时失败或次数用尽时从 `this.transient` 删除 `key` 并返回 `false`。
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** 在瞬时的提供方或网络错误之后，以指数退避调度一次 worker 回合重试。 */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // 处理暂停期间或没有空闲唤醒槽位时等待。
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** 调度 `then` 在 `ms` 毫秒之后运行，除非在此之前调用了 `dispose()`。 */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * 交接给人的 worker 会释放其槽位：其子代理停止，而其 shell 作业——例如为
   * 人运行的服务——留给人，直到派工结束。它们不占用槽位，可以越过任何限制运行；其结束
   * 会被收集，因此不会有任何作业在槽位之外唤醒 worker，worker 会在下一回合逐一得知。
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // 因瞬时原因失败的回合会在退避之后继续，这不算回合结束。
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // 以正常方式结束的回合会把瞬时失败计数重新清零。
    this.transient.delete(idle.id)
    // 空闲派工运行期间的工单。
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // 最后的话是其结果、向人提出的问题、或 blocked/failed 报告的 worker 已交接给人；
    // 其结果或问题之后送达的输入是新工作。
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // 人在 Session 中开启的回合是那个人的工作，会像任何回合的工作一样在后台继续。
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // worker 已读过在其结束的回合之前到达的内容：交接所随的回合，或后台工作已结束的回合。
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // 一旦后台不再有为它运行的东西，其回合即结束，期间它持有自己的槽位：至多从这次空闲起
    // 持有到上限为止，并持续到 worker 再次运行或派工结束。
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // 越过上限仍在运行的 shell 作业会被终止，下一回合会告知 worker；其子代理若停止会
      // 唤醒它，因此继续运行。
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // worker 可能在其回合结束的同时作了报告；已被人的消息解除的 blocked 或 failed 报告已过时。
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // orchestrator_report 之后的安静收尾不是新状态，也不是空交接。
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
