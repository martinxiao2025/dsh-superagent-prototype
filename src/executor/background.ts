/**
 * worker 在 DSH 中的后台工作：其 Session 拥有的 shell 作业（`ctx.jobs`）与其 subagent（`ctx.subagents`）。
 * 它们在轮次结束后让 worker 保持忙碌，并随其 Assignment 一起停止。缺少这两个服务的 profile 则没有后台工作。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Executor 用到 DSH 作业注册表的部分：Session 可见的作业、其事件、等待某个作业与杀掉某个作业。 */
interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void }
}
/** Executor 用到 DSH subagent 的部分：等待 worker 正在工作的 subagent、列出其 subagent，以及释放它们。 */
interface Subagents {
  waitForChildren(parent: Agent): Promise<boolean>
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>
}
/** 停止时等待被杀的作业结束的时长，并收集其结束，使 worker 不会因此被唤醒。 */
const KILL_WAIT_MS = 10_000
/** 释放 subagent 可能耗用的最长时间；这会拖住关停，因此 DSH 自己的调用方也会加以限制。 */
const DRAIN_LIMIT_MS = 10_000
/** 单次收集作业结束的等待持续多久；若结束时作业仍在运行，则接着进行下一次等待。 */
const COLLECT_WAIT_MS = 10 * 60_000

const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs') as Jobs | undefined
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('subagents') as Subagents | undefined
const running = (status: string) => status === 'running' || status === 'stopping'
/** Session 拥有的、正在运行的作业，但排除 `except` 中的（例如留给人处理的那些）。 */
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status) && !except?.has(job.id))
/** `work`；若 `signal` 先中止或先经过 `ms` 毫秒，则为 false。 */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/** 因停止其 subagent 而取消了轮次的 worker；它们下一次空闲结束的是那个轮次，而不是它们自己的轮次。 */
export const cancelled = new WeakSet<Agent>()
/** 每个 worker subagent 的待处理等待；DSH 无法取消它，因此后续观察会接续同一个等待。 */
const joins = new WeakMap<Agent, Promise<boolean>>()
function childrenEnd(subagents: Subagents, agent: Agent): Promise<boolean> {
  let join = joins.get(agent)
  if (!join) {
    join = subagents.waitForChildren(agent).finally(() => { joins.delete(agent) })
    joins.set(agent, join)
  }
  return join
}

/** 用作业 ID 与其 label 首行表示的作业。 */
const named = (job: { id: string; label?: string }) => { const line = job.label?.split('\n')[0]?.trim(); return line ? `${job.id} (${line})` : job.id }
/** Session 拥有且仍在运行的 shell 作业（排除 `except` 中的），带名称。 */
export const runningJobs = (ctx: Context, sessionId: string, except?: ReadonlySet<string>): { id: string; name: string }[] => {
  const jobs = registry(ctx)
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : []
}

/**
 * 等待直到 Session 拥有的 shell 作业都不再运行；若原本就没有作业在运行，或 `signal` 先中止，则立即返回 false。
 * 该等待不是任何作业的 waiter，因此每个作业的结束仍会传达给 worker。
 */
function jobsEnd(ctx: Context, sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  const jobs = registry(ctx)
  if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true; unsubscribe(); signal.removeEventListener('abort', aborted); resolve(value)
    }
    const aborted = () => { done(false) }
    // 只有作业结束才可能让没有作业在运行；作业的输出不会。
    const unsubscribe = jobs.events.subscribe({ owner: sessionId }, event => {
      if ((event.type === 'settled' || event.type === 'removed') && !owned(jobs, sessionId, except).length) done(true)
    })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * 等待直到进入空闲的 worker 没有东西在运行：它的 shell 作业（排除 `except` 中的）与其 subagent。作业或
 * subagent 的结束会带着结果唤醒 worker，从而结束本次观察：它启动的轮次会以自己的空闲结束，
 * 并重新进行观察。
 * @returns 当这些工作全部结束且 worker 处于空闲时返回 true；当 worker 再次运行，或 `signal` 先中止
 * （例如宿主停止或观察时限已到）时返回 false。
 */
export async function untilQuiet(ctx: Context, agent: Agent, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  for (;;) {
    const subagents = subagentsOf(ctx)
    const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false
    const jobs = await jobsEnd(ctx, agent.id, signal, except)
    if (signal.aborted || agent.status !== 'idle') return false
    if (!children && !jobs) return true
  }
}

/**
 * 杀掉 Session 拥有的 shell 作业（排除 `except` 中的），并收集每个结束，使 worker 不会因此被唤醒。
 * 一次失败不会阻止其他操作。
 */
export async function killJobs(ctx: Context, sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId, except) : []
  const failures: unknown[] = []
  // 等待在杀掉之前就开始，因此每个结束都算作已收集。
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id, sessionId, reason) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * 收集 Session 拥有的某个 shell 作业的结束，使其不唤醒任何人，直到 `signal` 中止。
 * @returns 作业结束后返回其名称与状态；若 `signal` 先中止则返回 undefined。
 */
export async function collectJob(ctx: Context, sessionId: string, job: { id: string; name: string }, signal: AbortSignal):
  Promise<{ name: string; status: string } | undefined> {
  const jobs = registry(ctx)
  while (jobs && !signal.aborted) {
    const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => undefined)
    if (!view) return undefined
    if (!running(view.status)) return { name: job.name, status: view.status }
  }
  return undefined
}

/**
 * 在有限时间内释放 worker 的存活 subagent。DSH 会在释放返回之前把每个 subagent 的结束投递给 worker，
 * 从而唤醒它；因此随后取消该 worker 的轮次（`keepInbox` 为真时保留其收件箱），停止随该轮次结束。
 * 其 Session 仍可接纳新的 subagent。
 */
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return
  // 目录会列出该 Session 曾有过的所有 subagent；已结束的 subagent 没有对应 agent。
  const live = (await subagents.listChildren(agent.id)).map(child => child.id).filter(id => ctx.agents.get(id as SessionId))
  if (!live.length) return
  try { await until(subagents.drainChildren(agent, live), undefined, DRAIN_LIMIT_MS) }
  finally {
    if (agent.status !== 'idle') cancelled.add(agent)
    agent.cancel({ kind: 'user' }, { keepInbox })
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS)
  }
}

/**
 * Assignment 结束后停止 worker 在后台运行的内容：杀掉其 shell 作业并释放其 subagent（见
 * `stopSubagents`）。未加载的 Session 没有在工作的 subagent。一次失败不会阻止其他操作。
 */
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
