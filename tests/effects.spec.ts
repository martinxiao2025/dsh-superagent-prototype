/** 持久化效果队列：合并、按种类的限额、带退避的重试、健康状态与停机。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects, Later } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { deferred } from './fixtures/async.ts'

let directory: string
let store: Store
let clock: number
let board: HealthBoard
let health: Readonly<Record<string, unknown>>
let effects: Effects
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'effects-'))
  store = new Store(join(directory, 'db.sqlite'))
  clock = Date.parse('2026-09-09T00:00:00Z')
  board = new HealthBoard()
  health = board.all
  effects = new Effects(store, board, () => clock)
  effects.start()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const relay = (text: string) => ({ text })

it('事务提交后立即运行其中排队的效果，回滚的事务则一个也不运行', async () => {
  const run = vi.fn(async () => {})
  effects.handle('relay', run)
  store.atomic(() => { effects.enqueue('relay', 'kept', relay('a')) })
  expect(() => store.atomic(() => { effects.enqueue('relay', 'dropped', relay('b')); throw new Error('rolled back') })).toThrow('rolled back')
  await effects.idle()
  expect(run.mock.calls).toEqual([[relay('a'), 'kept']])
  expect(effects.pending('relay')).toBe(false)
})

it('每个键只保留一个效果及其最新载荷，运行中到达新载荷时会再次运行', async () => {
  const hold = deferred()
  const run = vi.fn(async (payload: { text: string }) => { if (payload.text === 'first') await hold.promise })
  effects.handle('relay', run)
  effects.enqueue('relay', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  effects.enqueue('relay', 'k', relay('second')); effects.enqueue('relay', 'k', relay('third'))
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'third'])
})

it('一种效果按最旧优先运行，并发数不超过其限额，限额为 0 时保持暂停', async () => {
  const holds = new Map<string, ReturnType<typeof deferred<void>>>()
  let limit = 2
  const run = vi.fn(async (_payload: unknown, key: string) => { const hold = deferred(); holds.set(key, hold); await hold.promise })
  effects.handle('launch', run, { limit: () => limit })
  for (const key of ['a', 'b', 'c']) effects.enqueue('launch', key, { ticketId: key, assignmentId: key })
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b']))
  limit = 0
  holds.get('a')!.resolve()
  await vi.waitFor(() => expect(effects.pending('launch', 'a')).toBe(false))
  effects.kick(); await Promise.resolve()
  expect(run).toHaveBeenCalledTimes(2)
  limit = 2
  holds.get('b')!.resolve()
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b', 'c']))
  holds.get('c')!.resolve()
  await effects.idle()
})

it('效果带新载荷再次排队时保持其在队列中的位置', async () => {
  const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
  let room = 0
  effects.handle('launch', run, { limit: () => room })
  store.atomic(() => {
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
    effects.enqueue('launch', 'second', { ticketId: 't2', assignmentId: 'a2' })
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
  })
  await effects.idle()
  room = 1
  await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second'])
})

it('以最多翻倍到上限的延迟重试失败的效果，三次失败后将该种类报为 error', async () => {
  let fail = true
  const run = vi.fn(async () => { if (fail) throw new Error('session busy') })
  effects.handle('notice', run, { retry: [1000, 3000] })
  effects.enqueue('notice', 'prompts', { value: { prompt_config_saved: 2 }, summary: 'Prompt configuration saved' })
  await effects.idle()
  expect(health.notice).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  for (const wait of [1000, 2000, 3000, 3000]) {
    clock += wait - 1; await effects.idle()
    const calls = run.mock.calls.length
    clock += 1; await effects.idle()
    expect(run).toHaveBeenCalledTimes(calls + 1)
    if (wait === 2000) expect(health.notice).toMatchObject({ state: 'error', detail: expect.stringContaining('1 waiting since 2026-09-09T00:00:00.000Z; the last failure: Error: session busy') })
  }
  fail = false
  clock += 3000; await effects.idle()
  expect(health.notice).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  expect(effects.pending('notice')).toBe(false)
})

it('drain 之后不再启动任何效果，保留等待中的与被停机打断的，并在下次启动后运行它们', async () => {
  const hold = deferred()
  effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') })
  effects.enqueue('relay', 'cut', relay('a'))
  await vi.waitFor(() => expect(effects.pending('relay', 'cut')).toBe(true))
  await Promise.resolve()
  const drained = effects.drain()
  effects.enqueue('relay', 'later', relay('b'))
  hold.resolve(); await drained
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.start()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => {})
  next.handle('relay', run)
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['cut', 'later'])
})

it('允许处理器在不视为失败的情况下推迟一个效果，在其首次延迟之后的后续派发再运行', async () => {
  let later = true
  const run = vi.fn(async () => { if (later) throw new Later('paused') })
  effects.handle('launch', run, { retry: [5000, 60_000] })
  effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' })
  await effects.idle()
  expect(health.launch).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  later = false
  clock += 4999; await effects.idle()
  expect(run).toHaveBeenCalledOnce()
  clock += 1; await effects.idle()
  expect(run).toHaveBeenCalledTimes(2)
  expect(effects.pending('launch')).toBe(false)
})

it('有序种类按排队顺序逐个运行，前一个失败时暂缓后面的效果', async () => {
  const failing = new Set(['first'])
  const run = vi.fn(async (_payload: { text: string }, key: string) => { if (failing.has(key)) throw new Error('offline') })
  effects.handle('relay', run, { ordered: true, limit: () => 4, retry: [1000, 1000] })
  effects.enqueue('relay', 'first', relay('a')); effects.enqueue('relay', 'second', relay('b'))
  await effects.idle()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first'])
  failing.clear()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first', 'first', 'second'])
})

it('安静（quiet）种类的失败不计入其健康状态，没有到期内容时不询问限额', async () => {
  const limit = vi.fn(() => 4)
  effects.handle('delivery', async () => { throw new Error('Session gone') }, { quiet: true, limit, retry: [1000, 1000] })
  effects.kick(); await effects.idle()
  expect(limit).not.toHaveBeenCalled()
  effects.enqueue('delivery', 't', { ticketId: 't' })
  for (let attempt = 0; attempt < 4; attempt++) { await effects.idle(); clock += 1000 }
  expect(health.delivery).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
})

it('效果的首次运行仍在进行时，取消并重新排队的效果会被保留，且首次运行不会终止它', async () => {
  const hold = deferred<void>()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => { if (run.mock.calls.length === 1) await hold.promise })
  effects.handle('relay', run)
  effects.enqueue('relay', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  effects.cancel('relay', 'k')
  effects.enqueue('relay', 'k', relay('second'))
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'second'])
  expect(effects.pending('relay')).toBe(false)
})

it('重启后把效果排在等待者之后，适用于保持顺序的种类', async () => {
  const hold = deferred<void>()
  effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') }, { ordered: true })
  effects.enqueue('relay', 'first', relay('a'))
  effects.enqueue('relay', 'second', relay('b'))
  await vi.waitFor(() => expect(effects.pending('relay', 'first')).toBe(true))
  const drained = effects.drain()
  hold.resolve(); await drained
  // 序号在重启后延续，因此新排队的效果会排在既有待运行效果之后。
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.enqueue('relay', 'third', relay('c'))
  next.start()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => {})
  next.handle('relay', run, { ordered: true })
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second', 'third'])
})

it('把队列自身的失败报告在该种类之下，直到该种类的派发再次成功', async () => {
  let broken = true
  effects.handle('relay', async () => {}, { limit: () => { if (broken) throw new Error('database is locked'); return 1 } })
  effects.enqueue('relay', 'k', relay('a'))
  await effects.idle()
  expect(health.relay).toMatchObject({ state: 'error', detail: 'The effect queue failed: Error: database is locked' })
  broken = false
  effects.kick()
  await effects.idle()
  expect(health.relay).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
})

it('拒绝为一种效果注册第二个处理器', () => {
  effects.handle('relay', async () => {})
  expect(() => effects.handle('relay', async () => {})).toThrow('The relay effects already have a handler')
})
