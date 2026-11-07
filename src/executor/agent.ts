/**
 * 通过 `AgentHost`（VS Code `vscode.lm` 扩展桥）执行工单 assignment 的宿主执行器。
 *
 * 这是 `DshExecutor` 的去 DSH 版本：不再创建 DSH Session、不依赖 agent 事件，一个回合就是
 * `dispatch` → `collect`。没有后台作业与 subagent，因此轮次结束即会话空闲；工具面由
 * `workspaceTools`（文件与命令）加上 Runtime 提供的编排工具组成，经回合工具回调执行。
 */
import { mkdir, readFile, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Tool } from '../app/tools/tool.ts'
import { latestAssignment, latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Executor, Ticket, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { type Effects, Later } from '../app/effects.ts'
import type { MainSession } from '../app/main-session.ts'
import type { Prompts } from '../app/prompts.ts'
import type { Store } from '../app/store.ts'
import type { TranscriptEntry } from '../app/context.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { HealthEntry } from '../infra/health.ts'
import { resultRelay } from '../app/notices.ts'
import type { AgentHost, TurnTool } from './host.ts'
import { runShell, toolJsonSchema, workspaceTools } from './workspace-tools.ts'
import { batchLine, batchOf, inputMessage, mandateInstructions, sourceTrigger, ticketExecution, transient, triggerMessage,
  workerSessionId } from './messages.ts'
import { KV } from '../kv.ts'
import { WorkerSlots } from './slots.ts'

/** 每个工单保留的对话记录条数；超出后丢弃最旧的。 */
const TRANSCRIPT_LIMIT = 200

/** prepare 命令的最长运行时间。 */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** 一次启动或一个回合的最大临时失败重试次数，以及恢复前的初始退避。 */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** 宿主停止时等待在途回合结束的最长时间。 */
const SHUTDOWN_TURN_MS = 10_000
/** worker 消息内联 assignment 文本的字符上限。 */
const ASSIGNMENT_CHARS = 1500
/** 回合内可调用的工具：与主 Session 共用的 `Tool` 原语。 */
type Callable = Tool
/** `HostExecutor` 的宿主依赖；只声明它真正用到的能力。 */
export interface HostExecutorHost {
  /** 回合宿主，例如 `VsCodeLmHost`；`start` 由执行器惰性调用。 */
  readonly host: AgentHost
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
    | 'report' | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit' | 'get' | 'set'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** 名为 `worker` 的健康条目。 */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** 只用于把 worker 的结果转给主 Session；不再创建 worker 会话。 */
  readonly sessions: Pick<MainSession, 'relay'>
  /** worker 的系统提示词与技能文本。 */
  readonly prompts: Pick<Prompts, 'current' | 'compose' | 'skills'>
  /** 配置的 worker 模型名；缺省时交给宿主选择。 */
  model?(): string | undefined
  /** 工单的编排工具面（`orchestrator_*`），由 Runtime 组装。 */
  toolkit(ticket: Ticket): Callable[]
  closing(): boolean
  paused(): boolean
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** 当前在途回合。 */
interface ActiveTurn {
  readonly assignmentId: string
  readonly controller: AbortController
}

/**
 * 用 `AgentHost` 执行 worker 回合的执行器。启动与投递都经持久 effect 队列，同一工单的回合
 * 串行执行；回合失败按「临时 / 永久」分流，临时失败按指数退避重试。
 */
export class HostExecutor implements Executor {
  private readonly slots: WorkerSlots
  private readonly transient = new Map<string, number>()
  private readonly resuming = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly turns = new Map<string, ActiveTurn>()
  /** 已发送过系统提示的会话；宿主重启后由回合结果里的 `fresh` 判定失效。 */
  private readonly instructed = new Set<string>()
  private readonly chains = new Map<string, Promise<void>>()
  private starting: Promise<void> | undefined
  /** 记录宿主并注册两个持久 effect 处理器。 */
  constructor(private readonly host: HostExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** 填充新接受工单的 `execution` 元数据；与 DSH 路径一致，因此切换宿主不改领域数据。 */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /** 入队一个 `launch` effect。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** 入队一个 `delivery` effect。 */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** 没有需要订阅的外部事件；回合由本类自己派发，该方法仅为满足 `Executor` 端口。 */
  install(): void {}
  /** 宿主重启后核对未结工单：运行中的 assignment 标记为中断，待启动的重新入队。 */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        this.turns.get(ticket.id)?.controller.abort()
        this.transient.delete(running.id)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      } else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** 取消所有在途回合并等待它们收尾；超时后不再等待。 */
  async shutdown(): Promise<void> {
    for (const turn of this.turns.values()) turn.controller.abort()
    const deadline = Date.now() + SHUTDOWN_TURN_MS
    while (this.turns.size > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  }
  /** 正在占用槽位的 worker 数。 */
  activeCount(): number { return this.slots.used() }
  /** `ticket` 是否有在途回合。 */
  running(ticket: Ticket): boolean { return this.turns.has(ticket.id) }
  /** 停止 `ticket` 的回合；最后一次结论是 `ready`/`dropped` 且此后没有投递时让它自然结束。 */
  stop(ticket: Ticket, assignment: Assignment, _reason: string): void {
    this.transient.delete(assignment.id)
    this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    if (ownTurn) return
    this.host.store.afterCommit(() => this.turns.get(ticket.id)?.controller.abort())
  }
  /** 清理定时器；调用方不再使用本执行器。 */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /** 启动已入队的 assignment；工单已结束或被取代时跳过。 */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try {
      await this.serialize(ticketId, () => this.launch(ticket, assignment))
      this.transient.delete(`launch:${assignmentId}`)
    } catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.failed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /** 确保宿主可用、必要时准备目录，然后发出第一轮。 */
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    await this.ready()
    const directory = ticket.execution?.directory ?? ''
    if (!await this.directoryReady(directory)) await this.prepareDirectory(ticket)
    if (!this.alive(ticket, assignment.id)) return
    await this.turn(ticket, assignment, await this.brief(ticket))
  }
  /** 逐个投递待处理输入；每次投递前重新读取工单，结束或换手即停止。 */
  private async deliverQueued(ticketId: string): Promise<void> {
    await this.ready()
    for (;;) {
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
      const inputId = ticket?.undelivered[0]
      if (!ticket || !assignment || inputId === undefined) return
      const input = ticket.inputs.find(item => item.id === inputId)
      let message: string | undefined
      try {
        message = input ? inputMessage(input, input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined) : undefined
      } catch (error) {
        if (this.host.closing() || error instanceof Later) throw error
        this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
        throw error
      }
      if (message !== undefined) {
        await this.serialize(ticketId, async () => {
          const current = this.host.store.tickets.get(ticketId)
          const target = current && liveTicket(current) ? runningAssignment(current) : undefined
          if (!current || !target || target.id !== assignment.id) throw new Later('工单已结束或被另一个 Assignment 接管')
          await this.turn(current, target, message!)
        })
      }
      this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      this.host.engine.inputsRead(ticketId, [inputId])
    }
  }
  /** 执行一个回合：组装工具与提示词，派发、回收，并把结局交给 `finished`。 */
  private async turn(ticket: Ticket, assignment: Assignment, message: string): Promise<void> {
    await this.ready()
    const sessionId = workerSessionId(ticket.id)
    const directory = ticket.execution?.directory ?? ''
    const controller = new AbortController()
    const signal = AbortSignal.any([this.host.lifetime, controller.signal])
    const instruction = this.instructed.has(sessionId) ? '' : await this.instruction(ticket, directory)
    if (assignment.state === 'pending') this.host.engine.assignmentStarted(ticket.id, assignment.id)
    this.turns.set(ticket.id, { assignmentId: assignment.id, controller })
    this.record(ticket.id, { type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: message }] } })
    try {
      const { tools, call } = this.toolset(ticket, directory)
      const handle = await this.host.host.dispatch({ sessionId, directory,
        prompt: instruction === '' ? message : `${instruction}\n\n---\n\n${message}`, tools, callTool: call,
        ...(this.host.model?.() ? { model: this.host.model!() } : {}) })
      const result = await this.host.host.collect(handle, { signal })
      this.instructed.add(sessionId)
      this.record(ticket.id, { type: 'assistant/message', message: { role: 'assistant',
        content: [{ type: 'text', text: result.error ? `[回合失败] ${result.error}` : result.text }] } })
      await this.finished(ticket.id, assignment.id, result)
    } finally {
      this.turns.delete(ticket.id)
      const health = this.host.host.health()
      this.host.health.set({ state: health.state === 'ready' ? 'ready' : 'error', detail: health.detail, at: new Date().toISOString() })
    }
  }
  /** 处理回合结局：临时失败重试、永久失败上报，正常结束则判定交接或汇报等待中。 */
  private async finished(ticketId: string, assignmentId: string, result: { text: string; error?: string }): Promise<void> {
    const live = () => {
      const stored = this.host.store.tickets.get(ticketId)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === assignmentId ? stored : undefined
    }
    if (!live() || this.host.closing()) return
    if (result.error) {
      if (this.retries(assignmentId, result.error)) { this.resumeAfter(ticketId, assignmentId, result.error); return }
      this.failed(ticketId, assignmentId, result.error)
      return
    }
    this.transient.delete(assignmentId)
    const current = live()
    if (!current) return
    const assignment = runningAssignment(current)
    const report = assignment?.report
    const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const handedOff = ((report?.state === 'ready' || !!current.attention) && !since) || waitsForPerson(current)
    if (handedOff) {
      this.host.engine.turnEnded(ticketId, assignmentId)
      return
    }
    const said = result.text.trim()
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticketId, { state: 'waiting', summary: said || before })
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) this.relay(resultRelay(updated, 'waiting', 'worker 结束时没有状态报告。请用 orchestrator_ticket_request_status 请求一次。'))
    })
  }
  /** 把永久失败写进 assignment。 */
  private failed(ticketId: string, assignmentId: string, error: unknown): void {
    this.host.store.afterCommit(() => this.host.engine.deliveryFailed(ticketId, assignmentId, String(error)))
  }
  /** 临时失败后按指数退避安排一次恢复轮次。 */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId) ?? 1
    const text = `你上一轮因可恢复原因失败（${String(error).slice(0, 200)}）。请从停止处继续该 Assignment。`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
      if (!ticket || !assignment || assignment.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      if (this.host.paused()) { this.after(5000, go); return }
      void this.serialize(ticketId, () => this.turn(ticket, assignment, text))
        .catch(failure => { this.failed(ticketId, assignmentId, failure) })
        .finally(() => this.resuming.delete(assignmentId))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** 记录一次临时失败；非临时或次数用尽时返回 false。 */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** 同一工单的回合串行执行：宿主的会话历史按 sessionId 累积，并发会互相干扰。 */
  private serialize(ticketId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(ticketId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.chains.set(ticketId, next.catch(() => undefined))
    return next
  }
  /** 安排 `then` 在 `ms` 毫秒后运行；`dispose()` 后不再运行。 */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /** 惰性启动宿主并检查它是否可用；不可用时抛出带原因的错误。 */
  private async ready(): Promise<void> {
    this.starting ??= this.host.host.start()
    await this.starting
    const health = this.host.host.health()
    if (health.state !== 'ready') throw new Error(`worker 宿主不可用：${health.detail}；请确认 VS Code 已打开且扩展已启用`)
    this.host.health.set({ state: 'ready', detail: health.detail, at: new Date().toISOString() })
  }
  /** 工单是否仍应继续：已结束或被另一个 assignment 取代则不应；待启动的 assignment 也算当前的一个。 */
  private alive(ticket: Ticket, assignmentId: string): boolean {
    const current = this.host.store.tickets.get(ticket.id)
    return !!current && liveTicket(current) && latestAssignment(current)?.id === assignmentId
  }
  /** 组装本回合的工具面：工作区工具 + 编排工具，并给出一个带校验的调用分派。 */
  private toolset(ticket: Ticket, directory: string): { tools: TurnTool[]; call: (call: { name: string; arguments: unknown },
    signal?: AbortSignal) => Promise<unknown> } {
    const all: Callable[] = [...workspaceTools({ directory }), ...this.host.toolkit(ticket)]
    const byName = new Map(all.map(item => [item.name, item]))
    const tools = all.map(item => ({ name: item.name, description: item.description, inputSchema: toolJsonSchema(item.schema) }))
    return {
      tools,
      call: async (call, signal) => {
        const item = byName.get(call.name)
        if (!item) throw new Error(`未知工具 ${call.name}；可用：${[...byName.keys()].join('、')}`)
        return item.execute(item.schema.parse(call.arguments), signal ?? new AbortController().signal)
      },
    }
  }
  /** 首次回合发给模型的系统提示：worker 提示词 + 技能文本 + 工作区的 AGENTS.md。 */
  private async instruction(ticket: Ticket, directory: string): Promise<string> {
    const { config } = this.host.prompts.current()
    const parts = [this.host.prompts.compose(config, 'worker', this.host.environment(ticket))]
    parts.push(...this.host.prompts.skills(config).map(([, text]) => text))
    const local = await this.agentInstructions(directory)
    if (local !== '') parts.push(local)
    return parts.filter(part => part.trim() !== '').join('\n\n')
  }
  /** 读取工作区根的 AGENTS.md；不存在时返回空串。 */
  private async agentInstructions(directory: string): Promise<string> {
    if (directory === '') return ''
    try {
      const text = await readFile(join(directory, 'AGENTS.md'), 'utf8')
      return `工作区约定（来自 worktree 里的 AGENTS.md，必须遵守）：\n\n${text.slice(0, 20_000)}`
    } catch { return '' }
  }
  /** 首轮消息：工单标识、assignment 文本、来源 trigger 与同批 trigger。 */
  private async brief(ticket: Ticket): Promise<string> {
    const trigger = sourceTrigger(this.host, ticket)
    const link = trigger ? await this.host.sourceLink(trigger) : {}
    const payload = {
      ticket_id: ticket.id,
      title: ticket.title,
      assignment: ticket.execution?.assignment ?? '',
      directives: mandateInstructions(ticket.mandate),
      ...(trigger ? { trigger: triggerMessage(trigger, link) } : {}),
      batch: batchOf(this.host, ticket).map(batchLine),
    }
    const text = JSON.stringify(payload, undefined, 2)
    return text.length <= ASSIGNMENT_CHARS ? text : JSON.stringify({ ...payload, assignment_trimmed: true, read: `ticket/${ticket.id}` })
  }
  /** 为 worker 格式化一条 trigger；worker 尚未见过被回复的消息时附上其预览。 */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /** 运行配置的 prepare 命令并校验目录；失败时删除空目录并抛出 `PrepareFailed`。 */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command !== '') {
      await runShell(command, dirname(directory), { timeoutMs: PREPARE_TIMEOUT_MS, env, signal })
        .then(result => {
          if (result.exit_code !== 0) throw new Error(`退出码 ${result.exit_code}：${result.stderr || result.stdout}`)
        })
        .catch(async (error: unknown) => {
          await rmdir(directory).catch(() => undefined)
          throw new PrepareFailed(`prepare 命令失败：${error instanceof Error ? error.message : String(error)}`)
        })
    }
    await mkdir(directory, { recursive: true })
    if (!await this.directoryReady(directory)) throw new PrepareFailed(`工作区目录不可用：${directory}`)
  }
  /** 目录是否存在且为目录。 */
  private async directoryReady(directory: string): Promise<boolean> {
    if (directory === '') return false
    try { return (await stat(directory)).isDirectory() } catch { return false }
  }
  /** 把 worker 的结果转给主 Session；没有主 Session 时是空操作。 */
  private relay(notice: { id: string; text: string } | undefined): void {
    if (notice) this.host.sessions.relay(notice.id, notice.text)
  }
  /** 追加一条工单对话记录，只保留最近 200 条，避免数据库无限增长。 */
  private record(ticketId: string, entry: TranscriptEntry): void {
    const store = this.host.store
    store.atomic(() => {
      const all = store.get(KV.transcript(ticketId)) ?? []
      store.set(KV.transcript(ticketId), [...all, entry].slice(-TRANSCRIPT_LIMIT))
    })
  }
}

/** prepare 命令失败；不自动重试，因为重试会把失败命令留下的内容当成已准备好的工作区。 */
export class PrepareFailed extends Error {
  /** 记录可读原因。 */
  constructor(message: string) { super(message); this.name = 'PrepareFailed' }
}
