/** VS Code 扩展宿主与 Runtime 之间的回环桥：发现文件、协议类型与 HTTP 客户端。 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 桥的发现文件内容，由扩展在启动时写入。 */
export interface BridgeInfo {
  /** 扩展进程监听的端口，随机分配。 */
  readonly port: number
  /** 一次性令牌；每个请求都要带 `Authorization: Bearer <token>`。 */
  readonly token: string
  /** 扩展宿主进程号，便于诊断。 */
  readonly pid?: number
  /** 扩展实际选中的模型 id。 */
  readonly model?: string
  /** 写入时刻，ISO 8601。 */
  readonly startedAt?: string
}
/** 回合失败的分类，用来区分“桥不可用”与“模型侧失败”。 */
export type BridgeErrorKind = 'noModel' | 'unauthorized' | 'quota' | 'timeout' | 'cancelled' | 'modelError' | 'bridgeUnavailable'
/** 桥返回的一个回合快照。 */
export interface BridgeTurn {
  readonly state: 'running' | 'done' | 'failed' | 'cancelled'
  readonly text: string
  readonly model?: string
  readonly elapsedMs?: number
  /** 本回合模型实际发起的工具调用数；没有工具时缺省。 */
  readonly toolCalls?: number
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly estimated?: boolean }
  readonly error?: { readonly kind: BridgeErrorKind; readonly message: string }
}
/** 一次派发的入参。 */
export interface BridgeTurnRequest {
  readonly sessionId: string
  readonly directory: string
  readonly prompt: string
  readonly model?: string
  readonly timeoutMs?: number
  /** 本回合暴露给模型的工具。 */
  readonly tools?: readonly TurnToolRequest[]
  /** 工具回调的基地址，形如 `http://127.0.0.1:<port>/turns/<id>`；扩展向它 `POST` 一次调用。 */
  readonly toolBase?: string
  /** 工具回调的令牌，只在本次派发中有效。 */
  readonly toolToken?: string
}
/** 桥协议里的工具定义，与 `TurnTool` 同形。 */
export interface TurnToolRequest {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}
/** 桥客户端可见的错误；`kind` 直接决定 Runtime 侧如何归类。 */
export class BridgeError extends Error {
  /** 失败分类。 */
  readonly kind: BridgeErrorKind
  /** 记录错误分类与消息。 */
  constructor(kind: BridgeErrorKind, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.kind = kind
  }
}
/** 发现文件的默认路径；扩展与 Runtime 用同一套规则计算，`DSH_LM_BRIDGE_FILE` 可覆盖。 */
export function bridgeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_LM_BRIDGE_FILE ?? join(homedir(), '.dsh-superagent', 'lm-bridge.json')
}
/** 读取发现文件；不存在或内容无效时返回 `undefined`，由调用方判为桥不可用。 */
export async function readBridgeInfo(file: string): Promise<BridgeInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<BridgeInfo>
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || parsed.token === '') return undefined
    return { port: parsed.port, token: parsed.token, pid: parsed.pid, model: parsed.model, startedAt: parsed.startedAt }
  } catch {
    return undefined
  }
}
/** 桥的 HTTP 客户端；只连 127.0.0.1，并且每个请求都带令牌。 */
export class BridgeClient {
  private readonly origin: string
  private readonly token: string
  private readonly request: typeof fetch
  /** 记录发现信息与可替换的 fetch，便于测试。 */
  constructor(info: BridgeInfo, request: typeof fetch = fetch) {
    this.origin = `http://127.0.0.1:${info.port}`
    this.token = info.token
    this.request = request
  }
  /** 读取桥的健康状态；鉴权失败抛 `unauthorized`。 */
  async health(): Promise<{ state: string; model?: string; detail?: string }> {
    return this.call<{ state: string; model?: string; detail?: string }>('GET', '/health')
  }
  /** 派发一个回合，返回它的 id。 */
  async start(turn: BridgeTurnRequest): Promise<string> {
    const body = await this.call<{ turnId: string }>('POST', '/turns', turn)
    return body.turnId
  }
  /** 取回回合快照；`waitMs` 让桥在状态变化前保持连接，减少轮询次数。 */
  async poll(turnId: string, waitMs = 0): Promise<BridgeTurn> {
    return this.call<BridgeTurn>('GET', `/turns/${encodeURIComponent(turnId)}?wait=${waitMs}`)
  }
  /** 取消一个回合；已结束的回合取消是幂等的。 */
  async cancel(turnId: string): Promise<void> {
    await this.call('DELETE', `/turns/${encodeURIComponent(turnId)}`)
  }
  /** 统一发请求并把非 2xx 映射成带分类的错误。 */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.request(`${this.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new BridgeError('bridgeUnavailable', `无法连接桥：${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401 || response.status === 403) throw new BridgeError('unauthorized', '桥拒绝了令牌')
    if (response.status === 503) {
      const detail = await response.text()
      throw new BridgeError('noModel', detail || '桥没有可用模型')
    }
    if (!response.ok) throw new BridgeError('modelError', `桥返回 ${response.status}：${(await response.text()).slice(0, 400)}`)
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }
}
