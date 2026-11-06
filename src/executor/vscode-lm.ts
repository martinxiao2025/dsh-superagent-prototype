/** 通过 VS Code 扩展桥调用 `vscode.lm` 的宿主实现。Runtime 不直接依赖 VS Code。 */
import { randomUUID } from 'node:crypto'
import type { AgentHost, HostHealth, TurnHandle, TurnRequest, TurnResult } from './host.ts'
import { BridgeClient, BridgeError, bridgeFilePath, readBridgeInfo, type BridgeErrorKind, type BridgeInfo, type BridgeTurn } from './bridge.ts'
import { ToolServer } from './tool-server.ts'
/** `VsCodeLmHost` 的选项。 */
export interface VsCodeLmHostOptions {
  /** 发现文件路径；默认与扩展相同的规则。 */
  readonly file?: string
  /** 期望的模型 id；缺省用扩展选中的模型。 */
  readonly model?: string
  /** 单个回合的超时，默认 30 分钟。 */
  readonly timeoutMs?: number
  /** 轮询间隔，默认 200 毫秒。 */
  readonly pollMs?: number
  /** 等待发现文件出现的上限，默认 5 秒。 */
  readonly discoverMs?: number
  /** 诊断日志。 */
  readonly log?: (message: string, error?: unknown) => void
  /** 单次工具调用的超时，默认 120 秒。 */
  readonly toolTimeoutMs?: number
  /** 回传模型的工具结果上限，默认 60000 字符。 */
  readonly toolMaxChars?: number
}
/** 每个回执对应的桥侧回合。`toolKey` 存在时表示该回合注册过工具回调。 */
interface Turn {
  readonly turnId: string
  readonly client: BridgeClient
  readonly toolKey?: string
}
/**
 * 通过扩展桥驱动模型回合。桥不可用、未授权、无可用模型与模型侧失败分别映射为
 * 不同的错误分类，调用方不需要解析文案就能区分。
 */
