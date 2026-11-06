/** 主 Session 的主动候选评估：中继候选卡片、提供有界上下文读取，并记录结果。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { reasonText, threadKey, type Assessor, type AssessmentOutcome, type Candidate, type EngineForMainSession,
  type Trigger } from '../core/index.ts'
import { AdmissionDirectionSchema, RuleAssessmentSchema, assessmentOutcome, directionAllowed, type Settings } from '../policy.ts'
import { checkedImText } from '../infra/text.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import { admissionContext } from '../sources/admission-context.ts'
import { readRepositoryPath } from '../sources/github-read.ts'
import type { TriggerContext } from '../sources/kind.ts'
import { relatedTickets } from './cards.ts'
import { textPage } from './context.ts'
import { AcknowledgementSchema } from './tools/tool.ts'
import type { Effects } from './effects.ts'

/** 短小写 kebab-case 英文工单 worktree 名称的 schema（1–4 个词，最多 32 个字符）。 */
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters').describe('Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** 主 Session 主动候选评估决策（`orchestrator_eval_decide`）的 schema。 */
export const AssessmentSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema)
    .refine(assessments => new Set(assessments.map(assessment => assessment.rule_id)).size === assessments.length,
      'Duplicate rule assessment IDs').describe('One per enabled rule.'),
  direction: AdmissionDirectionSchema.describe('Required for every decision.'),
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  intent_evidence: z.string().trim().min(1).max(700).nullish().describe('For acceptance: the quotes that establish the three facts.'),
  acknowledgement: AcknowledgementSchema.nullish().describe('For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence.'),
  reason: z.string().min(1).max(500),
}).strict().refine(value => value.decision !== 'accept' || !directionAllowed(value.direction) || !value.rule_assessments.some(rule => rule.matched)
  || !!value.worktree_name, { message: 'Accepted work requires a short English worktree_name', path: ['worktree_name'] })

/** 初始 thread 窗口的字符上限：分别用于 trigger 本身、其最近的两条邻居、窗口内其他消息与 stub 预览。 */
const TRIGGER_CHARS = 4000, NEAR_CHARS = 1200, WINDOW_CHARS = 400, STUB_CHARS = 50
const FINISHED = 'This assessment has finished: it was decided, timed out or restarted'
const EXPLICIT = 'This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
type AssessmentContext = Awaited<ReturnType<typeof admissionContext>>
type ReadCache = {
  snapshots: Map<string, string>; images: Map<string, { id: string; text: string }>; messages: Map<string, string>; cursors: Set<string>
}
/** Eval 运行期间保留的每次评估状态：已提供的读取缓存、已加载的 thread 上下文（或错误），以及正在进行的初始加载。 */
interface EvalReads { cache: ReadCache; context?: AssessmentContext; error?: string; loading?: Promise<void> }
/** 评估某个 Source 不提供 thread 上下文的 Trigger 时返回的消息。 */
const NO_CONTEXT = 'This Source gives no Thread context; assess the Trigger\'s own text and the batch.'
/** `MasterAssessor` 使用的宿主依赖。 */
export interface AssessorHost {
  /** `Engine` 中评估器会读取并作出决策的活跃评估。 */
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide'>
  readonly commands: Commands
  readonly deployment: Deployment
  /** 投递候选评估所用的持久 effect 队列。 */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  settings(): Settings
  /** 处理是否已暂停；暂停会暂缓候选投递。 */
  paused(): boolean
  /** `trigger` 所属 Source 的 thread 上下文读取器；该 Source 没有时返回 `undefined`。 */
  threadContext(trigger: Trigger): TriggerContext | undefined
  /** 每个 request ID 只向主 Session 投递一次候选卡片，在 Session 收到之后才解析。 */
  deliver(requestId: string, text: string): Promise<void>
  candidateCard(candidate: Candidate): Promise<Record<string, unknown>>
}

