/** dsh-superagent 的应用组装根与生命周期管理器。 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import type { Logger } from '../infra/logger.ts'
import type { SubprocessRuntime } from '../infra/subprocess.ts'
import type { AgentHost } from '../executor/host.ts'
import { HostExecutor } from '../executor/agent.ts'
import { sourceTrigger, workerSessionId } from '../executor/messages.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { handleHttp, type HttpHost } from './http.ts'
import { PanelServer } from './panel.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { McpEndpoint } from './mcp.ts'
import { mcpTools } from './mcp-tools.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuKind, feishuSettings, startFeishu } from '../sources/feishu.ts'
import { githubKind, startGithub } from '../sources/github.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { MainSession } from './main-session.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ModelCatalogView, ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import type { Tool } from './tools/tool.ts'
import type { TranscriptEntry } from './context.ts'

const now = (): string => new Date().toISOString()

/** `Runtime` 的宿主依赖：普通对象，由 `src/index.ts` 组装并注入。 */
export interface RuntimeHost {
  readonly machine: Machine
  readonly logger: Logger
  readonly subprocess: SubprocessRuntime
  /** 模型回合宿主，例如 `VsCodeLmHost`。 */
  readonly host: AgentHost
  /** 配置变更后重建编排器；由入口实现（进程内重启）。 */
  restart(): void
}

/**
 * dsh-superagent 的组装根，连接 `Store`、`Setup`、`Engine`、`SourceRegistry`、`Effects`、`Outbox`、`Passes`、
 * `MainSession`、`Settings`、`Prompts`、`HostExecutor` 与 `MasterAssessor`。
 * 对外暴露 `SourceHost` 能力供 Source 插件使用，并协调启动、setup 检查、面板 HTTP 服务与优雅关闭。
 * 在打开 SQLite 之前锁定状态目录，使并发进程无法破坏状态或重复迁移。
 */
