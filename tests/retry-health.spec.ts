import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { RetryHealth, type RetryHealthEvent } from '../src/app/retry-health.ts'

const epoch = Date.parse('2026-09-21T08:00:00Z')
const event = (type: string, seq: number, data: unknown): RetryHealthEvent => ({ type, seq, time: epoch + seq * 1000, data })
const retry = (seq: number, data: Record<string, unknown> = {}) => event('llm/retry', seq, {
  retryId: 'chain-a', turn: 1, step: 2, provider: 'provider-a', mode: 'always', retry: 1, policyKey: 'opaque', delayMs: 10000,
  failure: { code: 'INVALID_REQUEST', message: 'OpenAI API error (400): {"type":"budget_exceeded","message":"Budget has been exceeded! Current cost: 100, Max budget: 99","secret":"never disclose"}' }, ...data,
})
const success = (seq: number, turn = 1, step = 2, provider = 'provider-a'): SessionEvent<'assistant/message'> => ({
  type: 'assistant/message', seq: SessionSeq(seq), time: epoch + seq * 1000, surfaceOp: 'append',
  data: { turn, step, stream: [], message: createAssistantMessage({ content: [], source: { provider, model: 'test-model' } }) },
})

it('投影原生的重试调度，且不暴露失败文本或策略数据', () => {
  const health = new RetryHealth()
  health.observe('worker-a', retry(1))
  health.observe('worker-a', event('llm/retry-started', 2, { retryId: 'chain-a', turn: 1, step: 2, retry: 1 }))
  expect(health.get('worker-a')).toEqual({ sessionId: 'worker-a', provider: 'provider-a', attempts: 1, since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:01.000Z' })
  health.observe('worker-a', retry(3, { retry: 345 }))
  expect(health.get('worker-a')).toEqual({ sessionId: 'worker-a', provider: 'provider-a', attempts: 345, since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:03.000Z' })
  expect(JSON.stringify(health.list())).not.toMatch(/secret|Current cost|Max budget|policyKey|failure|chain-a/)
})

it.each([
  { type: 'budget_exceeded', message: 'provider omitted body', code: 'INVALID_REQUEST' },
  { code: 'budget_exceeded', message: 'provider omitted body' },
  { code: 'INVALID_REQUEST', message: '{"error":{"type":"budget_exceeded"}}' },
  { code: 'INVALID_REQUEST', message: 'Budget has been exceeded! Current cost: redacted' },
])('识别预算失败元数据或已知的提供方消息：%j', failure => {
  const health = new RetryHealth(); health.observe('master', retry(1, { failure }))
  expect(health.get('master')?.attempts).toBe(1)
})

it.each([
  { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' },
  { code: 'INVALID_REQUEST', status: 429, message: 'Budget has been exceeded!' },
  { code: 'AUTHENTICATION_ERROR', message: 'Budget has been exceeded!' },
  { code: 'INVALID_REQUEST', status: 401, message: 'Budget has been exceeded!' },
  { code: 'CONTEXT_LENGTH_EXCEEDED', message: 'Context budget has been exceeded!' },
  { code: 'INVALID_REQUEST', message: 'maximum context length exceeded' },
  { code: 'INVALID_REQUEST', message: 'a budget was mentioned in this error but was not exceeded' },
  null,
])('不把其他失败归类为预算等待：%j', failure => {
  const health = new RetryHealth(); health.observe('worker', retry(1, { failure }))
  expect(health.list()).toEqual([])
})

it('忽略引用的 assistant/user 文本以及没有安排重试的失败尝试', () => {
  const health = new RetryHealth()
  health.observe('worker', event('user/message', 1, { content: [{ type: 'text', text: 'Budget has been exceeded!' }] }))
  health.observe('worker', event('assistant/message', 2, { turn: 1, step: 2, message: { content: [{ type: 'text', text: '{"type":"budget_exceeded"}' }] } }))
  health.observe('worker', event('assistant/attempt', 3, { turn: 1, step: 2, failure: { type: 'budget_exceeded' } }))
  expect(health.list()).toEqual([])
})

it('各 Session 相互独立，新的提供方或重试链会开启全新状态', () => {
  const health = new RetryHealth()
  health.observe('a', retry(1, { retry: 12 })); health.observe('b', retry(1, { provider: 'provider-b' }))
  health.observe('a', retry(2, { provider: 'fallback', retry: 1 }))
  expect(health.get('a')).toMatchObject({ provider: 'fallback', attempts: 1, since: '2026-09-21T08:00:02.000Z' })
  health.observe('a', success(3)) // 旧提供方的输出不得清除当前的重试链。
  expect(health.get('a')?.provider).toBe('fallback')
  health.observe('a', retry(4, { provider: 'fallback', retryId: 'chain-b', retry: 1 }))
  expect(health.get('a')?.since).toBe('2026-09-21T08:00:04.000Z')
  health.observe('a', success(5, 1, 2, 'fallback'))
  expect(health.get('a')).toBeUndefined()
  expect(health.get('b')?.provider).toBe('provider-b')
})

it('重复、乱序或先前步骤的事件不能替换或清除当前等待', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(5, { step: 3, retry: 2 }))
  health.observe('worker', retry(5, { step: 3, retry: 99 }))
  health.observe('worker', success(4, 1, 3))
  health.observe('worker', success(6, 1, 2))
  health.observe('worker', retry(7, { step: 2, retry: 100 }))
  health.observe('worker', event('turn/end', 8, { turn: 0 }))
  health.observe('worker', retry(9, { step: 3, retry: 1 }))
  expect(health.get('worker')).toMatchObject({ attempts: 2, since: '2026-09-21T08:00:05.000Z', lastAt: '2026-09-21T08:00:05.000Z' })
  health.observe('worker', success(10, 1, 3))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(11, { step: 3, retry: 3 }))
  expect(health.get('worker')).toBeUndefined()
})

it('不把被中断的 assistant 输出当作成功', () => {
  const health = new RetryHealth(); health.observe('worker', retry(1))
  const interrupted = success(2)
  health.observe('worker', { ...interrupted, data: { ...interrupted.data, interrupted: true } })
  expect(health.get('worker')).toBeDefined()
  health.observe('worker', success(3))
  expect(health.get('worker')).toBeUndefined()
})

it('当前请求改为重试另一种失败时清除等待，重试开始时不清除', () => {
  const health = new RetryHealth(); health.observe('worker', retry(1))
  health.observe('worker', event('llm/retry-started', 2, { retryId: 'chain-a', turn: 1, step: 2, retry: 1 }))
  expect(health.get('worker')).toBeDefined()
  health.observe('worker', retry(3, { retry: 2, failure: { code: 'RATE_LIMIT', status: 429, message: 'Try later' } }))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(4, { retry: 3 }))
  expect(health.get('worker')?.since).toBe('2026-09-21T08:00:04.000Z')
})

it.each(['turn/end', 'turn/start', 'step/start', 'idle', 'disposed'])('在 %s 清除当前状态，迟到的事件不会使其复活', boundary => {
  const health = new RetryHealth(); health.observe('worker', retry(1))
  if (boundary === 'idle' || boundary === 'disposed') health.clear('worker')
  else health.observe('worker', event(boundary, 2, boundary === 'turn/start' ? { turn: 2 } : boundary === 'step/start' ? { turn: 1, step: 3 } : { turn: 1 }))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(3, { retry: 2 }))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(4, { turn: 3, step: 1 }))
  expect(health.get('worker')?.attempts).toBe(1)
})