/** 活跃评估期间有界上下文或仓库读取请求（`orchestrator_eval_read`）的 schema。 */
export const EvalReadSchema = z.object({
  trigger_id: z.string().min(1).describe('Original candidate ID returned by orchestrator_eval; every reference is scoped to this trigger.'),
  resource: z.enum(['message', 'root', 'parent', 'thread', 'file', 'directory', 'image']),
  path: z.string().optional().describe('Repository-relative path, only for file/directory.'),
  message_id: z.string().optional().describe('Only for message: omit for the trigger, or the id of a window message or stub.'),
  cursor: z.string().optional().describe('Only for thread: omit on the first page, then the next_cursor of the window or the cursor of next_read. Never a thread or message ID.'),
  image_id: z.string().optional().describe('Only for image: an image id the window or a read lists.'),
  offset: z.number().int().min(0).default(0).describe('Text pagination: copy next_offset; keep the other arguments unchanged. Images use 0.'),
}).strict().superRefine((read, ctx) => {
  if ((read.resource === 'file' || read.resource === 'directory') !== (read.path !== undefined)) ctx.addIssue({ code: 'custom', message: 'path is required only for file/directory. To read the source/root/parent, use resource=message/root/parent without a path.' })
  if (read.message_id !== undefined && read.resource !== 'message') ctx.addIssue({ code: 'custom', message: 'message_id is only for message; use returned image_id for images.' })
  if (read.cursor !== undefined && read.resource !== 'thread') ctx.addIssue({ code: 'custom', message: 'cursor is only for thread. First page: {resource:"thread"}.' })
  if ((read.resource === 'image') !== (read.image_id !== undefined)) ctx.addIssue({ code: 'custom', message: 'Images require image_id from a returned read reference. Read the thread or root first to discover their images.' })
})
/** `MasterAssessor.read` 校验后的参数。 */
export type EvalRead = z.infer<typeof EvalReadSchema>

/**
 * 为主 Session 中的主动候选评估实现 `Engine` 的 `Assessor` 端口。
 * 通过持久化的 `assessment` effect 把每次评估的候选卡片中继给主 Session，在评估运行期间提供有界的 `TriggerContext` 与仓库读取，并把主 Session 的评估转换为供 `Engine.decide` 使用的 `AssessmentOutcome`。
 * 依赖 `SourceRegistry`（经 `AssessorHost`）获取 Source 专属的 thread 上下文，依赖 `Sessions` 做去重的候选投递；主 Session 的 `orchestrator_eval*` 工具会调用 `context`、`read` 与 `decide`。
 */