export class Runtime implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: MainSession
  readonly settings: Settings
  readonly executor: HostExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly mcpHealth = this.board.claim('mcp', { state: 'starting', detail: '' })
  private readonly panelHealth = this.board.claim('panel', { state: 'starting', detail: '' })
  private mcp?: McpEndpoint
  private panel?: PanelServer
  /** setup 之前注册的 Source kind 的注销函数；进程停止时释放它们的健康条目。 */
  private readonly sourceReleases: (() => void)[] = []
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** 主 Session 工具正在执行 Engine 命令期间为非零值，用于抑制自触发的领域事件通知。 */
  private quiet = 0
  /** 机器级配置；面板与健康条目在启动日志里读取它。 */
  readonly machine: Machine
  constructor(readonly host: RuntimeHost) {
    const runtime = this
    const { machine, logger, subprocess } = host
    this.machine = machine
    // 在打开数据库之前锁定状态目录，使另一个进程无法并发迁移或写入。
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ logger, subprocess, machine, lifetime: this.lifetime, restart: host.restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // 当 Source 插件动态加载时，在启动完成后同步一次 Source 成员列表。
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() 会把失败记录到健康状态中。 */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link,
        models: async () => this.modelCatalog(), transcript: async (id: string): Promise<TranscriptEntry[]> => store.get(KV.transcript(id)) ?? [] }
      const sessions = this.sessions = new MainSession({ host: host.host, logger, store, prompts, effects, health: board.claim('models'),
        masterId, lifetime: this.lifetime, directory: () => machine.stateDir, closing: () => this.closing(),
        tools: () => mainTools(this.toolHost, { id: masterId }), model: () => store.settings().eval.model?.model })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new HostExecutor({ host: host.host, get engine() { return runtime.engine }, store, effects, prompts,
        health: board.claim('worker'), machine, lifetime: this.lifetime, sessions, closing: () => this.closing(),
        paused: () => this.paused(), environment, sourceLink: link, repliedTo: trigger => repliedTo({ store, sources }, trigger),
        model: () => store.settings().executor.model?.model, toolkit: ticket => executorTools(this.toolHost, ticket) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // 只通知主 Session 那些不是它自己发起的领域事件。
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // 送达未结束工单的真人消息归该工单所有，主 Session 在同一事务中听到它；对已结束工单，则在它复活的
          // 时候听到，除非该消息本就是主 Session 自己路由过去的。
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // 工单因拉取请求而结束时，通知该工单的各会话。
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // 若最近一小时内有过不可用的评估，则在每次 pass 时更新 `evals` 健康条目。
      const evals = board.claim('evals', { state: 'ready', detail: '最近一小时没有不可用的 Eval' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { logger, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // 初始化失败时释放数据库与状态锁，使进程内重启能重新获取它们。
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** MCP 端点实际监听的端口；已停止、已禁用或绑定失败时为 undefined。 */
  get mcpPort(): number | undefined { return this.mcp?.port }
  /** 面板实际监听的端口；启动失败时为 undefined。 */
  get panelPort(): number | undefined { return this.panel?.port }
  /** dsh-superagent 停止或失去状态目录锁时中止，用于取消进行中的读取与子进程。 */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** 已解析的部署；等待 setup 时读取会抛错（`!configured()`）。 */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** 飞书 Source 虽配置了 CLI，飞书机器人仍不可用的原因。 */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  /** 某个会话当前可用的工具面：主会话（缺省）或某个工单的 worker。 */
  tools(ticket?: Ticket): Tool[] { return ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, { id: this.masterId }) }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** 处理暂停或等待 setup 期间暂缓评估、派发与外发投递；Source 仍继续记录传入的 trigger。 */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  /** 设置中配置的模型名；独立版本没有模型注册表，只回显已配置的 provider 与模型。 */
  private modelCatalog(): ModelCatalogView {
    const settings = this.store.settings()
    const groups = new Map<string, ModelCatalogView['groups'][number]>()
    for (const model of [settings.eval.model, settings.executor.model]) {
      if (!model) continue
      const id = model.provider.trim()
      const group = groups.get(id) ?? { id, name: id, models: [] }
      const name = model.model.trim()
      if (name !== '' && !group.models.some(item => item.id === name)) group.models.push({ id: name, name })
      groups.set(id, group)
    }
    const all = [...groups.values()]
    const fallback = settings.executor.model ?? settings.eval.model
    return { default: fallback ? { provider: fallback.provider, model: fallback.model,
      ...fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {} } : null, failures: [], groups: all }
  }
  private async initialize(): Promise<void> {
    // 在 setup 完成之前启动面板，使运维者能在 UI 中修复 setup 问题。
    await this.startPanel()
    if (!await this.setup.run(this.store.settings())) {
      // 等待 setup 时也要注册 Source kind，否则面板无法列出 `source:github` 与 `source:feishu` 设置块，
      // 管理员就无处填写仓库、CLI 与机器人配置（保存会被判成「Source 不存在」）；轮询仍等 setup 通过后才启动。
      if (!this.sources.kind('feishu')) this.sourceReleases.push(this.sources.register(feishuKind))
      if (!this.sources.kind('github')) this.sourceReleases.push(this.sources.register(githubKind))
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    // Source 插件在本进程内启动，生命周期与 Runtime 同步。
    void startFeishu(this, this.lifetime)
    void startGithub(this, this.lifetime)
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    await this.startMcp()
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() 会把失败记录到健康状态中。 */ })
    // 若在等待 setup、创建 session 或同步策略期间已调用 stop()，则不再启动后台循环。
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: '编排器已就绪', at: now() })
  }
  /** 启动回环面板；端口占用只写为健康错误，绝不阻塞编排器。 */
  private async startPanel(): Promise<void> {
    const server = new PanelServer({ host: this.machine.host, port: this.machine.panelPort,
      handle: (req, res) => this.handle(req, res),
      log: (message, error) => { this.host.logger.warn('%s: %s', message, String(error)) } })
    try {
      await server.start()
      if (this.closing()) { await server.stop(); return }
      this.panel = server
      this.panelHealth.set({ state: 'ready', detail: `面板：http://${this.machine.host}:${server.port}`, at: now() })
    } catch (error) {
      this.panelHealth.set({ state: 'error', at: now(),
        detail: `面板无法监听 ${this.machine.host}:${this.machine.panelPort}：${error instanceof Error ? error.message : String(error)}` })
    }
  }
  /** 启动回环 MCP 端点。端口占用只写为健康错误，绝不阻塞编排器。 */
  private async startMcp(): Promise<void> {
    if (!this.machine.mcpEnabled) {
      this.mcpHealth.set({ state: 'paused', detail: 'MCP 端点已关闭（mcpEnabled 为 false）', at: now() })
      return
    }
    const endpoint = new McpEndpoint({ port: this.machine.mcpPort, health: this.mcpHealth,
      tools: mcpTools(this.toolHost, this.masterId), log: (message, error) => { this.host.logger.warn('%s: %s', message, String(error)) } })
    try {
      await endpoint.start()
      // start() 等待 listen 期间可能已执行 stop()；绝不要留下监听器。
      if (this.closing()) { await endpoint.stop(); return }
      this.mcp = endpoint
    } catch (error) {
      this.mcpHealth.set({ state: 'error', at: now(),
        detail: `MCP 端点无法监听 127.0.0.1:${this.machine.mcpPort}：${error instanceof Error ? error.message : String(error)}` })
    }
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: async () => runtime.modelCatalog() }
  }
  /** 面板请求入口；由 `PanelServer` 在回环端口上调用。 */
  async handle(req: Parameters<typeof handleHttp>[1], res: Parameters<typeof handleHttp>[2]): Promise<void> {
    await handleHttp(this.httpHost(), req, res, this.panel?.port ?? this.machine.panelPort)
  }
  /** 幂等停止；并发或重复调用共享同一个关闭 promise。 */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      await this.mcp?.stop()
      this.mcp = undefined
      await this.panel?.stop()
      this.panel = undefined
      this.assessor.stop()
      // 先释放 setup 之前注册的 Source kind，避免健康条目在关闭后仍被占用。
      for (const release of this.sourceReleases.splice(0)) release()
      // worker 回合与主会话回合都在宿主里跑：先等在途回合收尾，再停宿主。
      await Promise.allSettled([passes, this.effects.drain(), this.executor.shutdown()])
      this.executor.dispose()
      this.sessions.dispose()
      await this.host.host.stop()
    } finally {
      // 释放目录锁之前先关闭数据库，使其他进程无法在写入中途打开它；被抢占的锁可能已经释放。
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.host.logger.warn('dsh-superagent 无法释放状态目录锁：%s', String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
