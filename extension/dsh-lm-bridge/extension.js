/**
 * DSH Superagent 语言模型桥扩展。
 *
 * `vscode.lm` 只在 VS Code 扩展宿主进程内可用，而 `dsh-superagent` 的 Runtime 是独立 Node 进程。
 * 本扩展因此在宿主内启动一个**只绑 127.0.0.1**的 HTTP 服务，把 `selectChatModels` 与
 * `sendRequest` 包装成回合接口；Runtime 侧的 `VsCodeLmHost` 通过发现文件找到端口与一次性令牌。
 *
 * 鉴权：每个请求都必须带 `Authorization: Bearer <token>`；令牌每次启动随机生成，只写进
 * 权限为 0600 的发现文件。非回环来源、错误 Host 头、错误令牌一律拒绝。
 *
 * 配置（`dsh.lmBridge.*`）：模型 id、发现文件路径、单回合超时。
 * 发现文件默认 `~/.dsh-superagent/lm-bridge.json`，环境变量 `DSH_LM_BRIDGE_FILE` 优先。
 */
const vscode = require('vscode')
const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** 未配置或配置的模型不可用时，优先尝试的模型 id。 */
const PREFERRED_MODEL = 'deepseek-flash'
/** 请求体上限，回合提示词远小于它。 */
const MAX_BODY = 1024 * 1024
/** 长轮询单次等待上限，避免客户端占住连接。 */
const MAX_WAIT_MS = 30000
/** 发现文件路径的环境变量覆盖名。 */
const DISCOVERY_ENV = 'DSH_LM_BRIDGE_FILE'

/** 桥侧失败，`kind` 与 Runtime 的 `BridgeErrorKind` 一一对应。 */
class BridgeFailure extends Error {
  /**
   * 记录失败分类与消息。
   * @param {'noModel'|'unauthorized'|'quota'|'timeout'|'cancelled'|'modelError'} kind 失败分类。
   * @param {string} message 可诊断的消息。
   */
  constructor(kind, message) {
    super(message)
    this.name = 'BridgeFailure'
    this.kind = kind
  }
}

/** 扩展内部的运行状态。 */
const state = {
  /** @type {import('node:http').Server | undefined} */
  server: undefined,
  port: 0,
  token: '',
  /** @type {Map<string, Turn>} */
  turns: new Map(),
  /** @type {vscode.LanguageModelChat | undefined} */
  model: undefined,
  /** @type {Promise<vscode.LanguageModelChat> | undefined} */
  resolving: undefined,
  /** @type {string | undefined} */
  discoveryFile: undefined,
  /** @type {vscode.OutputChannel | undefined} */
  output: undefined,
  /** @type {string | undefined} */
  logFile: undefined,
  /** 记录本扩展是否为本窗口启动了桥；远程已有桥时为 false。 */
  owner: false,
}

/**
 * 追加一行诊断日志，同时写入输出面板与全局存储下的日志文件。
 * 日志不包含令牌或完整提示词。
 * @param {string} line 日志内容。
 */
function log(line) {
  const text = `${new Date().toISOString()} ${line}`
  state.output?.appendLine(text)
  if (!state.logFile) return
  try {
    fs.appendFileSync(state.logFile, `${text}\n`, 'utf8')
  } catch {
    // 日志写失败不应影响桥本身。
  }
}

/**
 * 从工作区配置读取桥的设置。
 * @returns {{model: string, discoveryFile: string, timeoutMs: number}} 当前设置。
 */
function settings() {
  const config = vscode.workspace.getConfiguration('dsh.lmBridge')
  return {
    model: config.get('model', PREFERRED_MODEL),
    discoveryFile: config.get('discoveryFile', ''),
    timeoutMs: config.get('timeoutMs', 30 * 60 * 1000),
  }
}

/**
 * 计算发现文件路径：环境变量 > 设置 > 默认路径。
 * @returns {string} 绝对路径。
 */