it('从恢复的快照中只重建当前等待，并允许空闲清理', () => {
  const health = new RetryHealth()
  const history = [retry(1), success(2), event('step/start', 3, { turn: 1, step: 3 }), retry(4, { step: 3, retryId: 'chain-b' }), event('llm/retry-started', 5, { turn: 1, step: 3, retryId: 'chain-b', retry: 1 })]
  health.restore('worker', history)
  expect(health.get('worker')).toEqual({ sessionId: 'worker', provider: 'provider-a', attempts: 1, since: '2026-09-21T08:00:04.000Z', lastAt: '2026-09-21T08:00:04.000Z' })
  health.restore('worker', history)
  expect(health.list()).toHaveLength(1)
  health.restore('worker', [...history, event('turn/end', 6, { turn: 1 })])
  expect(health.list()).toEqual([])
  health.restore('worker', history); health.clear('worker')
  expect(health.list()).toEqual([])
})

it('限制计数与提供方标签的取值，只暴露脱离引用的状态值', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(1, { retry: Number.MAX_VALUE, provider: 'provider-a\nAuthorization: Bearer secret' }))
  expect(health.get('worker')).toMatchObject({ attempts: Number.MAX_SAFE_INTEGER, provider: 'unknown' })
  expect(JSON.stringify(health.list())).not.toContain('secret')
  const status = health.get('worker')!; status.provider = 'mutated'
  health.list()[0]!.attempts = 0
  expect(health.get('worker')).toMatchObject({ attempts: Number.MAX_SAFE_INTEGER, provider: 'unknown' })
})

it.each([NaN, Infinity, -1, 1.5])('忽略格式非法的重试次数 %s', attempts => {
  const health = new RetryHealth(); health.observe('worker', retry(1, { retry: attempts }))
  expect(health.list()).toEqual([])
})
