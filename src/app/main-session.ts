/**
 * 主会话：在没有 DSH Agent 的情况下，用 `AgentHost`（VS Code `vscode.lm` 扩展桥）维持一段持续的对话。
 *
 * 行为对齐原 DSH 主 Session：
 * - 每条消息按 `requestId` 至多投递一次（去重记录持久化在 `Store`，崩溃重试不会重复唤醒模型）；
 * - 回合后台化：`prompt` 只把消息放进队列并立即返回，回合在每条会话的串行链里派发与回收，
 *   因此调用方（effect、HTTP、工具）不会被长回合阻塞；
 * - `inject` 通知不唤醒模型，而是累积到下一次回合的提示词前缀；
 * - 提示词由 `Prompts.compose` 与通知拼成一条完整文本，工具面由 `tools()` 提供并经开回合的 `callTool` 执行。
 */
import { key } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Logger } from '../infra/logger.ts'
import { KV } from '../kv.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'
import { toolJsonSchema } from '../executor/workspace-tools.ts'
import type { AgentHost, TurnResult } from '../executor/host.ts'

/** 去重记录保留的条数；超过后丢弃最旧的，避免无限增长。 */
const DELIVERED_LIMIT = 500
/** `prompt` 的投递方式：`queue`/`steer` 唤醒一个回合，`inject` 只在下一次回合前注入。 */
type Mode = 'queue' | 'steer' | { inject: string }

/** `MainSession` 的宿主依赖；都是 Runtime 已经持有的部件。 */
export interface MainSessionHost {
  readonly host: AgentHost
  readonly logger: Logger
  readonly store: Pick<Store, 'get' | 'set'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** `models` 健康条目：回合失败与恢复写在这里。 */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  /** 主会话的工作目录，通常是状态目录。 */
  directory(): string
  /** 主会话可用的工具，每次回合重新获取。 */
  tools(): Tool[]
  /** 配置的模型名；缺省时交给宿主选择。 */
  model?(): string | undefined
  closing(): boolean
  /** 可选：每回合结束后的观察者，用于落库转写。 */
  onTurn?(turn: { requestId: string; text: string; result: TurnResult }): void
}

/** 一条待注入主会话的通知；同一名称的新通知替换旧通知。 */
interface Notice { name: string; summary: string; text: string }

/**
 * 一段由 `AgentHost` 驱动的主会话。所有公开方法与原 `Sessions` 同名同义，便于 Runtime 与工具层直接替换。
 */
export class MainSession {
  private readonly queue: { requestId: string; text: string }[] = []
  private readonly notices = new Map<string, Notice>()
  private running = false
  private idleWaiters: (() => void)[] = []
  private readonly controller = new AbortController()

  /** 注册 `relay`（唤醒）与 `notice`（不唤醒）两个有序 effect 处理器。 */
  constructor(private readonly host: MainSessionHost) {
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }

  /** 兼容原 `Sessions.install()`；宿主没有需要订阅的 session 事件。 */
  install(): void {}

  /** 确保主会话就绪：启动宿主并刷新健康。没有 DSH session 需要创建。 */
  async ensure(_id: string, _cwd: string, _title: string, _role: 'orchestrator' | 'worker'): Promise<void> {
    await this.host.host.start()
    const health = this.host.host.health()
    this.host.health.set({ state: health.state === 'ready' ? 'ready' : health.state === 'error' ? 'error' : 'starting', detail: health.detail, at: health.at })
  }

  /**
   * 投递一条发往主会话的消息；每个 `requestId` 至多一次。`inject` 只缓存到下一次回合前，
   * 其余模式排队并立即返回，回合在后台串行执行。
   */
  async prompt(sessionId: string, requestId: string, text: string, mode: Mode, authorize?: () => void, accepted?: () => void): Promise<void> {
    if (sessionId !== this.host.masterId) throw new Error(`主会话只接受发往 ${this.host.masterId} 的消息；worker 回合由 HostExecutor 承担。`)
    const id = key(requestId)
    if (this.seen(id)) return
    authorize?.()
    if (typeof mode === 'object') {
      this.notices.set(`prompt:${id}`, { name: `prompt:${id}`, summary: mode.inject, text })
      this.remember(id)
      accepted?.()
      return
    }
    this.queue.push({ requestId: id, text })
    this.remember(id)
    accepted?.()
    void this.pump()
  }

