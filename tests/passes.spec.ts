/** pass 的调度、合并与运行时健康上报。 */
import { expect, it, vi } from 'vitest'
import { Passes } from '../src/app/passes.ts'
import type { Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'

function passes(closing = () => false) {
  const health = new HealthBoard().claim('runtime', { state: 'starting', detail: '' })
  const engine = { receive: vi.fn(() => 'stored' as const), evaluateDue: vi.fn() }
  const effects = { kick: vi.fn(), idle: vi.fn(async () => {}) }
  const value = new Passes({ engine, effects, health, lifetime: new AbortController().signal, configured: () => true, closing })
  return { passes: value, engine, effects, health }
}
const trigger = { id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
  at: '2026-10-01T00:00:00.000Z', text: 'hi', meta: {} } as Trigger

it('把失败的 pass 上报为运行时错误，下一个成功的 pass 会将其清除', async () => {
  const h = passes()
  h.engine.evaluateDue.mockImplementationOnce(() => { throw new Error('database is locked') })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'error', detail: 'A pass failed: Error: database is locked' })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'ready', detail: 'Orchestrator is ready' })
})

it('把 pass 期间新请求的 pass 合并为它结束后的一次 pass 运行', async () => {
  const h = passes()
  await Promise.all([h.passes.pump(), h.passes.pump(), h.passes.pump(), h.passes.pump()])
  expect([h.engine.evaluateDue.mock.calls.length, h.effects.kick.mock.calls.length]).toEqual([2, 2])
  await h.passes.pump()
  expect(h.engine.evaluateDue).toHaveBeenCalledTimes(3)
})

it('dsh-superagent-cn 停止时在 Engine 存入任何内容前拒绝 Trigger，对已存入的 Trigger 启动 pass', async () => {
  let closing = true
  const h = passes(() => closing)
  expect(() => h.passes.receive(trigger)).toThrow('Orchestrator is stopping')
  expect(h.engine.receive).not.toHaveBeenCalled()
  closing = false
  expect(h.passes.receive(trigger)).toBe('stored')
  await h.passes.idle()
  expect(h.engine.evaluateDue).toHaveBeenCalledOnce()
})

it('停止后再启动也不启动定时器——停止之后才结束的启动应如此', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const h = passes()
    await h.passes.stop()
    h.passes.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.engine.evaluateDue).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
