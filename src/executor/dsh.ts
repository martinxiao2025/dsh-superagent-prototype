/** DSH 执行器：为每个工单管理一个持久 worker 会话和一个工作区目录。 */
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
/** 返回工单对应的 worker 会话 ID（`worker-<ticketId>`）。 */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** 返回 worker 会话 ID（`worker-<ticketId>`）对应的工单 ID；非 worker 会话返回 undefined。 */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** 工作区 prepare 命令的最长运行时间。 */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** 一次启动或一个 worker 轮次的最大临时失败重试次数，以及恢复轮次前的初始退避时长。 */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** worker 的轮次结束后，其后台工作还能继续运行多久；超过该时长即停止这些工作，并把 worker 报告为等待中。 */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** 宿主停止时，等待各 worker 的后台工作停止的最长时间。 */
const SHUTDOWN_STOP_MS = 10_000
/** 可恢复失败后仍要继续的 worker，在两次查询之间等待 worker 槽位或等待处理恢复的时长。 */
const SLOT_WAIT_MS = 5000
/** 当输入来自人时为 true（非上下文的人为触发，或如状态查询这样的直接文本输入）。 */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * 工单的工作区 prepare 命令在启动期间失败时抛出的内部错误。
 * DshExecutor 捕获它后立即把工单标记为失败，而不是自动重试；因为已存在的目录会被视为已准备，自动重试会把失败的 prepare 命令在目录中留下的内容当作已准备好的工作区。
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * 当错误表示临时的网络或模型提供方失败时为 true：HTTP 408、429 或 5xx 状态，
 * 或连接被拒绝、被重置、超时，或无法解析主机。
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** 在校验通过的英文 worktree 名称后追加稳定的 12 字符工单 ID 后缀。 */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** `DshExecutor` 使用的宿主依赖。 */
export interface ExecutorHost {
  /** DSH Cordis 上下文：各 agent 及其事件，以及用于运行 prepare 命令的子进程服务。 */
  readonly context: Context
  /** Executor 向此处报告 Assignment 与 Input 上发生的事实。 */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** 持久 effect 队列，启动与输入投递都经由它执行。 */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** 名为 `worker` 的健康条目，用于报告后台 worker 事件处理是否失败。 */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** 会话管理器：管理 worker 会话，并把 worker 的报告转发到主 Session。 */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** 处理是否已暂停；暂停时会挂起启动与输入投递。 */
  paused(): boolean
  /** `ticket` 的执行环境变量，会传给它的工作区 prepare 命令。 */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** `trigger` 所回复消息在 Store 中保存的 Trigger；若它没有回复任何消息则为空。 */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** 在 Store 中查找工单的来源 trigger。 */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * 返回请求之外、给 worker 的附加系统提示词 mandate 指令：对于按规则主动接受的工作
 * （`strength === 'inferred'`），把授权限制为规则范围内的小型内部改动；显式请求返回 `''`。
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** 构建新接受工单的 Execution 元数据：worktree 名称、工作区目录与 assignment 文本。 */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // 来源 trigger 会与 assignment 一同投递，因此 `assignment` 中省略 trigger 文本。
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** worker 消息中内联 assignment 与 trigger 文本的字符上限；更长的文本通过其资源读取。 */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** 返回不超过 `limit` 个字符的 `text`；超长时返回截断预览，并给出总字符数和读取全文的资源路径。 */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * 把 Trigger 格式化为向 worker 投递的形式：作者、线程、时间戳、不超过 `TRIGGER_CHARS` 的文本、来源消息链接、
 * 可选的路由说明，以及 worker 尚未见过时被回复消息的预览。
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** 把工单接受批次中的同批 trigger 格式化：作者、时间戳、160 字符预览和读取资源路径。 */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** 返回工单来源批次中的其他 trigger（不含主 `origin.triggerId`），按时间从旧到新。 */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** 为 worker 格式化策略变更输入；在 `effect` 出现之前记录的输入退回为通用通知。 */
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
/** worker 会话读取工单输入全文所使用的资源路径。 */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * 把工单输入格式化为向 worker 投递的形式：经 `trigger` 渲染的 `trigger`（缺席时按其 ID 与读取路径）、
 * `policy-changed` 通知、`resumed` 通知、编排器 `note`，或原样输出的 `text` 输入。
 * 对遗留的 `reopen` 输入返回 `undefined`；它们只具历史意义，因为 schema 11 迁移已把待处理的 reopen 输入转成了 text 输入。
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // 标记通过仅上下文订阅到达的 trigger，让 worker 知道它们并非发给该工单。
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * 依据配置的并发上限跟踪活跃与正在启动的 worker 会话：工单在其 worker 轮次运行期间、轮次结束后其 shell 作业或
 * subagent 仍在运行期间，以及某次启动或唤醒正在启动该 worker 期间，占用一个槽位。
 * DshExecutor 在等待启动或唤醒工作之前同步预留槽位，因此两次启动不会同时抢到最后一个槽位；
 * 并允许人工跟进（`by === 'person'`）在超出上限时额外使用一个槽位，使它们不会排在新启动之后。
 */
export class WorkerSlots {
  /** 当前持有启动槽位的工单，值为该启动是 launch、wake，还是因人消息而 wake。 */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - 返回其 worker 持有槽位的工单 ID（见 `DshExecutor.running`）。
   * @param max - 返回配置的并发 worker 槽位上限。
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** 当前已使用的槽位数，含运行中的 worker 与启动预留。 */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** 可并发执行的启动数量：未被运行中的 worker 或唤醒预留占用的槽位。 */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * 为 `ticketId` 预留一个启动槽位；若 `ticketId` 已持有启动槽位则幂等。
   * 因人消息而唤醒（`by === 'person'`）可在 `max()` 之外额外使用一个槽位。
   * 在 worker 轮次开始运行或启动/唤醒尝试结束后调用 `free(ticketId)`。
   * @throws Later 当没有空闲槽位时。
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** 在其 worker 会话开始运行或启动/唤醒尝试结束后，释放 `ticketId` 的启动槽位。 */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * 在每工单持久的 DSH worker 会话与隔离的工作区目录中执行工单 assignment。
 * 通过 Effects 排队启动与输入投递，用 WorkerSlots 管理并发，监听 Cordis 上下文上的 `agent/status`、
 * `agent/inbox/claimed`、`session/event` 与 `agent/error` 事件，并把状态迁移报告回 Engine。
 * Runtime、Engine、worker 工具与管理路由使用本类来准备、启动、投递、停止与恢复工单 assignment。
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** 目前尝试过的临时失败次数：worker 轮次以 `assignment.id` 为键，启动以 `launch:<assignment.id>` 为键。 */
  private readonly transient = new Map<string, number>()
  /** 当前正在等待临时失败退避计时器、之后恢复其 worker 轮次的 Assignment ID。 */
  private readonly resuming = new Set<string>()
  /**
   * 对已空闲 worker 的后台工作进行观察，按工单分组，这些观察占用各自的槽位；当该 worker 再次运行
   * 或其 Assignment 结束时，观察结束。
   */
  private readonly settling = new Map<string, AbortController>()
  /** 正在执行的各工单后台工作停止操作，按工单分组；该工单的启动或投递会等待它们。 */
  private readonly stopping = new Map<string, Promise<void>>()
  /** worker 交接时留给人的作业，按工单分组，以及对其结束的收集。 */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** 按工单记录：输入到 worker Session 的人的消息最近一次启动轮次的时间。 */
  private readonly personal = new Map<string, string>()
  /** 可恢复失败后仍要继续的 worker 的计时器，由 dispose 清除。 */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** 注册 `launch` 与 `delivery` 两个 effect 处理器；处理暂停时二者都被挂起（并发上限为 0）。 */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // 每次启动都预留一个 worker 槽位，因此在有空闲槽位时启动可以并发执行。
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // 失败的输入投递记录在工单本身上，而不是通过 `delivery` effect 健康条目报告（`quiet: true`）。
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** 填充新接受工单的 `execution` 属性（worktree 名称、工作区目录与 assignment 文本）。 */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * 在父目录中为新工单工作区运行配置的 `executor.prepare` 命令，并带上该工单的执行环境变量，
   * 然后以 worker 所见的方式校验该目录。
   * prepare 命令失败会抛出 `PrepareFailed`，不会自动重试；它留下的空目录会被删除，非空目录则保留。
   * @throws PrepareFailed 当 prepare 命令失败时抛出，携带该命令的输出。
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // 强制超时，使卡住的 prepare 命令（例如卡在凭据提示处）让工单失败，而不是无限期占用 worker 槽位。
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // 删除失败的 prepare 命令留下的空目录，避免后续重试把它当作已准备。
        await rmdir(directory).catch(() => { /* 目录不存在，或其中含有该命令写入的内容，具体见命令输出。 */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** 为已接受或已恢复的 assignment 入队一个 `launch` effect；随着 worker 槽位释放，启动按队列顺序开始。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** 入队一个 `delivery` effect，把待处理输入送入 `ticket` 正在运行的 worker 会话。 */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** 启动已入队的 assignment；若其工单已结束或期间被更新的 assignment 取代，则不启动。 */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // 关闭或暂停会把启动重新入队以便恢复；临时的网络/提供方错误会带退避重试。
      // 失败的 prepare 命令不会自动重试，因为已存在的目录会被视为已准备，重试会把失败的 prepare 命令留在
      // 目录中的内容当作已准备好的工作区；因此改为把工单标记为失败，
      // 等新的用户输入或显式重试到来。
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * 把已入队的输入逐个投递给正在运行的 assignment；每次投递前重新读取工单状态，
   * 因此工单结束或被另一个 assignment 接管时投递会立即停止。
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // worker 后台工作的停止会以一次取消结束，这会丢掉期间投递的内容。
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
        // 唤醒空闲 worker 需要预留槽位（包括为人工跟进预留的额外槽位）。
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // 人的消息会让其 worker 排在新启动之前被唤醒，使用为它保留的槽位。
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // 若 worker 会话被外部删除，则重建它。
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
    // 在会话投递前再检查一次，因为等待 `sourceLink` 期间工单可能已结束。
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // 期间开始的 worker 后台工作停止会以一次取消结束，这会丢掉该 Input。
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** 为 worker 格式化 `ticket` 上的 trigger；若 worker 尚未见过被回复的消息，则包含其预览。 */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * 在结束事务提交之后（因此回滚会让 worker 继续工作，而同一事务入队的启动会在其后开始）：结束对其后台工作的观察，
   * 取消其轮次（除非它最后的话是一次 `ready` 或 `dropped` 报告，且此后没有投递过 Input），
   * 并停止它的 shell 作业与 subagent，包括它留给人的作业。
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
      // 它的 shell 作业与 subagent 会随之停止，自行结束轮次的 worker 也一样。
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** 停止工单 worker 在后台运行的内容（见 `stopBackground`）。 */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox))
  }
  /** 工单后台工作的一次停止；它运行期间，该工单的启动或投递会等待它。 */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** 等待正在执行的一次工单后台工作停止；若宿主先停止则不再等待。 */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * 宿主停止时，在有限时间内：停止每个已加载 worker 的后台工作并保留其收件箱；然后结束对留给人的作业的收集
   * （这些作业已被杀掉），并取消期间开始的 worker 轮次，同时保留其收件箱。
   */
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** worker 持有 worker 槽位的未结工单数：其轮次正在运行，或轮次结束后其 shell 作业或 subagent 仍在运行。 */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** 工单的 worker 是否持有 worker 槽位：其轮次正在运行，或轮次结束后其 shell 作业或 subagent 仍在运行。 */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** 启动失败后把工单标记为失败；工单会等待新的用户输入或显式重试到来。 */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** 在一个事务中把 `failed` 报告记录到工单，并把失败转发给主 Session。 */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // 工作区目录只准备一次；已存在的目录视为已准备，包括在 `prepare` 命令出现之前创建的 worktree。
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // 被本次替换的 Assignment 的后台工作会先停止，这样它的结束不会清掉本次的消息。
    await this.stopped(ticket.id)
    if (!current()) return
    // 为本 Assignment 放回的消息可能仍在 Session 中等待（由重启时的取消保留，或跨崩溃持久化）；
    // 此时本次启动的消息会让它进入一个与随后投递的副本并行的步骤，因此只保留那一份副本。
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // 第一条消息包含 assignment 与来源 Trigger；后续 Assignment 的消息只说明新增内容，
    // 除非该 Session 丢失了第一条消息（例如有人把它删除了）。
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
  /** 若 `agent` 是 worker 会话，返回其对应的已存工单；否则返回 undefined。 */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** 为 worker 会话订阅宿主的 `agent/status`、`agent/inbox/claimed`、`session/event` 与 `agent/error` 事件。启动时调用一次。 */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // 轮次开始会结束对其 worker 后台工作的观察；该轮次自身进入空闲时会重新观察。
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // worker 的 subagent 停止所唤醒并取消的轮次，不算该 worker 自己的轮次。
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // 输入到 worker Session 的人的消息，工单不记录它。
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // dsh-superagent 的消息所携带的 Input：一旦 Session 把该消息收入历史，其 worker 就会读取它们；
    // 在此之前认领该消息的步骤可能被取消或失败，从而丢弃它。
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
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
  /** 取消订阅宿主的 agent 事件，并清除所有待处理的临时重试计时器。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * 宿主重启后，在各未结工单上核对运行中与待处理的 assignment：向 Engine 通知被中断的运行中 assignment，
   * 并重新入队待处理的启动（较早版本可能把它们留在 effect 队列之外）；而失败的启动（`waitsForPerson`）
   * 会等待人的消息或一次重试。
   */
  resume(): void {
    // 按最旧的优先启动待处理工单（按接受顺序）。
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // 本进程内的重启会让 DSH 的 Session、作业与 subagent 继续运行：先停止它们。收件箱会保留
        // 已交出但尚未被取走的 Input。
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
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
   * 检查 `error` 是否为临时失败且 `key` 下仍有重试次数，并修改 `this.transient`：
   * 需要重试时递增尝试计数并返回 `true`；非临时失败或次数用尽时从 `this.transient` 删除 `key` 并返回 `false`。
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** 在临时的提供方或网络错误后，按指数退避安排一次 worker 轮次重试。 */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // 处理暂停或没有空闲唤醒槽位时继续等待。
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
  /** 安排 `then` 在 `ms` 毫秒后运行；若先调用了 `dispose()` 则不再运行。 */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * 已交接给人的 worker 会释放其槽位：它的 subagent 停止，而它的 shell 作业（例如为那个人运行的服务）留给那个人，
   * 直到该 Assignment 结束。这些作业不占用槽位，也不受任何上限限制；它们各自的结束会被收集，
   * 因此不会在槽位之外唤醒 worker，worker 会在下一次轮次读取到它们。
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
    // 因可恢复原因失败的轮次会在退避后继续，因此不算该轮次的结束。
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // 正常结束的轮次会让可恢复失败的计数重新开始。
    this.transient.delete(idle.id)
    // 当进入空闲的 Assignment 仍在运行该工单时，返回该工单。
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // 最后的话是结果、向人提出的问题，或被阻塞/失败的报告的 worker，已经交给人处理；
    // 在其结果或问题之后投递的 Input 属于新工作。
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // 人在 Session 中启动的轮次属于该人的工作，与其他轮次一样在后台继续。
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // worker 已读取在已结束轮次之前到达它的内容：它借以交接的轮次，或后台工作已结束的轮次。
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // 当它没有后台工作在运行时，其轮次才结束；在此期间它会占用槽位：最多到自本次空闲起的时限，
    // 并直到 worker 再次运行或该 Assignment 结束。
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
      // 超过时限仍在运行的 shell 作业会被杀掉，并在其下一次轮次告知它；而它的 subagent 会继续运行
      // （停止它们会唤醒它）。
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
    // worker 可能在其轮次结束期间已经报告；被人消息解除的 blocked 或 failed 报告已经过时。
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // orchestrator_report 之后的静默收尾不构成新状态，也不是空交接。
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