function discoveryFile() {
  const override = process.env[DISCOVERY_ENV] || settings().discoveryFile
  return override && override.trim() !== ''
    ? path.resolve(override)
    : path.join(os.homedir(), '.dsh-superagent', 'lm-bridge.json')
}

/**
 * 把模型压成可序列化的摘要。
 * @param {vscode.LanguageModelChat} model 语言模型。
 * @returns {{id: string, name: string, vendor: string, family: string, version: string, maxInputTokens: number}} 摘要。
 */
function describe(model) {
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
  }
}

/**
 * 按 id、family、name 的顺序解析模型；未指定时先试首选模型，再退回第一个可用模型。
 * @param {string | undefined} requested 调用方指定的模型；缺省用配置值。
 * @returns {Promise<vscode.LanguageModelChat>} 选中的模型。
 * @throws {BridgeFailure} 没有任何模型，或显式指定的模型不存在。
 */
async function resolveModel(requested) {
  const models = await vscode.lm.selectChatModels({})
  if (models.length === 0) {
    throw new BridgeFailure('noModel', 'selectChatModels 返回空列表；请在 VS Code 中登录 Copilot 并允许扩展访问语言模型')
  }
  const wanted = requested && requested.trim() !== '' ? requested.trim() : settings().model
  const exact = models.find(model => model.id === wanted)
  if (exact) return exact
  const family = models.find(model => model.family === wanted)
  if (family) return family
  const named = models.find(model => model.name === wanted)
  if (named) return named
  if (requested && requested.trim() !== '') {
    throw new BridgeFailure('noModel', `找不到模型 ${wanted}；可用：${models.map(model => model.id).join('、')}`)
  }
  return models[0]
}

/**
 * 取默认模型，成功后缓存；失败不缓存，下次健康检查会重试。
 * @returns {Promise<vscode.LanguageModelChat>} 默认模型。
 */
async function currentModel() {
  if (state.model) return state.model
  if (!state.resolving) {
    state.resolving = resolveModel(undefined)
      .then(model => {
        state.model = model
        log(`selected model: ${model.id} (${model.name})`)
        publish()
        return model
      })
      .finally(() => {
        state.resolving = undefined
      })
  }
  return state.resolving
}

/**
 * 估算 token 用量：本版本 `response.usage` 为 null，因此用模型自带的 `countTokens` 计量。
 * @param {vscode.LanguageModelChat} model 语言模型。
 * @param {string} prompt 发送的提示词。
 * @param {string} text 收到的回复。
 * @returns {Promise<{inputTokens: number, outputTokens: number, estimated: true} | undefined>} 用量，失败时为空。
 */
async function estimateUsage(model, prompt, text) {
  try {
    const inputTokens = await model.countTokens(prompt)
    const outputTokens = text === '' ? 0 : await model.countTokens(text)
    return { inputTokens, outputTokens, estimated: true }
  } catch {
    return undefined
  }
}

/**
 * 把异常映射成桥的错误分类。
 * @param {unknown} error 捕获的异常。
 * @param {boolean} timedOut 是否由本扩展的超时触发。
 * @returns {{kind: string, message: string}} 分类与消息。
 */
function classify(error, timedOut) {
  const message = error instanceof Error ? error.message : String(error)
  if (timedOut) return { kind: 'timeout', message: `回合超过配置的超时（${settings().timeoutMs} 毫秒）` }
  if (error instanceof BridgeFailure) return { kind: error.kind, message }
  if (error instanceof vscode.CancellationError || error?.name === 'Canceled') return { kind: 'cancelled', message: '回合已被取消' }
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'NoPermissions' || code === 'Blocked') return { kind: 'unauthorized', message }
  if (code === 'NotFound') return { kind: 'noModel', message }
  if (/quota|rate.?limit|429|too many requests/i.test(`${code} ${message}`)) return { kind: 'quota', message }
  if (/sign in|login|not authenticated|no access|permission|consent/i.test(message)) return { kind: 'unauthorized', message }
  return { kind: 'modelError', message }
}

