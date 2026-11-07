/** 暴露给每个 Source kind 的受限运行时上下文，使 Source 无法直接访问 Store 或 Engine。 */
import type { EngineForSources, ReceiveResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly commands: Commands
  readonly sources: SourceRegistry
  /** 在初始 setup 完成前访问会抛出错误。 */
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(): boolean
  /** `place` 与该 Source kind 匹配的 setup 问题会出现在 `context.problem` 上。 */
  readonly setupProblem?: SetupProblem | undefined
  /** setup 未找到飞书机器人的原因，即使飞书 Source 已指明 CLI。 */
  readonly feishuProblem?: SetupProblem | undefined
  /** 把触发（Trigger）交给 Engine，并调度研判它的 pass。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

/**
 * 为一个 Source kind 构建上下文。健康上报只限于该 kind 声明的条目，
 * 且绑定到当前注册；一旦注销，这些上报就成了空操作。
 */
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; health: readonly string[] }): SourceContext {
  const { store } = deps
  const health = deps.sources.healthEntries(kind.health)
  return {
    get deployment() { return deps.deployment },
    commands: deps.commands,
    ready: deps.ready,
    configured: () => deps.configured(),
    get problem() { return [deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === kind.kind) },
    config: <C extends Record<string, unknown>>(id: string) => {
      const instance = deps.sources.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(name),
      set: (name, value) => { if (value === undefined) store.delete(name); else store.set(name, value) },
      keys: prefix => store.keys(prefix),
    },
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => { store.threads.patchMeta(key, meta) },
    },
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => { deps.engine.bindThread(id, thread, own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(thread, outcome, at) },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => { deps.outbox.send(message) },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
