/** orchestrator 与 worker DSH session 的生命周期、提示词/工具/技能装饰、消息投递，以及预算重试跟踪。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** `Sessions` 使用的宿主依赖。 */
export interface SessionsHost {
  /** DSH Cordis 上下文：session、agent、持久化及其事件。 */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** `models` 健康条目，用于上报正在等待模型预算重试的受管 session。 */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** 工单 `ticket` 的执行环境变量，会渲染进其 worker 的系统提示词。 */
  environment(ticket: Ticket): Variable[]
  /** 要注册到主 Session（`ticket === undefined`）或工单 `ticket` 的 worker Session 上的工具。 */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * Sessions 为其装饰的 agent 注册的内容：其提示词片段、工具与技能作用域的释放函数，其技能注册所在的作用域，
 * 以及某一提示词修订的技能；对 worker 的 subagent 而言，只有其工具限制。
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** Executor Session 与主 Session 创建时使用的 agent preset，由 bundle 的 patch 定义。 */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH 的 agent preset 注册表为某个 Session 选择了 `agentPreset`。 */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * Executor Session 可用的 DSH 工具：文件、搜索、shell 及其 job、web、技能、待办列表与 subagent。
 * 它不会获得该 profile 拥有的其他工具，无论何时注册：任何向真人提问或向真人展示内容的、修改 profile 的、
 * 安排工作或在 worker 槽位之外启动目标的、暂停与真人挂起的、启动或向其他 Session 发消息的，
 * 以及编辑文档的工具。
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** 主 Session 在将要等待时被告知的内容：它等待的东西会自己送达，而一个等待步骤会挡住下一步。 */
const NO_WAIT = '汇报、follow_up 通知、新候选，以及后台 job 的结束及其输出，都会自己以消息形式送达；'
  + '结束本回合，不要等待它们。'
/** `standard` 下的主 Session 在其命令将按 shell 默认值等待时被告知的内容。 */
const DEFAULT_WAIT = '该 shell 默认最多等待 60 秒：请传 timeoutMs（最多 30000），或使用 run_in_background，'
  + '因为等待中的步骤会挡住新候选。'
/** 命令位置上的 `sleep`：开头，; & | ( { ! ` 或换行之后，或某个关键字、某条执行它的命令之后。 */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * 主 Session 的护栏：拒绝执行 sleep 或要求把步骤拖到 30 秒以上的 bash 命令，以及超过 5 秒的 job 等待。
 * 在 `standard` 下（此时主 Session 创建于 router preset 运行之前），shell 默认把命令保持 60 秒、job 等待 30 秒，
 * 因此命令需要显式 timeout 或转后台，job 等待需要指定 timeout；
 * router preset 会把两者都在 5 秒后结束。
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * 用角色模型、来自 `Prompts` 的系统提示词片段、运行时技能与受限的工具集，创建并装饰 orchestrator 与 worker 的 DSH `Agent` session。
 * `Runtime`、`DshExecutor`、`MasterAssessor`、`Settings` 以及管理路由/工具通过它确保 session 就位、经 `AgentDelivery` 投递去重消息，并处理有序的 `relay` 与 `notice` effect。
 * 把 session 事件喂给 `RetryHealth`，以在 `models` `HealthEntry` 上报告模型预算等待；并在 `Store`（`KV.sessions.prompts`）中持久记录每个 session 工作过的提示词修订，用于授权提示词版本读取。
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** 已装饰的 agent，映射到其注册的 disposer 与技能作用域，直到该 agent 被销毁或 `Sessions.dispose()` 运行。 */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** 注册有序的 `relay` 与 `notice` effect 处理器，它们投递到主 Session。 */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // 按入队顺序把 relay 与 notice 投递到主 Session。
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** 订阅宿主的 agent 与 session 事件，使新建 session 得到装饰、模型预算重试能反映到健康状态。启动时调用一次。 */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // 在 DSH Web UI 中于首回合之前打开 Session 时，可能为它选中默认 preset：这里重新选回我们的；首回合之后
    // DSH 会拒绝任何选择，那样它就保持不变。
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** 在 workspace `cwd` 中解析或创建 session `id`，初始化其角色模型，用提示词/技能/工具装饰它，设置 `danger-full-access` 权限，并把它重命名为 `title`。 */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // Session 会保留创建时所用的 preset，即 bundle 自有的一个（cordis.patch.yml）。
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** 返回 `sessionId` 是否已持有以 `requestId` 投递的消息；session 不存在时返回 `false`。 */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** 每个 request id 只投递一次消息：投递到下一回合、当前回合，或以 `inject` 连同其标签注入而不唤醒 agent。 */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** `prompt` 以 `requestId` 投递的消息 id，DSH 的收件箱事件以此命名。 */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** 入队一条发往主 Session 的引导 relay；relay 是持久化的，`Effects` 会重试直到投递成功，每个 `requestId` 至多一次。 */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** 入队一条待注入主 Session 的持久后台通知；同一 `name` 的新通知会替换该 `name` 仍在等待的通知。 */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** 等待当前可运行的 `notice` effect 结算，并返回 `'injected'`（通知 `name` 已送达主 Session）或 `'pending'`（仍在排队）。 */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** 向主 Session 注入通知但不唤醒它；主 Session 尚不存在时为空操作。 */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // 按通知名与载荷哈希去重，使重试幂等，同时更新后的载荷仍会投递。
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** 返回当前提示词修订、每个已加载 Session 的活跃提示词修订，以及主 Session 是否仍有待处理的 `'prompts'` 通知。 */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** 返回 Session 所运行的提示词版本（其最近一次模型请求绑定的版本，或当前版本）。 */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Session 是否有权读取 `revision`（其活跃修订，或它此前运行过的任一修订）。 */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** 返回 `agent` 的工具注册器：把工具输出渲染为 JSON 文本，并在存在 `output.image` 时作为图片附加。 */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** 返回 `sessionId` 活跃的模型预算重试状态（`{ model_retry }`）供状态列表使用；未在等待时返回 `{}`。 */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}：${item.provider} 已超出模型预算；已重试 ${item.attempts} 次，自 ${item.since} 起等待；模型与重试策略均未改变`).join('; ') + (retries.length > 5 ? `; 另有 ${retries.length - 5} 个 Session` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: '没有托管 Session 在等待模型预算重试' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // 关闭变量插值，以保留团队提示词中字面的 ${{ ... }} 表达式。
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // 重新创建的技能作用域（例如技能服务重启后）初始为空，因此在重新绑定之前先重置 `binding.skills`。
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent 无法释放技能作用域：%s', String(error)) }) })
    await skillScope
    // 若 agent 在等待技能作用域期间已被销毁则退出。
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // Executor Session 保留它已经拥有的 profile 工作工具，DSH 要求这些工具必须已知；它自身的工具不会被遮蔽。
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Session 是否运行 router preset：以 DSH preset 注册表最近的选择为准（通过没有 `presetForSession` 的 DSH 上的 session
   * 投影读取），否则以创建时为准；无法读取时取 `standard`（更保守的上限）。
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * Executor Session 的工具：只有 profile 的工作工具（DSH 要求它们必须已知），工单结束后一个都不留。失败或受阻的
   * worker 保留其工具，使真人可在其 Session 中继续；只有自动化输入需要等待（见 executor）。经父作用域读取继承的工具，
   * 其中包含 preset 的工具。全局视图会漏掉 preset 工具；agent 自身视图还会包含 subagent 之类的本地工具，
   * 而 `restrict` 拒绝指名它们。
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? '工单已结束；新工作需要一个新建的授权工单' : undefined
    })]
  }
  /**
   * Executor Session 的 subagent（或其后代 subagent）在 DSH 的 `standard` preset 下以 worker 的权限运行，
   * 获得与 worker 相同的工作工具，worker 的工单结束后一个都不留。
   * 其他 agent 保持原样。
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // 沿 subagent 的父级上溯到 worker，这些父级在其 subagent 运行期间会被加载。
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** 在 agent 的技能作用域中注册某个提示词版本的技能，替换先前版本的。 */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || '自定义 dsh-superagent 运维技能。')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** 返回当前提示词版本；当绑定到模型请求时，更新 agent 的技能并在 `Store` 中记录该修订。 */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** 按相反顺序（LIFO）释放为 `agent` 注册的内容；销毁其技能作用域也会一并释放其技能。 */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent 无法释放为 Session 注册的内容：%s', String(error)) }
    }
  }
  /** 释放 `Sessions` 为所有已装饰 agent 注册的提示词片段、技能与工具。 */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