/**
 * 生成一个回合的快照，供 HTTP 端点返回。
 * @param {Turn} turn 回合。
 * @returns {object} 快照。
 */
function snapshot(turn) {
  return {
    state: turn.state,
    text: turn.text,
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.endedAt === undefined ? {} : { elapsedMs: turn.endedAt - turn.startedAt }),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  }
}

/**
 * 唤醒所有等待该回合的长轮询。
 * @param {Turn} turn 回合。
 */
function wake(turn) {
  for (const notify of turn.waiters) notify()
  turn.waiters.clear()
}

/**
 * 执行一个回合：选模型、发请求、流式收集文本、记录用量并落在终态。
 * 本函数不抛出；所有失败写进回合快照。
 * @param {Turn} turn 回合状态。
 * @param {{prompt: string, model?: string, timeoutMs?: number}} request 派发参数。
 */
async function runTurn(turn, request) {
  const source = new vscode.CancellationTokenSource()
  turn.cancel = () => source.cancel()
  const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : settings().timeoutMs
  const timer = setTimeout(() => {
    turn.timedOut = true
    source.cancel()
  }, timeoutMs)
  const started = Date.now()
  try {
    const model = await resolveModel(request.model)
    turn.model = model.id
    log(`turn ${turn.id} start model=${model.id} timeout=${timeoutMs}`)
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(request.prompt)],
      { justification: 'dsh-superagent 的 worker 回合需要读取工单并给出修改结果' },
      source.token,
    )
    let text = ''
    const chunks = response.stream ?? response.text
    for await (const chunk of chunks) {
      if (typeof chunk === 'string') text += chunk
      else if (chunk instanceof vscode.LanguageModelTextPart) text += chunk.value
    }
    turn.text = text
    turn.usage = response.usage
      ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
      : await estimateUsage(model, request.prompt, text)
    turn.state = source.token.isCancellationRequested && text === '' ? (turn.timedOut ? 'failed' : 'cancelled') : 'done'
    if (turn.state === 'failed') {
      turn.error = { kind: 'timeout', message: `回合超过配置的超时（${timeoutMs} 毫秒）` }
    } else if (source.token.isCancellationRequested) {
      turn.state = 'cancelled'
      turn.error = { kind: 'cancelled', message: '回合已被取消' }
    }
    log(`turn ${turn.id} ${turn.state} elapsed=${Date.now() - started}ms tokens=${JSON.stringify(turn.usage ?? null)}`)
  } catch (error) {
    const failure = classify(error, turn.timedOut === true)
    turn.state = failure.kind === 'cancelled' ? 'cancelled' : 'failed'
    turn.error = failure
    log(`turn ${turn.id} ${turn.state} kind=${failure.kind} message=${failure.message}`)
  } finally {
    clearTimeout(timer)
    turn.endedAt = Date.now()
    turn.cancel = undefined
    wake(turn)
  }
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} response 响应。
 * @param {number} status 状态码。
 * @param {unknown} body 响应体；`undefined` 表示空响应。
 */