export class MasterAssessor implements Assessor {
  /** 每次评估的读取缓存与 thread 上下文，以 `evalId` 为键。 */
  private readonly evals = new Map<string, EvalReads>()
  private readonly controller = new AbortController()
  /** 注册中继每个 Eval 候选卡片的处理器；链接查找可能让它延迟数秒。 */
  constructor(private readonly host: AssessorHost) {
    // 只有在主 Session 收到候选卡片之后才开始评估计时，使繁忙的 Session 不会占用评估时间。
    host.effects.handle('assessment', async ({ triggerId }, evalId) => {
      const candidate = this.host.engine.candidate(triggerId)
      if (candidate?.evalId !== evalId) return
      await this.host.deliver(`candidate:${evalId}`, JSON.stringify({ kind: 'candidate', ...await this.host.candidateCard(candidate) }))
      this.host.engine.candidateDelivered(evalId)
    }, { limit: () => host.paused() ? 0 : 4 })
  }
  /** 入队一个 `assessment` effect，把 `candidate` 的卡片投递给主 Session。 */
  request(candidate: Candidate): void { this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }
  /** `evalId` 是否仍是 `trigger` 的活跃评估。 */
  private live(evalId: string, trigger: Trigger): boolean { return this.host.engine.candidate(trigger.id)?.evalId === evalId }
  /** 评估结束后丢弃其上下文与读取；该 Eval 上正在进行的加载会丢弃结果。 */
  release(evalId: string): void { this.evals.delete(evalId) }
  /** 解析 trigger 的活跃评估；历史 trigger 没有，而明确请求会改为路由。 */
  private evalFor(triggerId: string): { candidate: Candidate; trigger: Trigger } {
    const candidate = this.host.engine.candidate(triggerId)
    if (!candidate) throw new Error('No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment')
    if (candidate.strength === 'explicit') throw new Error(EXPLICIT)
    const trigger = candidate.triggers.find(item => item.id === triggerId)!
    return { candidate, trigger }
  }
  /** 返回或初始化 `evalId` 的读取缓存，并预置 trigger 自身的消息与图片引用；若 `evalId` 已结束则抛错。 */
  private reads(evalId: string, trigger: Trigger): EvalReads {
    let reads = this.evals.get(evalId)
    if (!reads) {
      // 评估结束后拒绝读取，使已完成的评估不再保留缓存状态。
      if (!this.live(evalId, trigger)) throw new Error(FINISHED)
      const context = this.host.threadContext(trigger)
      const messages = new Map([[context?.messageId ?? '', trigger.text]])
      reads = { cache: { snapshots: new Map(), images: new Map(), messages, cursors: new Set() } }
      this.evals.set(evalId, reads)
      this.imageReferences(context, trigger, trigger.text, context?.messageId ?? '', reads.cache)
    }
    return reads
  }
  private imageReferences(context: TriggerContext | undefined, trigger: Trigger, text: string, messageId: string, cache: ReadCache) {
    return (context?.images(text) ?? []).map(imageKey => {
      const imageId = `${messageId}/${imageKey}`
      cache.images.set(imageId, { id: messageId, text })
      return { message_id: messageId, image_key: imageKey, read: { trigger_id: trigger.id, resource: 'image', image_id: imageId } }
    })
  }
  /** 每次评估只加载并缓存一次初始的有界 thread 窗口（宿主重启后也会重新加载）。 */
  private async seed(evalId: string, trigger: Trigger, caller?: AbortSignal): Promise<void> {
    caller?.throwIfAborted()
    const reads = this.reads(evalId, trigger)
    if (reads.context || reads.error !== undefined) return
    const thread = this.host.threadContext(trigger)
    if (!thread) { reads.error = NO_CONTEXT; return }
    let loading = reads.loading
    if (!loading) {
      // 防止异步上下文加载期间发生并发完成或替换。
      const current = () => this.evals.get(evalId)?.loading === loading
      // 推迟启动，直到下面给 `reads.loading` 赋值，使 `current()` 从第一步起就成立。
      loading = Promise.resolve().then(async () => {
        try {
          const timeout = AbortSignal.timeout(this.host.deployment.admissionContextTimeoutMs.get())
          const signal = AbortSignal.any([this.controller.signal, ...(caller ? [caller] : []), timeout])
          const commands = this.host.commands.withSignal(signal)
          const context = await admissionContext(thread, commands, this.host.deployment.admissionContextMaxPages.get())
          if (!current()) return
          reads.context = context
          // 允许分页从初始窗口的末尾继续。
          if (context.next) reads.cache.cursors.add(context.next)
          for (const message of context.messages) if (!message.deleted) {
            reads.cache.messages.set(message.id, message.text)
            this.imageReferences(thread, trigger, message.text, message.id, reads.cache)
          }
        } catch (error) {
          caller?.throwIfAborted()
          if (current()) reads.error = `Thread context unavailable: ${String(error).slice(0, 300)}. Use orchestrator_eval_read before deciding based on missing context.`
        }
      }).finally(() => { if (current()) delete reads.loading })
      reads.loading = loading
    }
    await loading
    caller?.throwIfAborted()
    if (!this.live(evalId, trigger)) throw new Error(FINISHED)
  }
  /**
   * 返回 `orchestrator_eval` 的载荷：trigger 的文本（只出现一次，上限 `TRIGGER_CHARS`）、同批的其他 trigger、
   * thread 上的相关工单、其 Eval 构建时所用的 Policy 版本，以及初始 thread 窗口（前五条消息与 trigger 两侧各五条，
   * 对最近的两条邻居分别截断到 `WINDOW_CHARS` 或 `NEAR_CHARS`，并给出总长度与图片 ID；其余已加载消息以
   * `STUB_CHARS` 预览呈现；`orchestrator_eval_read` 可按 ID 读取任意消息的全文）。
   * 评估指令位于主 Session 的提示词（`prompts/admission.md`）中，
   * 而不在此载荷里。
   */
  async context(triggerId: string, signal?: AbortSignal) {
    const { candidate, trigger } = this.evalFor(triggerId)
    await this.seed(candidate.evalId, trigger, signal)
    const { context, error } = this.evals.get(candidate.evalId) ?? {}
    const source = this.host.threadContext(trigger)
    const images = (text: string) => source?.images(text) ?? []
    const imageIds = (id: string, text: string) => { const keys = images(text); return keys.length
      ? { images: keys.map(key => `${id}/${key}`) } : {} }
    const cut = (text: string, limit: number) => text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length }
    const thread = context ? (() => {
      const shown = new Map(context.window.entries.map(entry => [entry.message.id, entry]))
      const at = context.messages.findIndex(message => message.id === source?.messageId)
      const messages = context.messages.map((message, index) => {
        const author = { id: message.id, from: message.from, ...message.bot ? { bot: true } : {} }
        if (message.deleted) return { ...author, deleted: true }
        if (!shown.has(message.id)) return { ...author, preview: message.text.replace(/\s+/g, ' ').slice(0, STUB_CHARS) }
        // trigger 自身的文本已在顶层包含一次。
        if (index === at) return { ...author, at: message.at, trigger: true }
        const near = at >= 0 && Math.abs(index - at) <= 2
        return { ...author, at: message.at, ...cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS), ...imageIds(message.id, message.text) }
      })
      return { complete: context.complete, loaded_messages: context.messages.length, source_found: context.window.source_found,
        ...context.next ? { next_cursor: context.next } : {}, messages }
    })() : { error: error ?? 'Call orchestrator_eval to load initial context', complete: false }
    const settings = this.host.settings()
    const others = candidate.triggers.filter(item => item.id !== trigger.id)
    return { trigger_id: trigger.id, strength: candidate.strength, mode: settings.eval.mode,
      source: { kind: trigger.source, actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), ...(trigger.url
        ? { url: trigger.url } : {}) },
      ...cut(trigger.text, TRIGGER_CHARS), ...imageIds(source?.messageId ?? '', trigger.text),
      ...others.length ? { batch: others.map(item => {
        const text = cut(item.text, WINDOW_CHARS)
        return { trigger_id: item.id, actor: item.actor.id, at: item.at, ...text, ...'chars' in text ? { read: `trigger/${item.id}` } : {} }
      }) } : {},
      // 规则位于主 Session 的 Policy 片段中，其中指明该候选的 Eval 构建时所依据的版本。
      ...relatedTickets(candidate.tickets), policy_version: candidate.policyVersion,
      thread }
  }
  /**
   * 为 `orchestrator_eval_read` 提供来自评估 thread 上下文或仓库的分页有界文本或图片附件；
   * `agent` 是主 Session（以附件形式接收图片），MCP 调用方则没有。
   */
  async read(agent: Agent | undefined, read: EvalRead, signal: AbortSignal) {
      const { candidate, trigger } = this.evalFor(read.trigger_id)
      await this.seed(candidate.evalId, trigger, signal)
      const { cache } = this.reads(candidate.evalId, trigger)
      const { snapshots, images, messages, cursors } = cache
      const commands = this.host.commands.withSignal(AbortSignal.any([this.controller.signal, signal]))
      if (read.resource === 'image') {
        if (!agent) throw new Error('Reading an image needs the DSH main Session. Read the thread text here, or open the thread in DSH and read the image there.')
        if (read.offset !== 0) throw new Error('Images are not paginated; use offset 0')
        const image = images.get(read.image_id!)
        if (!image) throw new Error('Unknown image reference. Read the source/root/thread for this trigger first and copy its image read arguments.')
        const source = this.host.threadContext(trigger)
        if (!source) throw new Error(NO_CONTEXT)
        const key = read.image_id!.slice(read.image_id!.indexOf('/') + 1)
        return source.image(agent, commands, image, key, this.host.deployment.stateDir, signal)
      }
      const cacheKey = JSON.stringify([read.resource, read.path, read.cursor, read.message_id])
      if (read.offset > 0) {
        const cached = snapshots.get(cacheKey)
        if (cached === undefined) throw new Error('Read this resource at offset 0 first')
        return textPage(read.resource, cached, read.offset, 4000)
      }
      let body: string
      const source = this.host.threadContext(trigger)
      if (read.resource === 'message') {
        const message = messages.get(read.message_id ?? source?.messageId ?? '')
        if (message === undefined) throw new Error('Unknown message reference. Use resource=root/parent or read the thread first; copy a returned message read call.')
        body = message
      }
      else if (read.resource === 'thread' || read.resource === 'root' || read.resource === 'parent') {
        if (!source) throw new Error(NO_CONTEXT)
        if (read.cursor !== undefined && !cursors.has(read.cursor)) throw new Error('Unknown thread cursor. First call {resource:"thread"}; then copy the returned next_read exactly.')
        const result = await source.read(commands, read.resource, read.cursor)
        const references = result.messages.filter(message => !message.deleted).flatMap(message => {
          messages.set(message.id, message.text)
          return this.imageReferences(source, trigger, message.text, message.id, cache)
        })
        if (result.next) cursors.add(result.next)
        const next = result.next ? { trigger_id: trigger.id, resource: 'thread', cursor: result.next } : null
        body = JSON.stringify({ images: references, next_read: next, ...result.body })
      }
      else {
        body = await readRepositoryPath(commands, read.path!, read.resource === 'directory' ? 'directory' : 'file')
      }
      snapshots.set(cacheKey, body)
      return textPage(read.resource, body, read.offset, 4000)
  }
  /** 在当前设置下把评估转换为结果，并交给 `Engine.decide` 做策略校验。 */
  async decide(triggerId: string, result: z.infer<typeof AssessmentSchema>, signal?: AbortSignal): Promise<{ state: string; ticket_id?: string; reason: string }> {
    const { candidate } = this.evalFor(triggerId)
    signal?.throwIfAborted()
    let outcome: AssessmentOutcome = assessmentOutcome(result, this.host.settings(), candidate.strength)
    if (outcome.kind === 'accept' && outcome.acknowledgement) outcome = { ...outcome, acknowledgement: checkedImText(outcome.acknowledgement) }
    const decision = this.host.engine.decide(triggerId, { ...outcome, evalId: candidate.evalId })
    return { state: decision.kind, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), reason: reasonText(decision.reason) }
  }
  /** 运行时停止时中止所有进行中的 thread 上下文或仓库读取命令。 */
  stop(): void { this.controller.abort() }
}
