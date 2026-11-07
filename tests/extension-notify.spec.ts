/**
 * 扩展主动通知的纯逻辑：首次轮询只建立基线、只有新工单才提醒、离开后再次进入会重新提醒，
 * 以及提醒文案与回环地址校验。这里不加载 `vscode`，因此可以在普通 Node 环境直接验证。
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { decide, prompt, loopbackUrl } = require('../extension/dsh-lm-bridge/notify.js') as {
  decide: (previous: readonly string[] | undefined, person: readonly { id: string; title?: string }[]) =>
    { notify: boolean; ids: string[]; fresh: { id: string; title?: string }[] }
  prompt: (fresh: readonly { id: string; title?: string }[]) => { message: string; action: string }
  loopbackUrl: (value: string) => string | undefined
}

describe('扩展主动通知', () => {
  it('首次轮询只建立基线，不把历史积压当成新工作', () => {
    const result = decide(undefined, [{ id: 't1', title: '补测试' }, { id: 't2' }])
    expect(result).toEqual({ notify: false, ids: ['t1', 't2'], fresh: [{ id: 't1', title: '补测试' }, { id: 't2' }] })
  })
  it('只有出现此前没见过的工单才提醒一次', () => {
    expect(decide(['t1'], [{ id: 't1', title: '补测试' }])).toMatchObject({ notify: false, ids: ['t1'], fresh: [] })
    expect(decide(['t1'], [{ id: 't1' }, { id: 't2', title: '修文案' }])).toMatchObject(
      { notify: true, ids: ['t1', 't2'], fresh: [{ id: 't2', title: '修文案' }] })
  })
  it('工单离开等待列表后再次进入时重新提醒', () => {
    const empty = decide(['t1'], [])
    expect(empty).toEqual({ notify: false, ids: [], fresh: [] })
    expect(decide(empty.ids, [{ id: 't1' }])).toMatchObject({ notify: true, ids: ['t1'] })
  })
  it('提醒文案优先用标题，超过三个时补数量', () => {
    expect(prompt([{ id: 't1', title: '补测试' }, { id: 't2' }])).toEqual(
      { message: 'dsh-superagent：补测试、t2 等待你处理', action: '打开面板' })
    expect(prompt([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]).message)
      .toBe('dsh-superagent：a、b、c 等 4 个 等待你处理')
  })
  it('面板地址只接受回环 http', () => {
    expect(loopbackUrl('http://127.0.0.1:3082')).toBe('http://127.0.0.1:3082')
    expect(loopbackUrl('http://localhost:3082/orchestrator')).toBe('http://localhost:3082')
    expect(loopbackUrl('https://127.0.0.1:3082')).toBeUndefined()
    expect(loopbackUrl('http://example.com:3082')).toBeUndefined()
    expect(loopbackUrl('不是地址')).toBeUndefined()
  })
})
