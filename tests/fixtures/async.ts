/** 供测试使用的异步协调辅助工具。 */
import { vi } from 'vitest'

/** 创建一个可从外部解决（resolve）的 promise。 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
/** 在不进行 await 的情况下观察一个 promise 是否已落定。 */
export function track<T>(promise: Promise<T>) {
  const state = { settled: false, error: undefined as unknown, promise }
  promise.then(() => { state.settled = true }, (error: unknown) => { state.settled = true; state.error = error })
  return state
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const waitUntil = (check: () => boolean, timeout = 3000) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout, interval: 2 })
