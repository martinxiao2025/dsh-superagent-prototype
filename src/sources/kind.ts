/** SourceKind 插件契约：配置 schema、UI 表单字段、Policy 集成、channel 适配器与 thread 上下文读取器。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext, SourceHost } from './host.ts'

export interface Localized { zh: string; en: string }
/** `advanced` 把很少改动的字段（例如轮询可调参数）折叠到卡片的“高级”区域。 */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * 配置字段说明；`rows` 编辑以首列为键的记录列表，`choose` 从已解析的 source 标签中选择，
 * `fact` 显示来自 `facts` 的只读值。
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

export interface VariableSpec { key: string; description: Localized }
export interface EnvironmentInput<C> { deployment: Deployment; config: C; trigger?: Trigger }
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** source kind 的 Policy 扩展，定义允许的发送者、准入表的行，以及可选的外部名册同步。 */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** 校验 Source 在 Policy 中的部分，包括 `allowed`（可以发起工作的发送者）。 */
  schema: z.ZodType<P>
  /** policy 部分的表单字段；第一个是 `allowed`。 */
  fields: FieldSpec[]
  /** 描述 Source 把什么标记为发给 agent；允许的发送者的显式请求需要这一标记。 */
  explicit: Localized
  /** 当原始发送者 ID 不便阅读时，为未列出的真人或机器人发送者提供的回退显示标签。 */
  unnamed?: { person: Localized; bot: Localized }
  /** `config` 下 Policy 准入表的接收范围（对应 `scope().row`）；没有 `rows` 的 kind 使用该表的默认值。 */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** 可选的外部名册同步（例如群成员）；`ready` 报告 `part` 是否指明了要从中刷新数据的目标。 */
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
/** channel 地址对应的 UI 链接；`triggerId` 指明可用时优先使用其自身深链的 Trigger。 */
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
export type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>
/** source kind 各 thread 的出站消息适配器。 */
export interface SourceChannel<C> {
  /** 是否仍可向 `address` 回复；未提供该方法时，所有地址都可接收回复。 */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * 按 ID 幂等地发送消息；当目标会话不再接收回复时返回 `'gone'`。
   * @throws 当投递失败、但稍后重试仍可能成功时抛出。
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** 返回 `address` 的 URL 与标签；若 `links` 缺少所需的部署信息，`url` 为空。 */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** thread 上下文读取器返回的规范化消息；`bot` 标记非人发送者，其消息本身永不能授权工作（最多成为推断出的候选）。 */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** 有界的 thread 上下文读取器，供评估检查 trigger 附近的消息与图片。 */
export interface ThreadContext<C> {
  /** 该 Trigger 自身消息在其 Thread 消息中的 ID。 */
  messageId(trigger: Trigger): string
  /** 读取一页 thread 消息（`thread`；省略 `cursor` 时为第一页）、话题根（`root`），或被回复的消息（`parent`）。 */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** 从消息文本中提取 `image` 可读取的图片键；不支持图片的 kind 省略此方法。 */
  images?(text: string): string[]
  /** 读取 Trigger 所在 Thread 中某条消息的一张图片，作为 `agent` 的附件。 */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** @throws 对不支持图片的 kind 抛出。 */
  image(agent: Agent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** 注册到 SourceRegistry 的可插拔 source kind 描述。 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** 稳定 ID；未存储实例时存在一个同 ID 的默认实例。 */
  kind: string
  title: Localized
  description: Localized
  /** 由 `deployment` 派生的只读状态事实（等待 setup 期间为 undefined），以字段键为键。 */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>
  /** 校验已存储与提交的配置，并填充默认值。 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 该 kind 在 `health[...]` 下拥有的健康条目名；其他 kind 或核心循环不得报告它们。 */
  health: string[]
  /** 针对该 kind 的 trigger（或已记录的 Mandate 依据）的监听规则；没有 `scope` 的 kind 监听其产生的一切，但不观察其中任何内容。 */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** 出站回复适配器；没有 `channel` 的 kind 不产生回复，也不做 channel 检查。 */
  channel?: SourceChannel<C>
  /** 供评估使用的有界上下文读取器；没有 `threadContext` 的 kind 的评估不读取上下文。 */
  threadContext?: ThreadContext<C>
  /** 把搜索查询映射为候选 Thread 键（例如 `github:12`）与 Trigger 搜索词（例如飞书的 `om_` ID）。 */
  find?(query: string): { threads: string[]; terms: string[] }
  /** 在无需网络读取即可推导时，返回该 Trigger 所回复消息的 Trigger ID。 */
  repliesTo?(trigger: Trigger): string | undefined
  /** 为发送者具有自身身份的 kind 提供的 Policy 区段。 */
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** 为行键（例如群名称）重新读取显示名，把解析出的名称存入 `KV.sources.labels(kind)` 并返回它们。 */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  /** 该 kind 在执行环境中注册的变量，以及其取值的计算方式。 */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