function sendJson(response, status, body) {
  if (body === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(text)
}

/**
 * 读取请求体，超过上限时中断连接。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @returns {Promise<string>} 请求体文本。
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        request.destroy()
        reject(new BridgeFailure('modelError', `请求体超过 ${MAX_BODY} 字节`))
        return
      }
      parts.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * 校验来源是否为回环地址。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @returns {boolean} 是否来自本机。
 */
function loopback(request) {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 校验 Host 头，防止 DNS rebinding 把外部域名解析到回环端口。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @returns {boolean} Host 是否为 127.0.0.1/localhost 加本端口。
 */
function hostAllowed(request) {
  const host = (request.headers.host ?? '').toLowerCase()
  return host === `127.0.0.1:${state.port}` || host === `localhost:${state.port}` || host === `[::1]:${state.port}`
}

/**
 * 常数时间比较令牌。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @returns {boolean} 令牌是否正确。
 */
function authorized(request) {
  const given = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${state.token}`)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

/**
 * 等待回合状态变化，最多 `waitMs`；已在终态时立即返回。
 * @param {Turn} turn 回合。
 * @param {number} waitMs 最长等待毫秒数。
 * @returns {Promise<void>} 状态变化或超时后完成。
 */
function waitForChange(turn, waitMs) {
  if (turn.state !== 'running' || waitMs <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      turn.waiters.delete(done)
      resolve()
    }, waitMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    turn.waiters.add(done)
  })
}

/**
 * 处理一个 HTTP 请求：先做来源、Host 与令牌校验，再按路由分派。
 * @param {import('node:http').IncomingMessage} request 请求。
 * @param {import('node:http').ServerResponse} response 响应。
 */
async function handle(request, response) {
  if (!loopback(request) || !hostAllowed(request)) {
    sendJson(response, 403, { error: '只接受本机回环请求' })
    return
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: '令牌无效' })
    return
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${state.port}`)
  const segments = url.pathname.split('/').filter(Boolean)
  try {
    if (segments.length === 1 && segments[0] === 'health' && request.method === 'GET') {
      try {
        const model = await currentModel()
        sendJson(response, 200, { state: 'ready', model: model.id, detail: `${model.name}（${model.vendor}）`, at: new Date().toISOString() })
      } catch (error) {
        const failure = classify(error, false)
        sendJson(response, 200, { state: failure.kind === 'noModel' ? 'noModel' : 'error', detail: failure.message, at: new Date().toISOString() })
      }
      return
    }
    if (segments.length === 1 && segments[0] === 'turns' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request))
      if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
        sendJson(response, 400, { error: 'prompt 不能为空' })
        return
      }
      // 先确认有模型，避免把“没有模型”拖到回合里才发现。
      await currentModel().catch(() => undefined)
      const turn = {
        id: crypto.randomUUID(),
        state: 'running',
        text: '',
        startedAt: Date.now(),
        endedAt: undefined,
        model: undefined,
        usage: undefined,
        error: undefined,
        timedOut: false,
        cancel: undefined,
        waiters: new Set(),
      }
      state.turns.set(turn.id, turn)
      void runTurn(turn, body)
      sendJson(response, 202, { turnId: turn.id })
      return
    }
    if (segments.length === 2 && segments[0] === 'turns') {
      const turn = state.turns.get(segments[1])
      if (!turn) {
        sendJson(response, 404, { error: `未知回合：${segments[1]}` })
        return
      }
      if (request.method === 'GET') {
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), MAX_WAIT_MS)
        await waitForChange(turn, wait)
        sendJson(response, 200, snapshot(turn))
        return
      }
      if (request.method === 'DELETE') {
        turn.timedOut = false
        turn.cancel?.()
        sendJson(response, 204, undefined)
        return
      }
    }
    sendJson(response, 404, { error: `未知路由：${request.method} ${url.pathname}` })
  } catch (error) {
    const failure = classify(error, false)
    sendJson(response, failure.kind === 'noModel' ? 503 : 500, { error: failure.message, kind: failure.kind })
  }
}

/**
 * 原子写入发现文件：先写临时文件再改名，避免 Runtime 读到半个 JSON。
 */
