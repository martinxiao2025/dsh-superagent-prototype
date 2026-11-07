/**
 * worker 在 DSH 中的后台工作：其 Session 所拥有的 shell 作业（`ctx.jobs`）与其子代理（`ctx.subagents`）。它们
 * 会在 worker 的回合结束之后让它保持忙碌，并随其派工一起停止。没有这两项服务的 profile 则两者皆无。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 执行器对 DSH 作业注册表的使用：Session 可见的作业、其事件、对某个作业的等待与终止。 */
interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void }
}
/** 执行器对 DSH 子代理的使用：加入 worker 正在工作的子代理、列出其子代理，以及释放它们。 */
interface Subagents {
  waitForChildren(parent: Agent): Promise<boolean>
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>
}
/** 停止操作等待被终止的作业结束的时长，同时收集其结束，以免 worker 被唤醒去听取消息。 */
const KILL_WAIT_MS = 10_000
/** 释放子代理可以花费的时长；它可能拖慢关闭，因此 DSH 自己的调用方也对此设限。 */
const DRAIN_LIMIT_MS = 10_000
/** 收集作业结束的单次等待的运行时长；以作业仍在运行告终的等待之后会跟上下一次。 */
const COLLECT_WAIT_MS = 10 * 60_000

const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs') as Jobs | undefined
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('subagents') as Subagents | undefined
const running = (status: string) => status === 'running' || status === 'stopping'
/** Session 所拥有的仍在运行的作业，`except` 中的除外，例如留给人的那些。 */
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status) && !except?.has(job.id))
/** `work` 的结果；一旦 `signal` 中止或 `ms` 先到期则为 false。 */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/** 其子代理被停止操作取消了回合的 worker，其下一次空闲结束的是那次被取消的回合，而非它自己的一轮。 */
export const cancelled = new WeakSet<Agent>()
/** 每个 worker 子代理的进行中加入等待，DSH 无法取消它，因此之后的检查会复用同一次等待。 */
const joins = new WeakMap<Agent, Promise<boolean>>()
function childrenEnd(subagents: Subagents, agent: Agent): Promise<boolean> {
  let join = joins.get(agent)
  if (!join) {
    join = subagents.waitForChildren(agent).finally(() => { joins.delete(agent) })
    joins.set(agent, join)
  }
  return join
}

/** 用其 id 与 label 的第一行表示一个作业。 */
const named = (job: { id: string; label?: string }) => { const line = job.label?.split('\n')[0]?.trim(); return line ? `${job.id} (${line})` : job.id }
/** Session 所拥有的仍在运行的 shell 作业（`except` 中的除外），连同其名称。 */
export const runningJobs = (ctx: Context, sessionId: string, except?: ReadonlySet<string>): { id: string; name: string }[] => {
  const jobs = registry(ctx)
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : []
}

/**
 * 等待直到 Session 所拥有的 shell 作业都不再运行；没有任何作业在运行、或 `signal` 先中止时立即返回 false。
 * 这次等待不是任何作业的等待者，因此每个作业的结束仍会到达 worker。
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
    // 只有结束事件才能使作业不再运行；作业的输出不能。
    const unsubscribe = jobs.events.subscribe({ owner: sessionId }, event => {
      if ((event.type === 'settled' || event.type === 'removed') && !owned(jobs, sessionId, except).length) done(true)
    })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * 等待直到已空闲的 worker 再无任何东西在运行：其 shell 作业（`except` 中的除外）与其子代理。作业或
 * 子代理的结束会带着其结果唤醒 worker，从而结束本次检查：它所开启的那一轮以自己的空闲结束，
 * 那时会重新检查一次。
 * @returns 当全部结束且 worker 空闲时返回 true；当 worker 再次运行、或 `signal` 先中止时返回 false，
 * 例如宿主停止或检查时间已到。
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
 * 终止 Session 所拥有的 shell 作业（`except` 中的除外），并收集每个作业的结束，以免 worker 被唤醒去听取消息。
 * 一次失败不会阻止其余的终止。
 */
export async function killJobs(ctx: Context, sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId, except) : []
  const failures: unknown[] = []
  // 等待先于终止开始，因此每个结束都算作已收集。
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id, sessionId, reason) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * 收集 Session 所拥有的某个 shell 作业的结束，使它不唤醒任何人，直到 `signal` 中止。
 * @returns 作业结束后返回其名称与状态；`signal` 先中止时返回 undefined。
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
 * 在有限的时长内释放 worker 存活的子代理。DSH 会在释放返回之前把每个子代理的结束送达 worker，
 * 这会唤醒它，因此之后取消 worker 的回合（`keepInbox` 为真时保留其收件箱），停止操作
 * 随那一轮结束。其 Session 仍可接纳子代理。
 */
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return
  // 目录列出了该 Session 曾拥有的每个子代理；已结束的子代理没有对应的 agent。
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
 * 在 worker 的派工结束后停止其在后台运行的内容：终止其 shell 作业并释放其子代理（见
 * `stopSubagents`）。未加载的 Session 没有子代理在工作。一次失败不会阻止其余的停止。
 */
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
