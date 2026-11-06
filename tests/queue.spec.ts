/** Runtime 上的效果队列迁移与通知去重。 */
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const text = (message: unknown) => JSON.parse((message as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
const notices = (host: Host) => host.agents.get(host.runtime.masterId)!.inject.mock.calls.map(([message]) => text(message))

it('delivers the relays, subscription changes and notifications that a version before the effect queue kept, once the migration queued them', async () => {
  h = await startRuntime(store => {
    // 一个 schema 10 的数据库；Runtime 打开它时，schema 11 迁移会将其升级到最新。
    store.set('schema', 10)
    store.set('relay-queue', [{ id: 'report:old', text: JSON.stringify({ kind: 'worker_report', ticket_id: 't1', state: 'ready' }) }])
    store.set('subscription-results', ['github:7'])
    store.set('prompt-notification', 3)
    store.set('settings-notification', 5)
  })
  await h.runtime.idle()
  const steered = h.agents.get(h.runtime.masterId)!.steer.mock.calls.map(([message]) => text(message))
  expect(steered).toEqual([{ kind: 'worker_report', ticket_id: 't1', state: 'ready' }])
  expect(notices(h)).toEqual(expect.arrayContaining([{ subscription_changes: [{ thread: 'github:7', removed: true }] },
    { prompt_config_saved: 3, effect: 'next-request', read: 'prompts/3' }, { settings_saved: true, read: 'settings' }]))
  for (const name of ['relay-queue', 'subscription-results', 'prompt-notification', 'settings-notification']) expect(h.runtime.store.get(name)).toBeUndefined()
  expect(h.runtime.effects.pending('relay') || h.runtime.effects.pending('notice')).toBe(false)
})

it('keeps only the latest settings notice while the main Session cannot take one', async () => {
  h = await startRuntime()
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockImplementation(() => { throw new Error('session busy') })
  expect(await h.runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  await h.runtime.settings.pause(false, 'panel')
  expect(h.runtime.effects.pending('notice', 'settings:pause')).toBe(true)
  inject.mockReset()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(notices(h)).toEqual([{ settings_saved: 'pause', changed: ['paused'], read: 'settings/pause' }])
})
