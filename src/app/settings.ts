/** 按配置块校验设置、带乐观并发的保存、处理暂停控制，以及 Source 策略同步。 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { UserError, type EngineForSettings } from '../core/index.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema, policyEffects, policyVersion } from '../policy.ts'
import type { Settings as SettingsValue, SettingsBlock, SettingsOrigin, SettingsSave } from '../policy.ts'
import type { SourceHost } from '../sources/host.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { resolveRoleModel } from './role-models.ts'
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import { setupChanged, type Setup } from './setup.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

/**
 * 基于过期修订保存或同步某个设置块时表示乐观并发冲突。
 * 由 `Settings.save` 与 `Settings.sync` 抛出，并由管理路由转换为 HTTP 409 响应。
 */
export class SettingsConflict extends Error {}
const now = (): string => new Date().toISOString()
/** Executor 设置中控制 shell 执行路径、prepare 命令与命令 shim 的部分。 */
const environment = ({ executor }: SettingsValue) => JSON.stringify([executor.directory, executor.prepare, executor.blockedCommands])

/** 单一设置块类型的 schema 解析器、设置合并器，以及非面板来源的防护。 */
interface Block {
  parse(value: unknown, sources: SourceRegistry, id: string): unknown
  merge(settings: SettingsValue, value: unknown, id: string): SettingsValue
  guard?(current: SettingsValue, candidate: SettingsValue, origin: SettingsOrigin): void
}
const BLOCKS: Record<'policy' | 'eval' | 'executor' | 'source', Block> = {
  policy: {
    parse: (value, sources) => {
      const policy = PolicyConfigSchema.parse(value)
      return { ...policy, sources: sources.validatePolicy(policy.sources) }
    },
    merge: (settings, value) => ({ ...settings, policy: value as SettingsValue['policy'] }),
  },
  eval: { parse: value => EvalConfigSchema.parse(value), merge: (settings, value) => ({ ...settings, eval: value as SettingsValue['eval'] }) },
  executor: {
    parse: value => ExecutorConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, executor: value as SettingsValue['executor'] }),
    // 只有管理面板可以修改 shell 执行路径或命令。
    guard: (current, candidate, origin) => { if (origin !== 'panel' && environment(current) !== environment(candidate)) throw new UserError('panelOnlyEnvironment') },
  },
  source: {
    parse: (value, sources, id) => sources.validate(id, z.object({ enabled: z.boolean(), config: z.unknown() }).parse(value)),
    merge: (settings, value, id) => ({ ...settings, sources: { ...settings.sources, [id]: value as SettingsValue['sources'][string] } }),
    // 只有管理面板可以切换 Source 账号。
    guard: (current, candidate, origin) => { if (origin !== 'panel' && setupChanged(current, candidate)) throw new UserError('panelOnlyAccounts') },
  },
}

/** `Settings` 使用的宿主依赖。 */
export interface SettingsHost {
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'blockRevision' | 'atomic' | 'tickets' | 'get'>
  readonly sources: SourceRegistry
  /** 设置保存导致 Policy 版本变化时被通知。 */
  readonly engine: EngineForSettings
  /** 健康面板，各 Source 的策略同步以 `sync:<id>` 上报。 */
  readonly health: Pick<HealthBoard, 'claim'>
  /** 用于校验与解析角色模型的 DSH Cordis 上下文。 */
  readonly context: Context
  readonly lifetime: AbortSignal
  /** Session 管理器，主 Session 经它获知已保存的设置。 */
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  /** 传给 Source 类型的策略同步与标签刷新的 Source 宿主。 */
  readonly sourceHost: SourceHost
  /** setup 状态、账号与命令检查，以及 setup 相关字段变化时的重启触发。 */
  readonly setup: Pick<Setup, 'configured' | 'checkAccounts' | 'blockCommands' | 'restart'>
  /** 触发一次即时 pass，使设置保存后新获允许的工作立刻运行。 */
  requestPass(): void
}

