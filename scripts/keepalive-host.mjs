#!/usr/bin/env node
/**
 * A6 保活演练用的常驻服务宿主。
 *
 * 本机没有安装 `dsh` 宿主 CLI，因此这里以 `tests/fixtures/host.ts` 的 `startRuntime()` 为蓝本，
 * 用假的 DSH 服务（agents / sessionController / sessionPersistence / workspaceRegistry /
 * permissionPresets / subprocess / webServer / jobs / subagents / llm）驱动**真实的** `Runtime`，
 * 从而得到真实的 SQLite 状态目录、真实的管理 HTTP 路由与真实的 MCP 端点。
 *
 * 运行方式（直接加载 `src/**` 的 TypeScript 源码，不依赖 `lib/`）：
 *   node --experimental-transform-types scripts/keepalive-host.mjs
 *
 * 环境变量：
 *   KEEPALIVE_STATE_DIR  状态目录，缺省 `.artifacts/keepalive/state`（跨重启必须保持不变）
 *   KEEPALIVE_WEB_PORT   管理 HTTP 端口，缺省 3082
 *   KEEPALIVE_MCP_PORT   MCP 端点端口，缺省 3083
 */
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_DIR = process.env.KEEPALIVE_STATE_DIR ?? join(ROOT, '.artifacts', 'keepalive', 'state')
const WEB_PORT = Number(process.env.KEEPALIVE_WEB_PORT ?? 3082)
const MCP_PORT = Number(process.env.KEEPALIVE_MCP_PORT ?? 3083)
const BIN_DIR = join(ROOT, '.artifacts', 'keepalive', 'bin')
const AGENT = join(BIN_DIR, 'agent-gh')
const BOT = join(BIN_DIR, 'lark-bot')
const MEMBER = 'ou_alice'
const CHAT = 'oc_team'

/** 构造一个可变的 Volatile 引用，供 `Machine` 的三个 volatile 字段使用。 */
function reference(value) {
  return { get: () => value, set: next => { value = next } }
}

/** 把命令行里 `env` 前缀与 `KEY=VALUE` 前缀剥掉，返回剩余 argv 以作为答案表的键。 */
function stripped(argv) {
  const rest = [...argv]
  while (rest[0] === 'env' || /^[A-Z_]+=/.test(rest[0] ?? '')) rest.shift()
  return rest
}

/** 创建一个把固定文本作为一次读取结果的假子进程输出读取器。 */
function reader(text) {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

/**
 * Executor 使用的假 DSH job registry（与测试夹具同构，去掉了 vitest 断言工具）。
 * @param owner - 按 session id 查找该 Session 的 agent，结束通知会送达它。
 */
function jobRegistry(owner = () => undefined) {
  const jobs = new Map()
  const listeners = new Set()
  const waits = new Map()
  let released = 0
  const emit = (job, type) => { for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type }) }
  const notice = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } })
  const end = (id, status = 'completed') => {
    const job = jobs.get(id)
    if (!job) return
    job.status = status
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake({ ...job })
    emit(job, 'settled')
    const agent = waiting.length ? undefined : owner(job.owner)
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
  }
  const service = {
    list: caller => [...jobs.values()].filter(job => job.owner === caller),
    wait: (id, _timeoutMs, _caller, signal) => new Promise((resolve, reject) => {
      const wake = job => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    }),
    kill: id => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' },
    events: { subscribe: (filter, listener) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
  }
  return { service, end, output: id => { emit(jobs.get(id), 'output') }, get released() { return released },
    run: (owner, label) => { const id = `bash-${jobs.size + 1}`; jobs.set(id, { id, owner, status: 'running', label }); return id } }
}

/**
 * Executor 使用的假 subagent 运行时（与测试夹具同构），维护父子关系、settle 与 drain 语义。
 * @param agents - session id 到 agent 的映射，子级结束会通知父级。
 */
