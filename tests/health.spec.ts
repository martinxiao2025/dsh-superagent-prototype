/** Runtime 健康上报：主会话回合失败、回复重试与通知注入，以及随后成功时的恢复。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** 将伪造的 `Date.now()` 前进 `ms`，并驱动到期的运行时工作。 */
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
}

it('reports a failed main-session turn in the models entry and clears it on the next successful turn', async () => {
  h.host.hold()
  h.runtime.sessions.relay('r1', JSON.stringify({ kind: 'note' }))
  await vi.waitFor(() => { expect(h!.host.requests.some(item => item.sessionId === h!.runtime.masterId)).toBe(true) })
  h.host.fail(h.runtime.masterId, '模型不可用')
  await vi.waitFor(() => { expect(h!.runtime.health.models).toMatchObject({ state: 'error', detail: expect.stringContaining('模型不可用') }) })
  // 主会话回合失败不影响运行时本身。
  expect(h.runtime.health.runtime).toMatchObject({ state: 'ready' })
  h.host.auto = true
  h.runtime.sessions.relay('r2', JSON.stringify({ kind: 'note' }))
  await h.settle()
  expect(h.runtime.health).toMatchObject({ models: { state: 'ready' }, runtime: { state: 'ready' } })
})

it('keeps a failing reply in error until its channel recovers, then sends it', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockRejectedValue(new Error('internal error (2200)'))
  h.runtime.outbox.send({ id: 'stuck', channel: feishu('9', 'x').channel!, text: '已合并。', kind: 'notice' })
  // 重试在 0、5、15 秒后发生；连续三次失败后该 kind 上报错误。
  await h.runtime.idle(); await at(5000); await at(15_000)
  expect(h.runtime.health.reply).toMatchObject({ state: 'error', detail: expect.stringContaining('2200') })
  lark.mockResolvedValue({})
  await at(35_000)
  expect(h.runtime.health).toMatchObject({ reply: { state: 'ready' }, runtime: { state: 'ready' } })
})

it('injects the latest of same-named notices once into the next main-session prompt', async () => {
  h.deliveries.mockClear()
  h.runtime.sessions.notify('same', { note: 'first' }, '摘要一')
  h.runtime.sessions.notify('same', { note: 'second' }, '摘要二')
  await h.runtime.effects.idle('notice')
  h.runtime.sessions.relay('r3', JSON.stringify({ kind: 'note' }))
  await h.settle()
  const prompts = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === h.runtime.masterId).map(call => call.text)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('[未读通知]')
  expect(prompts[0]).toContain('"note":"second"')
  expect(prompts[0]).not.toContain('"note":"first"')
})