/**
 * 在 `Store` 中校验并持久化按块的设置，执行来源防护，并管理 Source 策略同步与标签刷新。
 * `Runtime`、管理 HTTP 路由与主 Session 工具都通过它读取与保存设置。
 * Policy 版本变化时通知 `Engine`，通过 `Sessions` 通知主 Session，并在保存的设置生效时触发 `Setup` 重启或 `Passes` 运行。
 * 在 `HealthBoard` 中跟踪各 Source 的同步状态，并以指数退避重试失败的同步。
 */
export class Settings {
  /** 各 Source 的 `sync:<id>` 健康条目，在该 Source 首次策略同步时按需认领。 */
  private readonly syncs = new Map<string, HealthEntry>()
  /** 同步失败后每个 Source 待执行的重试定时器与上次等待时长（毫秒）。 */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()
  constructor(private readonly host: SettingsHost) {
    host.lifetime.addEventListener('abort', () => { for (const { timer } of this.retries.values()) clearTimeout(timer) }, { once: true })
  }
  /** 在 Source 同步失败后安排指数退避重试（1 分钟到 1 小时），成功则清除待重试项。 */
  private retrySync(id: string, failed: boolean): void {
    const previous = this.retries.get(id)
    if (previous) clearTimeout(previous.timer)
    this.retries.delete(id)
    if (!failed || this.host.lifetime.aborted) return
    const wait = previous ? Math.min(previous.wait * 2, 3_600_000) : 60_000
    const timer = setTimeout(() => { this.sync(id).catch(() => { /* sync() 会把失败记录到健康状态中。 */ }) }, wait)
    timer.unref?.()
    this.retries.set(id, { timer, wait })
  }
  private syncHealth(id: string): HealthEntry {
    let entry = this.syncs.get(id)
    if (!entry) this.syncs.set(id, entry = this.host.health.claim(`sync:${id}`))
    return entry
  }
  /** 返回 `Store` 中当前已校验的设置。 */
  current(): SettingsValue { return this.host.store.settings() }
  /**
   * 返回所有设置块及其当前块修订的概览：`pause`、`eval` 与 `executor` 给出完整值；`policy` 给出规则摘要与
   * 允许发送者数量；`sources` 给出实例状态开关（完整块读取使用 `read: 'settings/<block>'` 路径）。
   */
  view() {
    const { store, sources } = this.host
    const settings = store.settings(), revision = (block: SettingsSave) => store.blockRevision(block)
    const { rules, sources: parts } = settings.policy
    return { revision: store.get(KV.settings.revision) ?? 0,
      pause: { revision: revision('pause'), value: { paused: settings.paused } },
      eval: { revision: revision('eval'), value: settings.eval },
      executor: { revision: revision('executor'), value: settings.executor },
      policy: { revision: revision('policy'), rules: rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled })),
        allowed: Object.fromEntries(Object.entries(parts).map(([id, part]) => [id, part.allowed.length])), read: 'settings/policy' },
      sources: sources.instances(settings).map(({ id, kind, enabled, installed }) =>
        ({ id, kind, enabled, installed, revision: revision(`source:${id}`), read: `settings/source:${id}` })) }
  }
  /**
   * 返回 `save` 可接受的单个设置块（`policy`、`eval`、`executor`，`pause` 含 `{ paused }`，或 `source:<id>` 含 `{ enabled, config }`）
   * 及其当前块修订。
   * @throws UserError（`unknownBlock`）当该设置块不存在。
   */
  block(block: string): { block: string; revision: number; value: unknown } {
    const { store, sources } = this.host
    const settings = store.settings(), id = block.startsWith('source:') ? block.slice('source:'.length) : undefined
    const instance = id === undefined ? undefined : sources.instances(settings).find(item => item.id === id)
    const value = block === 'pause' ? { paused: settings.paused } : block === 'policy' || block === 'eval' || block === 'executor' ? settings[block]
      : instance ? { enabled: instance.enabled, config: instance.config } : undefined
    if (value === undefined) throw new UserError('unknownBlock', { block })
    return { block, revision: store.blockRevision(block as SettingsSave), value }
  }
  /**
   * 按 `revision` 校验并保存单个设置块；无变化的保存不记录新修订；Policy 版本变化会通知受影响的未结束工单；
   * 修改 setup 相关字段（`SETUP_FIELDS`，例如账号 CLI），或在等待 setup 期间保存任何变更（`!this.host.setup.configured()`），
   * 都会重启 `dsh-superagent` 以重新运行 setup。
   * @param origin - 调用方来源；把执行环境与账号 CLI 的修改限制在 `'panel'`（这是针对提示词注入式工具调用的护栏，而非操作系统安全边界，因为 agent 会执行 shell 命令；`origin` 没有默认值，因此任何调用方都不会隐式获得面板权限）。
   * @returns 保存结果，含该块的当前 `revision`、`policy_changed`、`restarting`，以及 `context_delivery` 状态（`'injected'` 或 `'pending'`）。
   * @throws SettingsConflict 当 `block` 的修订在校验检查之前或期间发生变更。
   * @throws UserError | z.ZodError 当 `block` 未知、Source 未安装、`value` 无效（例如 `executor` 块带了 `paused`，它只能由 `pause` 设置）、非面板 `origin` 修改了仅限面板的字段，或角色模型/账号检查失败。
   */
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin) {
    const { store, sources, engine, sessions } = this.host
    const stale = () => revision !== store.blockRevision(block)
    if (stale()) throw new SettingsConflict('设置已变更。请重新加载后再保存。')
    const id = block.startsWith('source:') ? block.slice(7) : block
    const kind = block.startsWith('source:') ? 'source' : block
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    const rules = BLOCKS[kind as keyof typeof BLOCKS]
    if (kind === 'source' && !sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
    const parsed = rules.parse(value, sources, id)
    const current = store.settings()
    const candidate = rules.merge(current, parsed, id)
    const model = block === 'eval' ? candidate.eval.model : block === 'executor' ? candidate.executor.model : null
    const previous = block === 'eval' ? current.eval.model : block === 'executor' ? current.executor.model : null
    if (model && JSON.stringify(model) !== JSON.stringify(previous)) {
      try { await resolveRoleModel(this.host.context, model) }
      catch (error) { throw new UserError('modelUnavailable', { block, error: error instanceof Error ? error.message : String(error) }) }
    }
    rules.guard?.(current, candidate, origin)
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    if (stale()) throw new SettingsConflict('设置在校验过程中发生了变化。请重新加载后再保存。')
    // 异步检查之后重新读取当前设置，以防无关的块被并发保存。
    const old = store.settings()
    const settings = rules.merge(old, parsed, id)
    if (JSON.stringify(SettingsSchema.parse(settings)) === JSON.stringify(old)) {
      const delivery = await sessions.delivery(`settings:${block}`)
      return { saved: true, revision: store.blockRevision(block), policy_changed: false, restarting: false, context_delivery: delivery }
    }
    const restarting = setupChanged(old, settings) || !this.host.setup.configured()
    const before = policyVersion(old), after = policyVersion(settings)
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, SettingsSchema.parse(settings), scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(SettingsSchema.parse(settings), { source: origin, block, policyVersion: after, policyChanged: before !== after, notified })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(old, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    // `blockedCommands` 变化时立即重写 worker 的命令 shim。
    const blocked = settings.executor.blockedCommands
    const changed = blocked.join(' ') !== old.executor.blockedCommands.join(' ')
    if (changed) await this.host.setup.blockCommands(blocked)
    // 需要重启时，通知保持待投递直到重启之后；`setup.restart()` 会推迟到本次调用返回。
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    return { saved: true, revision: store.blockRevision(block), policy_changed: before !== after, restarting, context_delivery: delivery }
  }
  /**
   * 暂停或恢复处理（新的评估、worker 派发与渠道投递；期间 Source 仍继续记录 Trigger），
   * 保存在独立的 `'pause'` 块中，使并发的 `executor` 编辑在其前后仍然有效。
   * @returns 处理当前是否已暂停（`{ paused }`）。
   */
  async pause(paused: boolean, origin: SettingsOrigin): Promise<{ paused: boolean }> {
    const { store, sessions } = this.host
    const old = store.settings()
    if (old.paused === paused) return { paused }
    store.atomic(() => {
      const record = { source: origin, block: 'pause' as const, policyVersion: policyVersion(old), policyChanged: false, notified: [] }
      store.saveSettings({ ...old, paused }, record)
      if (origin !== 'tool') sessions.notify(...settingsNotice('pause', ['paused']))
    })
    await sessions.delivery('settings:pause')
    this.host.requestPass()
    return { paused }
  }
  /** 返回当前可同步策略块（已安装且已启用）的 Source ID；setup 未配置时为空。 */
  syncable(): string[] {
    const { sources } = this.host
    if (!this.host.setup.configured()) return []
    return sources.instances().filter(instance => instance.installed && instance.enabled).flatMap(instance => {
      const sync = sources.kind(instance.id)?.policy?.sync
      const part = sources.policyPart(instance.id)
      return sync && part && sync.ready(part) ? [instance.id] : []
    })
  }
  /**
   * 从 Source `id` 的外部事实来源同步其策略块，发生变化时保存为 `'policy'` 修订，并把结果记录到
   * `sync:<id>` 健康条目（失败时经 `retrySync` 安排指数退避重试）。
   * @returns `id` 同步后的策略块。
   * @throws UserError（`nothingToSync`）当 `id` 当前无法同步；`SettingsConflict` 当 `'policy'` 块在同步期间发生变化；失败时抛出底层同步错误。
   */
  async sync(id: string) {
    const { store, sources } = this.host
    if (!this.syncable().includes(id)) throw new UserError('nothingToSync', { source: id })
    const health = this.syncHealth(id)
    try {
      const revision = store.blockRevision('policy')
      const part = await sources.kind(id)!.policy!.sync!.run(this.host.sourceHost, sources.policyPart(id)!, this.host.lifetime)
      if (revision !== store.blockRevision('policy')) throw new SettingsConflict('Policy 在同步期间发生了变化。请用当前设置重试。')
      const policy = store.settings().policy
      // 同步后的列表没有变化时不保存新修订。
      if (JSON.stringify(part) !== JSON.stringify(policy.sources[id])) {
        await this.save('policy', { ...policy, sources: { ...policy.sources, [id]: part } }, revision, 'sync')
      }
      health.set({ state: 'ready', detail: `已允许 ${part.allowed.length} 个`, at: now() })
      this.retrySync(id, false)
      return part
    } catch (error) {
      health.set({ state: 'error', detail: String(error), at: now() })
      this.retrySync(id, true)
      throw error
    }
  }
  /**
   * 立即重新读取某个 Source 的显示名（例如飞书会话名）。
   * @returns 本次读取之前存储的标签映射中没有的显示名，已排序（`{ added }`）。
   * @throws UserError（`noLabels`）当该 Source 不支持标签刷新；读取失败则重新抛出，并保留已存储的列表。
   */
  async refreshLabels(id: string): Promise<{ added: string[] }> {
    const { store, sources } = this.host
    const instance = sources.instance(id)
    const kind = instance && sources.kind(instance.kind)
    if (!kind?.refreshLabels) throw new UserError('noLabels')
    const before = store.get(KV.sources.labels(id)) ?? {}
    const after = await kind.refreshLabels(this.host.sourceHost)
    return { added: Object.entries(after).filter(([key]) => !(key in before)).map(([, name]) => name).sort((a, b) => a.localeCompare(b)) }
  }
}