function subagentRuntime(agents) {
  const children = new Map()
  const closed = new Set()
  const settle = (id, wake = true) => {
    const child = children.get(id)
    if (!child?.live) return
    child.live = false
    agents.delete(id)
    const parent = agents.get(child.parent)
    const ended = { id: `settled-${id}`, role: 'user', content: [{ type: 'text', text: `Subagent ${id} settled` }], source: { kind: 'tool-jobs', form: 'notice' } }
    if (!wake) parent?.inject(ended)
    else if (parent?.status === 'idle') parent.followup(ended)
    else parent?.steer(ended)
    child.settled.resolve()
  }
  const service = {
    waitForChildren: async parent => {
      const live = [...children.values()].filter(child => child.parent === parent.id && child.live)
      await Promise.all(live.map(child => child.settled.promise))
      return live.length > 0
    },
    listChildren: async id => [...children].filter(([, child]) => child.parent === id).map(([childId]) => ({ id: childId })),
    drainChildren: async (_parent, ids) => { for (const id of ids) settle(id) },
    drainDescendants: async parents => {
      for (const parent of parents) {
        closed.add(parent.id)
        for (const [id, child] of children) if (child.parent === parent.id) settle(id, false)
      }
    },
    interrupt: id => { settle(id) },
  }
  const spawn = parent => {
    if (closed.has(parent)) throw new Error('DRAINING: the Session admits no new subagents')
    const id = `child-${children.size + 1}`
    children.set(id, { parent, live: true, settled: Promise.withResolvers() })
    agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } } })
    return id
  }
  return { service, settle, spawn, live: id => !!children.get(id)?.live }
}

/**
 * 启动保活宿主：构造上下文与假服务，创建状态目录与假 CLI，写入初始 Settings，
 * 启动真实 Runtime 与真实管理 HTTP 服务器，然后保持前台运行直到收到信号。
 */
