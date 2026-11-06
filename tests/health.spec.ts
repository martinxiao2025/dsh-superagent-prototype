/** Runtime 健康上报：各组件各自的错误状态，以及随后成功时的恢复。 */
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
/** 重试失败的效果直到其连续失败三次，此后该 kind 会上报错误。 */
async function failThrice() { await at(2000); await at(6000) }

it('reports a relay in error once it failed three times, clears it once the relay reached the main Session, and leaves the runtime ready', async () => {
  const steer = h.agents.get(h.runtime.masterId)!.steer
  for (let count = 0; count < 3; count++) steer.mockImplementationOnce(() => { throw new Error('session busy') })
  h.runtime.sessions.relay('r1', JSON.stringify({ kind: 'note' }))
  await h.runtime.idle()
  expect(h.runtime.health.relay).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
  await failThrice()
  expect(h.runtime.health.relay).toMatchObject({ state: 'error', detail: expect.stringContaining('session busy') })
  await at(14_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'ready', detail: 'Nothing waiting' }, runtime: { state: 'ready' } })
})

it('keeps a failing relay\'s error while replies recover, and a failing reply\'s error while relays recover', async () => {
  const master = h.agents.get(h.runtime.masterId)!
  const lark = vi.mocked(Commands.prototype.lark)
  const reply = (id: string) => { h.runtime.outbox.send({ id, channel: feishu('9', 'x').channel!, text: '已合并。', kind: 'notice' }) }
  master.steer.mockImplementation(() => { throw new Error('master gone') })
  h.runtime.sessions.relay('r2', JSON.stringify({ kind: 'note' }))
  lark.mockRejectedValue(new Error('internal error (2200)'))
  reply('stuck')
  // 两者都连续失败三次：relay 在 0、2、6 秒后，reply 在 0、5、15 秒后。
  await h.runtime.idle(); await at(5000); await at(15_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'error' }, reply: { state: 'error', detail: expect.stringContaining('2200') } })
  lark.mockResolvedValue({})
  await at(35_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'error' }, reply: { state: 'ready' } })
  lark.mockRejectedValue(new Error('internal error (2200)'))
  reply('stuck-2')
  master.steer.mockImplementation(() => {})
  await h.runtime.idle(); await at(50_000); await at(70_000)
  expect(h.runtime.health).toMatchObject({ relay: { state: 'ready' }, reply: { state: 'error' }, runtime: { state: 'ready' } })
})

it('reports a notice the main Session did not receive three times, until one reaches it, and injects each notice once', async () => {
  const inject = h.agents.get(h.runtime.masterId)!.inject
  for (let count = 0; count < 3; count++) inject.mockImplementationOnce(() => { throw new Error('session busy') })
  await h.runtime.settings.pause(true, 'panel')
  await failThrice()
  expect(h.runtime.health.notice).toMatchObject({ state: 'error', detail: expect.stringContaining('session busy') })
  inject.mockClear()
  await h.runtime.settings.pause(false, 'panel')
  expect(h.runtime.health).toMatchObject({ notice: { state: 'ready' }, runtime: { state: 'ready' } })
  // 等待中的 pause 通知被 resume 值就地更新，并且只注入一次。
  expect(inject).toHaveBeenCalledOnce()
})