export class VsCodeLmHost implements AgentHost {
  private state: HostHealth = { state: 'idle', detail: '尚未启动', at: new Date().toISOString() }
  private client: BridgeClient | undefined
  private readonly turns = new Map<TurnHandle, Turn>()
  private readonly tools: ToolServer
  private readonly file: string
  private readonly model: string | undefined
  private readonly timeoutMs: number
  private readonly pollMs: number
  private readonly discoverMs: number
  private readonly log: (message: string, error?: unknown) => void
  /** 记录选项；默认值与扩展侧保持一致。 */
  constructor(options: VsCodeLmHostOptions = {}) {
    this.file = options.file ?? bridgeFilePath()
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
    this.pollMs = options.pollMs ?? 200
    this.discoverMs = options.discoverMs ?? 5000
    this.log = options.log ?? (() => {})
    this.tools = new ToolServer({ timeoutMs: options.toolTimeoutMs, maxResultChars: options.toolMaxChars, log: this.log })
  }
  /** 等待发现文件出现并查询桥健康；失败只记录状态。 */
  async start(): Promise<void> {
    const at = new Date().toISOString()
    const info = await this.discover()
    if (!info) {
      this.state = { state: 'error', detail: `找不到桥发现文件 ${this.file}；请确认 VS Code 扩展已启动`, at }
      return
    }
    const client = new BridgeClient(info)
    this.client = client
    try {
      const health = await client.health()
      const model = health.model ?? info.model ?? this.model ?? '未知模型'
      this.state = health.state === 'ready'
        ? { state: 'ready', detail: `VS Code 语言模型桥：${model}`, at }
        : { state: 'error', detail: `桥未就绪（${health.state}）：${health.detail ?? '没有可用模型'}`, at }
    } catch (error) {
      this.client = undefined
      this.state = { state: 'error', detail: failure(kindOf(error), messageOf(error)), at }
      this.log('dsh-superagent 无法连接 VS Code 语言模型桥：%s', error)
    }
  }
  /** 最近一次启动或停止后的状态。 */
  health(): HostHealth { return this.state }
  /** 派发一个回合；桥不可用或桥拒绝时抛出带分类的错误。 */
  async dispatch(request: TurnRequest): Promise<TurnHandle> {
    if (this.state.state === 'stopped') throw new Error('宿主已停止，无法派发回合')
    const client = this.client
    if (!client) throw new BridgeError('bridgeUnavailable', `找不到桥发现文件 ${this.file}；请确认 VS Code 扩展已启动`)
    const handle: TurnHandle = { sessionId: request.sessionId, startedAt: new Date().toISOString() }
    const model = request.model ?? this.model
    const toolKey = request.callTool && request.tools?.length ? randomUUID() : undefined
    const endpoint = toolKey && request.callTool ? await this.tools.register(toolKey, request.callTool) : undefined
    try {
      const turnId = await client.start({ sessionId: request.sessionId, directory: request.directory, prompt: request.prompt,
        ...(model ? { model } : {}), timeoutMs: this.timeoutMs,
        ...(endpoint && request.tools ? { tools: request.tools.map(tool => ({ ...tool })), toolBase: endpoint.base, toolToken: endpoint.token } : {}) })
      this.turns.set(handle, { turnId, client, ...(toolKey ? { toolKey } : {}) })
      return handle
    } catch (error) {
      if (toolKey) this.tools.unregister(toolKey)
      throw error
    }
  }
  /** 轮询直到回合结束、超时或被中止；失败一律带分类返回，不抛出。 */
  async collect(handle: TurnHandle, options: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    const turn = this.turns.get(handle)
    if (!turn) throw new Error(`未知的回合：${handle.sessionId}`)
    const deadline = Date.now() + this.timeoutMs
    let cancelling: Promise<void> | undefined
    const abort = (): Promise<void> => {
      cancelling ??= turn.client.cancel(turn.turnId).catch((error: unknown) => {
        this.log('dsh-superagent 取消桥侧回合失败：%s', error)
      })
      return cancelling
    }
    if (options.signal?.aborted) void abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        if (options.signal?.aborted) {
          await abort()
          return this.finish(handle, turn, { error: failure('cancelled', '回合已被调用方取消') })
        }
        let snapshot
        try {
          snapshot = await turn.client.poll(turn.turnId, this.pollMs)
        } catch (error) {
          return this.finish(handle, turn, { error: failure(kindOf(error), messageOf(error)) })
        }
        if (snapshot.state !== 'running') {
          return this.finish(handle, turn, { text: snapshot.text, model: snapshot.model ?? this.model, usage: snapshot.usage,
            toolCalls: snapshot.toolCalls,
            ...(snapshot.error ? { error: failure(snapshot.error.kind, snapshot.error.message) } : {}) })
        }
        if (Date.now() >= deadline) {
          await abort()
          return this.finish(handle, turn, { error: failure('timeout', `回合在 ${this.timeoutMs} 毫秒后超时并被取消`) })
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (turn.toolKey) this.tools.unregister(turn.toolKey)
      this.turns.delete(handle)
    }
  }
  /** 取消所有在途回合并停止宿主；工具回调端点也一并关闭。 */
  async stop(): Promise<void> {
    this.state = { state: 'stopped', detail: '已停止', at: new Date().toISOString() }
    await Promise.all([...this.turns.values()].map(turn => turn.client.cancel(turn.turnId).catch(() => undefined)))
    this.turns.clear()
    this.client = undefined
    await this.tools.stop()
  }
  /** 交给调用方的结局；`error` 用固定前缀标明分类。 */
  private finish(handle: TurnHandle, turn: Turn,
    outcome: { text?: string; model?: string; usage?: BridgeTurn['usage']; toolCalls?: number; error?: string }): TurnResult {
    return { sessionId: handle.sessionId, text: outcome.text ?? '', exitCode: outcome.error ? 1 : 0,
      startedAt: handle.startedAt, endedAt: new Date().toISOString(),
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(outcome.toolCalls !== undefined ? { toolCalls: outcome.toolCalls } : {}),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(outcome.error ? { error: outcome.error } : {}) }
  }
  /** 在 `discoverMs` 内轮询发现文件。 */
  private async discover(): Promise<BridgeInfo | undefined> {
    const deadline = Date.now() + this.discoverMs
    for (;;) {
      const info = await readBridgeInfo(this.file)
      if (info) return info
      if (Date.now() >= deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}
/** 把桥的分类与消息拼成固定前缀，调用方按前缀即可判断来源。 */
function failure(kind: BridgeErrorKind, detail: string): string {
  const prefix: Record<BridgeErrorKind, string> = {
    bridgeUnavailable: '桥不可用', unauthorized: '模型访问未授权', noModel: '没有可用模型',
    quota: '配额不足', timeout: '回合超时', cancelled: '回合已取消', modelError: '模型侧失败',
  }
  return `${prefix[kind]}：${detail}`
}
/** 从任意错误里取出桥的分类；非桥错误归为 `modelError`。 */
function kindOf(error: unknown): BridgeErrorKind {
  return error instanceof BridgeError ? error.kind : 'modelError'
}
/** 取一句可诊断的消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