async function main() {
  // 状态目录在多次重启之间必须一致，否则 `proper-lockfile` 的残留锁无从观察。
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(BIN_DIR, { recursive: true })
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })

  // 用普通函数替换 Commands 的 CLI 调用，等价于夹具里的 vi.spyOn；不需要任何测试依赖。
  const repository = { default_branch: 'master', permissions: { push: true } }
  Commands.prototype.gh = async function gh(args) { return args[1] === 'user' ? { login: 'agent-bot' } : repository }
  Commands.prototype.lark = async function lark() { return { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false } }
  Commands.prototype.git = async function git() { return '' }
  Commands.prototype.run = async function run() { return '{"ok":true,"data":{}}' }

  // 子进程按固定答案表回应，键是去掉 env / KEY=VALUE 前缀后的 argv。
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers = {
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(STATE_DIR)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  const subprocess = {
    spawn: spec => {
      const argv = stripped(spec.argv)
      const exited = { exitCode: 0, signal: null }
      return { done: Promise.resolve(exited), collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
    },
  }

  const agents = new Map()
  const steps = new Map()
  const claims = new Map()
  const tools = new Map()
  const resolveAgent = async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    create: async ({ sessionId }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const sessionTools = new Map()
      tools.set(sessionId, sessionTools)
      const register = tool => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) }
      agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: () => () => {}, guard: () => () => {} })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [], nextStep: [],
        remove: id => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      const taken = new Set()
      let turn = 0
      /** 让当前 step 取走等待中的消息，并像 DSH 那样把认领与历史事件发给宿主。 */
      const take = (starts, cut = false) => {
        const agent = agents.get(sessionId)
        const queued = starts ? inbox.nextTurn.filter(message => !taken.has(message.id)).slice(0, 1) : []
        for (const message of [...inbox.nextStep.filter(item => !taken.has(item.id)), ...queued]) {
          taken.add(message.id)
          ctx.emit('agent/inbox/claimed', { agent, message, turn })
          if (!cut) ctx.emit('session/event', session, { type: 'user/message', data: message })
        }
      }
      steps.set(sessionId, () => { take(false) })
      claims.set(sessionId, () => { take(false, true) })
      const deliver = mode => message => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        const agent = agents.get(sessionId)
        if (agent.status !== 'idle') return
        agent.status = 'running'
        ctx.emit('agent/status', { agent, status: 'running' })
        turn++
        take(true)
      }
      const session = { id: sessionId, header: { agentPreset: 'dsh-superagent-router' }, snapshotEvents: () => [], requestHeader: () => undefined, append: () => {} }
      let status = 'idle'
      const idle = []
      const cancel = (_cause, options) => {
        if (!options?.keepInbox) { inbox.nextTurn.length = 0; inbox.nextStep.length = 0 }
        if (status === 'idle') return
        queueMicrotask(() => {
          const agent = agents.get(sessionId)
          if (agent.status === 'idle') return
          agent.status = 'idle'
          ctx.emit('agent/status', { agent, status: 'idle' })
        })
      }
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), inject: () => {}, session, cancel,
        get status() { return status }, set status(next) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
        whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise(resolve => { idle.push(resolve) }) })
    },
    selectModel: async () => {},
    resolveAgent,
    rename: async () => {},
    prompt: () => { throw new Error('Plugin delivery must not use user RPC') },
    inspect: async () => ({ events: [] }),
  }
  const persistence = { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) }

  // 真实的管理 HTTP 服务器：把请求交给 registerHttp 注册的 handler。
  let handler
  const webServer = {
    host: '127.0.0.1',
    port: WEB_PORT,
    register: route => {
      handler = route.handler
      return () => { if (handler === route.handler) handler = undefined }
    },
  }
  const web = createServer((req, res) => {
    if (!handler) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('编排器尚未注册路由'); return }
    Promise.resolve(handler(req, res)).catch(error => {
      if (res.headersSent) { res.end(); return }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  await new Promise((ok, fail) => {
    web.once('error', fail)
    web.listen(WEB_PORT, '127.0.0.1', () => { web.off('error', fail); ok() })
  })

  const jobs = jobRegistry(id => agents.get(id))
  const subagents = subagentRuntime(agents)
  const services = { agents, llm: { resolveCallConfig: async value => value }, sessionController: controller,
    sessionPersistence: persistence, workspaceRegistry: { create: async cwd => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer,
    jobs: jobs.service, subagents: subagents.service }
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)

  // 在打开数据库之前写入初始 Settings：GitHub `acme/widgets` 与飞书 bot。
  const seeded = new Store(join(STATE_DIR, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources }))
  seeded.close()

  const machine = { stateDir: STATE_DIR, promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
    admissionContextTimeoutMs: reference(15000), mcpEnabled: true, mcpPort: MCP_PORT }
  const runtime = new Runtime(ctx, machine, () => {})
  await runtime.ready
  runtime.sources.register(feishuKind)
  runtime.sources.register(githubKind)
  // 允许 Alice、监听 `oc_team`，并让评估自动通过。
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })

  const mcp = runtime.mcpPort ?? MCP_PORT
  process.stdout.write(`keepalive-host ready web=http://127.0.0.1:${WEB_PORT} mcp=http://127.0.0.1:${mcp}/mcp pid=${process.pid} state=${STATE_DIR}\n`)

  /** 收到信号后优雅停止 Runtime 与 HTTP 服务器，然后以 0 退出。 */
  const shutdown = async signal => {
    process.stderr.write(`keepalive-host 收到 ${signal}，正在停止\n`)
    try { await runtime.stop() } catch (error) { process.stderr.write(`keepalive-host 停止 Runtime 失败：${String(error)}\n`) }
    await new Promise(ok => web.close(() => ok()))
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('uncaughtException', error => {
    process.stderr.write(`keepalive-host 未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    process.stderr.write(`keepalive-host 未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`)
    process.exit(1)
  })
  // 让脚本保持前台运行；事件循环由监听器、定时器与 Runtime 的后台循环支撑。
  await new Promise(() => {})
}

try { await main() } catch (error) {
  // 锁被占用、端口冲突、setup 失败等启动错误：打印到 stderr 并以非 0 退出，让守护脚本能识别。
  process.stderr.write(`keepalive-host 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
}
