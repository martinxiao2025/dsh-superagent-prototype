import { expect, it } from 'vitest'
import { TextCache } from '../src/app/cache.ts'

it('超过上限时丢弃最久未使用的文本，但绝不丢弃刚设置的文本', () => {
  const cache = new TextCache(10)
  cache.set('a', 'aaaa'); cache.set('b', 'bbbb')
  expect(cache.get('a')).toBe('aaaa')
  cache.set('c', 'cccc')
  // 读取 `a` 使 `b` 成为最久未使用的。
  expect([...cache.entries()]).toEqual([['a', 'aaaa'], ['c', 'cccc']])
  cache.set('a', 'a')
  expect([...cache.entries()]).toEqual([['c', 'cccc'], ['a', 'a']])
  cache.set('big', 'x'.repeat(20))
  expect([...cache.entries()]).toEqual([['big', 'x'.repeat(20)]])
  expect(cache.get('c')).toBeUndefined()
})
