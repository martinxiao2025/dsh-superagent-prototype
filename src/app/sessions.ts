/** orchestrator 与 worker DSH session 的生命周期、提示词/工具/技能装饰、消息投递与预算重试跟踪。 */
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
  /** DSH Cordis 上下文：session、代理、持久化及其事件。 */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** `models` 健康条目，上报正在等待模型预算重试的受管 session。 */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** `ticket` 的执行环境变量，渲染进其执行器的系统提示词。 */
  environment(ticket: Ticket): Variable[]
  /** 要注册到主 Session（`ticket === undefined`）或 `ticket` 的执行器 Session 上的工具。 */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * Sessions 为其装饰的代理注册的内容：其提示词段落、工具与技能 scope 的释放函数，技能注册所在的 scope，
 * 以及一个提示词修订的技能；对执行器的子代理，只有其工具限制。
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** 执行器 Session 与主 Session 创建时使用的代理预设，由 bundle 的补丁定义。 */
export const WORKER_PRESET = 'dsh-superagent-cn-worker', ROUTER_PRESET = 'dsh-superagent-cn-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH 的代理预设注册表为一个 Session 选择了 `agentPreset`。 */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * 执行器 Session 使用的 DSH 工具：文件、搜索、shell 及其作业、web、技能、todo 列表与子代理。
 * 无论如何注册，它都不会得到 profile 拥有的其他工具：凡是向人询问或展示内容、改变 profile、在执行器
 * 槽位之外安排工作或启动目标、暂停与人工保留、启动其他 Session 或向其发消息、或编辑文档的工具都没有。
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** 主 Session 想等待时被告知的内容：它等待的东西会自己送达，而等待中的步骤会挡住后续。 */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** 运行 `standard` 预设的主 Session 在其命令将按 shell 默认等待时被告知的内容。 */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** 处于命令位置的 `sleep`：在开头、`; & | ( { ! ` 或换行之后，或在会运行它的关键字或命令之后。 */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * 主 Session 的守卫：拒绝运行 sleep 的 bash 命令或要求把步骤保持超过 30 秒的命令，以及超过 5 秒的作业等待。
 * 在 `standard` 之下——即在 router 预设出现之前创建的主 Session 运行的配置——shell 默认把命令保持 60 秒、
 * 作业等待默认持续 30 秒，因此命令需要设置超时或转为后台，作业等待也需要其超时；router 预设把两者都在 5 秒后结束。
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
 * 创建并装饰 orchestrator 与 worker 的 DSH `Agent` session，为其配置角色模型、来自 `Prompts` 的系统提示词段落、运行时技能与受限的工具集。
 * `Runtime`、`DshExecutor`、`MasterAssessor`、`Settings` 和管理路由/工具用它确保 session、经 `AgentDelivery` 投递去重消息，并处理有序的 `relay` 与 `notice` effect。
 * 把 Session 事件喂给 `RetryHealth`，在 `models` `HealthEntry` 上报告模型预算等待，并把每个 session 运行用过的提示词修订持久记录在 `Store`（`KV.sessions.prompts`）中以授权提示词版本读取。
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** 已装饰的代理到其已注册释放函数与技能 scope 的映射，直到代理被销毁或 `Sessions.dispose()` 运行。 */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** 注册按序投递给主 Session 的 `relay` 与 `notice` effect 处理器。 */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // 按入队顺序把中继与通知投递给主 Session。
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** 订阅宿主的代理与 session 事件，使新建 session 得到装饰、模型预算重试反映到健康状态。启动时调用一次。 */
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
    // 在首轮之前于 DSH 的 Web UI 中打开 Session 可能为其选择默认预设：需再次选择我们的预设。
    // 首轮之后 DSH 拒绝任何选择，于是保持原样。
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
  /** 在工作区 `cwd` 中解析或创建 session `id`，初始化其角色模型，用提示词/技能/工具装饰它，设置 `danger-full-access` 权限，并把它重命名为 `title`。 */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // Session 保留创建时所用的预设，即 bundle 自带的预设之一（cordis.patch.yml）。
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
  /** 返回 `sessionId` 是否已持有在 `requestId` 下投递的消息；session 不存在时返回 false。 */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** 按请求 ID 至多投递一次消息：进入下一回合、当前回合，或带标签 `inject` 注入而不唤醒代理。 */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** `prompt` 在 `requestId` 下投递的消息 id，DSH 的收件箱事件以它称呼该消息。 */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** 为发往主 Session 的转向中继入队；中继是持久的，由 `Effects` 重试直到送达，每个 `requestId` 至多一次。 */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** 为注入主 Session 的持久后台通知入队；同名 `name` 的新通知会替换仍在等待的同名通知。 */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** 等待当前可运行的 `notice` effect 结算，若通知 `name` 已到达主 Session 则返回 `'injected'`，仍在排队则返回 `'pending'`。 */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** 向主 Session 注入通知而不唤醒它；主 Session 尚不存在时为空操作。 */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // 按通知名与负载哈希去重，使重试幂等，同时更新后的负载仍能送达。
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** 返回当前提示词修订、每个已加载 Session 的活跃提示词修订，以及主 Session 是否还有待处理的 `'prompts'` 通知。 */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** 返回 Session 当前运行的提示词版本（其最近一次模型请求绑定的版本，或当前版本）。 */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Session 是否被授权读取 `revision`（其活跃修订或它以前运行用过的任何修订）。 */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** 为 `agent` 返回一个工具注册器，把工具输出渲染为 JSON 文本，并在存在 `output.image` 时作为图片附加。 */
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
  /** 返回 `sessionId` 的活跃模型预算重试状态（`{ model_retry }`）供状态列表使用；未在等待时为 `{}`。 */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
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
    // 禁用变量插值，使团队提示词中的字面 ${{ ... }} 表达式得以保留。
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-cn-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent-cn prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // 重建的技能 scope（如技能服务重启后）从空开始，因此重新绑定前先重置 `binding.skills`。
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent-cn could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // 若在等待技能 scope 期间代理已被销毁，则直接返回。
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // 执行器 Session 保留它拥有的 profile 工作工具（DSH 要求它们是已知的）；其自有工具不被遮蔽。
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Session 是否运行 router 预设：若 DSH 的预设注册表没有 `presetForSession`，则经 session 投影读取注册表
   * 最后一次为它选择的预设，否则按其创建时的预设；读不到时取 `standard`（更保守的上限）。
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
   * 执行器 Session 的工具：只有 profile 的工作工具（DSH 要求它们是已知的），且工单结束后一个也没有。
   * 失败或阻塞的执行器保留其工具，人可以在其 Session 中继续；只有自动输入会等待（见执行器）。
   * 经父 scope 读取继承的工具，其中包含预设的工具。全局视图会漏掉预设工具；
   * 代理自己的视图还包含 subagent 之类的本地工具，而 restrict 拒绝指名它们。
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * 执行器 Session 的子代理，或其子代理的子代理：它们运行在 DSH 的 `standard` 预设下、持有执行器的权限，
   * 获得与执行器相同的工作工具，且执行器工单结束后一个也没有。其他代理保持原样。
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // 把子代理的父级向上追溯到执行器（worker），它们在其子代理运行期间是已加载的。
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** 在代理的技能 scope 中注册一个提示词版本的技能，替换较早版本的。 */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent-cn operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** 返回当前提示词版本；绑定到模型请求时更新代理的技能并把修订记录进 Store。 */
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
  /** 以逆序（LIFO）释放为 `agent` 注册的内容；销毁其技能 scope 时也释放其技能。 */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent-cn could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** 释放 `Sessions` 在所有已装饰代理上注册的提示词段落、技能与工具。 */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