function publish() {
  if (!state.owner || !state.discoveryFile) return
  const info = {
    port: state.port,
    token: state.token,
    pid: process.pid,
    ...(state.model ? { model: state.model.id } : {}),
    startedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(path.dirname(state.discoveryFile), { recursive: true })
    const temporary = `${state.discoveryFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, state.discoveryFile)
  } catch (error) {
    log(`发现文件写入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 清理发现文件，仅在它仍属于本扩展时删除。
 */
function unpublish() {
  if (!state.owner || !state.discoveryFile) return
  try {
    const info = JSON.parse(fs.readFileSync(state.discoveryFile, 'utf8'))
    if (info.port === state.port && info.token === state.token) fs.unlinkSync(state.discoveryFile)
  } catch {
    // 文件已不存在或不可读，无需处理。
  }
}

/**
 * 探测另一个 VS Code 窗口是否已经启动了可用的桥，避免多窗口互相覆盖发现文件。
 * @param {string} file 发现文件路径。
 * @returns {Promise<boolean>} 是否已有可用桥。
 */
async function bridgeAlive(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof info.port !== 'number' || typeof info.token !== 'string') return false
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 启动回环 HTTP 服务并发布发现文件。
 * @param {vscode.ExtensionContext} context 扩展上下文。
 */
async function startBridge(context) {
  state.discoveryFile = discoveryFile()
  if (await bridgeAlive(state.discoveryFile)) {
    state.owner = false
    log(`已有可用的桥（${state.discoveryFile}），本窗口不再启动第二个`)
    return
  }
  state.token = crypto.randomBytes(32).toString('hex')
  state.server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      log(`请求处理失败：${error instanceof Error ? error.message : String(error)}`)
      try {
        sendJson(response, 500, { error: '内部错误' })
      } catch {
        // 连接可能已断开。
      }
    })
  })
  await new Promise((resolve, reject) => {
    state.server.once('error', reject)
    state.server.listen(0, '127.0.0.1', () => {
      const address = state.server.address()
      state.port = typeof address === 'object' && address ? address.port : 0
      resolve()
    })
  })
  state.owner = true
  publish()
  log(`bridge listening on 127.0.0.1:${state.port}; discovery=${state.discoveryFile}`)
  // 预热模型选择，让 Runtime 的首次 health 尽快拿到模型 id。
  void currentModel().catch(error => {
    log(`模型预选失败：${error instanceof Error ? error.message : String(error)}`)
  })
  context.subscriptions.push({
    dispose: () => {
      unpublish()
      state.server?.close()
      state.server = undefined
    },
  })
}

/**
 * 扩展激活：准备日志、启动桥，并登记状态命令。
 * @param {vscode.ExtensionContext} context 扩展上下文。
 */
async function activate(context) {
  state.output = vscode.window.createOutputChannel('DSH Superagent 语言模型桥')
  context.subscriptions.push(state.output)
  try {
    const directory = context.globalStorageUri?.fsPath
    if (directory) {
      fs.mkdirSync(directory, { recursive: true })
      state.logFile = path.join(directory, 'bridge.log')
    }
  } catch {
    state.logFile = undefined
  }
  log(`activate VS Code ${vscode.version}`)
  context.subscriptions.push(vscode.commands.registerCommand('dshLmBridge.status', async () => {
    if (!state.owner) {
      vscode.window.showInformationMessage(`DSH 语言模型桥：本窗口未启动（发现文件 ${state.discoveryFile ?? '未知'}）`)
      return
    }
    let model = '未选择'
    try {
      model = (await currentModel()).id
    } catch (error) {
      model = `不可用：${error instanceof Error ? error.message : String(error)}`
    }
    vscode.window.showInformationMessage(`DSH 语言模型桥：127.0.0.1:${state.port}，模型 ${model}，回合 ${state.turns.size} 个`)
  }))
  await startBridge(context).catch(error => {
    log(`桥启动失败：${error instanceof Error ? error.message : String(error)}`)
    vscode.window.showWarningMessage(`DSH 语言模型桥启动失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

/** 扩展停用：删除发现文件并关闭服务。 */
function deactivate() {
  unpublish()
  for (const turn of state.turns.values()) {
    turn.timedOut = false
    turn.cancel?.()
  }
  state.turns.clear()
  state.server?.close()
  state.server = undefined
}

module.exports = { activate, deactivate, describe }