  /** 入队一条唤醒主会话的 relay；持久化并由 `Effects` 重试到投递成功。 */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }

  /** 入队一条待注入的通知；同名通知替换仍等待的那条。 */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }

  /** 等待通知 effect 结算，并返回已注入还是仍在排队。 */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }

  /** 当前提示词修订、主会话的活跃修订，以及是否有待处理的 `prompts` 通知。 */
  status() {
    const { store, prompts, effects } = this.host
    const revision = store.get(KV.sessions.prompts(this.host.masterId))?.at(-1)
    return { revision: prompts.current().revision,
      sessions: revision === undefined ? [] : [{ sessionId: this.host.masterId, revision }],
      notificationPending: effects.pending('notice', 'prompts') }
  }

  /** 主会话运行的提示词版本。 */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }

  /** 主会话是否有权读取某个修订（当前修订或它运行过的任一修订）。 */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }

  /** 没有 DSH 模型事件可观察，等待预算重试的状态恒为空。 */
  modelRetry(_sessionId: string | undefined): Record<string, never> { return {} }

  /** 中止在途回合；之后不再接受新消息。 */
  dispose(): void { this.controller.abort() }

  /** 队列是否为空且没有在途回合。 */
  async idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return
    await new Promise<void>(resolve => { this.idleWaiters.push(resolve) })
  }

  /** 串行消费队列；一次只存在一个回合。 */
  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const next = this.queue.shift()
        if (!next) break
        if (this.host.closing() || this.controller.signal.aborted) break
        await this.turn(next)
      }
    } finally {
      this.running = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }

  /** 组装提示词、派发并回收一个回合；失败写入健康而不中断队列。 */
  private async turn(message: { requestId: string; text: string }): Promise<void> {
    const host = this.host
    const version = this.version()
    const body = [this.instruction(version), this.drain(), message.text].filter(part => part !== '').join('\n\n')
    const signal = AbortSignal.any([host.lifetime, this.controller.signal])
    try {
      await host.host.start()
      const tools = host.tools()
      const handle = await host.host.dispatch({ sessionId: host.masterId, directory: host.directory(), prompt: body,
        ...(host.model?.() ? { model: host.model()! } : {}), tools: tools.map(item => ({ name: item.name, description: item.description,
          inputSchema: toolJsonSchema(item.schema) })), callTool: (call, callSignal) => this.call(tools, call.name, call.arguments, callSignal ?? signal) })
      const result = await host.host.collect(handle, { signal })
      host.onTurn?.({ requestId: message.requestId, text: message.text, result })
      const health = host.host.health()
      host.health.set(result.error
        ? { state: 'error', detail: `主会话回合失败：${result.error}；检查 VS Code 模型可用性，或稍后重试。`, at: result.endedAt }
        : { state: health.state === 'ready' ? 'ready' : 'starting', detail: health.detail, at: health.at })
    } catch (error) {
      if (signal.aborted || host.closing()) return
      host.logger.warn('主会话回合失败：%s', String(error))
      host.health.set({ state: 'error', detail: `主会话回合失败：${String(error)}；检查扩展桥是否在运行，或稍后重试。`, at: new Date().toISOString() })
    }
  }

  /** 执行模型的一次工具调用；参数用 Zod 校验，失败以异常文本回给模型。 */
  private async call(tools: Tool[], name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const found = tools.find(item => item.name === name)
    if (!found) throw new Error(`未知工具 ${name}；可用工具：${tools.map(item => item.name).join('、')}`)
    return found.execute(found.schema.parse(input), signal)
  }

  /** 系统提示词前缀，并把本次回合绑定的修订记入 `Store`。 */
  private instruction(version: PromptVersion): string {
    const store = this.host.store
    const revisions = store.get(KV.sessions.prompts(this.host.masterId)) ?? []
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(this.host.masterId), [...revisions.filter(item => item !== version.revision), version.revision])
    return `[dsh-superagent prompt revision ${version.revision}]\n${this.host.prompts.compose(version.config, 'orchestrator')}`
  }

  /** 取出并清空待注入通知，形成回合前缀。 */
  private drain(): string {
    if (this.notices.size === 0) return ''
    const parts = [...this.notices.values()].map(item => `[${item.summary}] ${item.text}`)
    this.notices.clear()
    return `[未读通知]\n${parts.join('\n')}`
  }

  /** 当前提示词版本。 */
  private version(): PromptVersion { return this.host.prompts.current() }

  /** 记录一条待注入通知；同名通知替换旧通知，不唤醒模型。 */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    this.notices.set(name, { name, summary, text: JSON.stringify(value) })
  }

  /** `requestId` 是否已投递过（持久化去重）。 */
  private seen(id: string): boolean { return (this.host.store.get(KV.sessions.delivered(this.host.masterId)) ?? []).includes(id) }

  /** 记录一次投递，保留最近 `DELIVERED_LIMIT` 条。 */
  private remember(id: string): void {
    const store = this.host.store
    const delivered = store.get(KV.sessions.delivered(this.host.masterId)) ?? []
    store.set(KV.sessions.delivered(this.host.masterId), [...delivered.filter(item => item !== id), id].slice(-DELIVERED_LIMIT))
  }
}
