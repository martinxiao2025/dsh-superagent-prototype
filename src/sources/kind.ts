/** SourceKind 插件契约：配置 schema、UI 表单字段、策略集成、渠道适配器，以及线程上下文读取器。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext, SourceHost } from './host.ts'

export interface Localized { zh: string; en: string }
/** `advanced` 会把很少改动的字段（例如轮询调优项）折叠到卡片的“高级”分区中。 */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * 配置字段说明；`rows` 编辑以其第一列为主键的记录列表，`choose` 从已解析的来源标签中选取，
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
/** source kind 的策略扩展，定义允许的发送者、准入表行，以及可选的外部名单同步。 */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** 校验该 Source 在策略中的部分，包括 `allowed`（可以发起工作的发送者）。 */
  schema: z.ZodType<P>
  /** 策略部分的表单字段；第一个是 `allowed`。 */
  fields: FieldSpec[]
  /** 描述 Source 将什么标记为指向智能体；允许的发送者发出明确请求时需要满足这一点。 */
  explicit: Localized
  /** 当原始发送者 ID 不易阅读时，对名单之外的人类或 bot 发送者使用的回退展示标签。 */
  unnamed?: { person: Localized; bot: Localized }
  /** 在 `config` 下策略准入表的接收范围（与 `scope().row` 对应）；没有 `rows` 的 kind 使用准入表的默认值。 */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** 可选的外部名单同步（例如会话成员）；`ready` 报告 `part` 是否指名了用于刷新的目标。 */
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
/** 渠道地址的 UI 链接；`triggerId` 指名其自带深链接（可用时优先使用）的触发。 */
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
export type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>
/** source kind 线程的出站消息适配器。 */
export interface SourceChannel<C> {
  /** 回复是否仍可发往 `address`；未提供该方法时，任何地址都可以接收回复。 */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * 按 ID 幂等地发送消息；当目标会话不再接受回复时返回 `'gone'`。
   * @throws 当投递失败但稍后重试可能成功时。
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** 返回 `address` 的 URL 与标签；当 `links` 缺少所需的部署信息时 `url` 为空。 */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** 线程上下文读取器返回的规范化消息；`bot` 标记非人类发送者，其消息自身永远不能授权工作（至多是推断的候选）。 */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** 供研判使用的有界线程上下文读取器，用于查看触发周围的消息与图片。 */
export interface ThreadContext<C> {
  /** 触发自身消息在其 Thread 消息中的 ID。 */
  messageId(trigger: Trigger): string
  /** 读取线程消息的一页（`thread`，省略 `cursor` 时为第一页）、话题根消息（`root`）或被回复的消息（`parent`）。 */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** 从消息文本中提取 `image` 可读取的图片 key；不支持图片的 kind 省略此方法。 */
  images?(text: string): string[]
  /** 将触发 Thread 中某条消息的一张图片读取为 `agent` 的附件。 */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** 对不支持图片的 kind 抛出异常。 */
  image(agent: Agent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** 注册到 SourceRegistry 的可插拔 source kind 描述符。 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** 稳定的 ID；未存储任何 instance 时，存在同 ID 的默认 instance。 */
  kind: string
  title: Localized
  description: Localized
  /** 从 `deployment` 派生的只读状态事实（等待 setup 期间为 undefined），以字段键为索引。 */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>
  /** 校验已存储与已提交的配置并填充默认值。 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 该 kind 在 `health[...]` 下拥有的健康条目名；其他 kind 或核心循环不得报告它们。 */
  health: string[]
  /** 该 kind 的触发（或已记录的授权依据）的监听规则；没有 `scope` 的 kind 监听其产生的全部内容，但不观察任何内容。 */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** 出站回复适配器；没有 `channel` 的 kind 不产生回复或渠道检查。 */
  channel?: SourceChannel<C>
  /** 供研判使用的有界上下文读取器；没有 `threadContext` 的 kind 的研判不读取任何内容。 */
  threadContext?: ThreadContext<C>
  /** 将搜索查询映射为候选 Thread 键（例如 `github:12`）和触发搜索词（例如飞书的 `om_` ID）。 */
  find?(query: string): { threads: string[]; terms: string[] }
  /** 在无需网络读取即可推导时，返回该触发所回复消息对应的触发 ID。 */
  repliesTo?(trigger: Trigger): string | undefined
  /** 为发送者拥有自身身份的 kind 提供的策略部分。 */
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** 重新读取行键（例如会话名）的显示名称，把解析出的名称存入 `KV.sources.labels(kind)` 并返回。 */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  /** 该 kind 向执行环境注册的变量，以及这些变量值的计算方式。 */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
