/** Runtime 启动时排空先前版本已经排队的 effect，并对同名通知去重。 */
import { afterEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('drains effects a previous version queued, without dropping any of them', async () => {
  h = await startRuntime(store => {
    // 旧版本写入 schema 10 的队列；schema 11 迁移会把它们变成这里的 effect 行。
    const insert = store.db.prepare('INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?, ?, ?, ?, 0, \'\', ?, ?)')
    const at = Date.now(), since = new Date().toISOString()
    insert.run('relay', 'report:old', JSON.stringify({ text: JSON.stringify({ kind: 'worker_report', ticket_id: 't1', state: 'ready' }) }), 1, at, since)
    insert.run('notice', 'settings:pause', JSON.stringify({ value: { settings_saved: 'pause', changed: ['paused'], read: 'settings/pause' },
      summary: '设置已保存' }), 2, at, since)
  })
  await h.settle()
  // 启动时的 relay 可能先于通知被注入；再触发一次回合，使两条 effect 都已被消费。
  h.runtime.sessions.relay('r1', JSON.stringify({ kind: 'note' }))
  await h.settle()
  const prompts = h!.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === h!.runtime.masterId).map(call => call.text).join('\n')
  expect(prompts).toContain('"kind":"worker_report"')
  expect(prompts).toContain('"settings_saved":"pause"')
  expect(h.runtime.effects.pending('relay')).toBe(false)
  expect(h.runtime.effects.pending('notice')).toBe(false)
})

it('keeps only the latest settings notice while the main Session cannot take one', async () => {
  h = await startRuntime()
  expect(await h.runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  await h.runtime.settings.pause(false, 'panel')
  // 同名通知只保留最新一条，并且尚未被任何回合取走。
  expect(h.notices()).toEqual([{ settings_saved: 'pause', changed: ['paused'], read: 'settings/pause' }])
  h.runtime.sessions.relay('r1', JSON.stringify({ kind: 'note' }))
  await h.settle()
  expect(h.notices()).toEqual([])
})
