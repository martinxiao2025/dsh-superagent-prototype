/** 线程时间线的分页、相邻项查找与时间戳规范化。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Engine, type ChannelRef, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { githubKind } from '../src/sources/github.ts'
import { githubLink } from '../src/sources/github-channel.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-cn-timeline-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(githubKind)
const host = () => ({ store, sources, links: (channel: ChannelRef) => githubLink(channel.address, {}) })
const engine = () => new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(SettingsSchema.parse({}), sources),
  assessor: { request: () => {} }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
  outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
const comment = (id: string, at: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'alice' },
  human: true, at, text: `comment ${id}`, meta: {} })
const saveThread = () => store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
  meta: {} })
const ids = (detail: ReturnType<typeof threadDetail>) => detail!.timeline.map(item => item.id)

it('先按时间再按 id 对线程分页，与某页最旧条目同秒的触发会出现在下一页', () => {
  saveThread()
  for (const item of [comment('a', '2026-10-01T00:00:00.000Z'), comment('b', '2026-10-01T00:00:01.000Z'), comment('c', '2026-10-01T00:00:01.000Z')]) store.triggers.save(item)
  const first = threadDetail(host(), 'github:7', undefined, 1)!
  const second = threadDetail(host(), 'github:7', first.earlier!, 1)!
  const third = threadDetail(host(), 'github:7', second.earlier!, 1)!
  expect([ids(first), ids(second), ids(third), third.earlier]).toEqual([['c'], ['b'], ['a'], null])
  // 旧式的纯时间戳游标仍然在该时间戳之前分页。
  expect(ids(threadDetail(host(), 'github:7', '2026-10-01T00:00:01.000Z', 5))).toEqual(['a'])
})

it('围绕 GitHub 评论展示所在页并包含该评论，尽管 GitHub 记录的时间精确到整秒', () => {
  // 按字典序，`...:00Z` 会排在 `...:00.001Z` 之后，除非规范化到毫秒。
  const taking = engine()
  for (const item of [comment('old', '2026-10-01T00:00:00Z'), comment('new', '2026-10-01T00:00:00.500Z'), comment('newest', '2026-10-01T00:00:01Z')]) {
    taking.receive(item)
  }
  expect(ids(threadDetail(host(), 'github:7', undefined, 50, 'old'))).toEqual(['old'])
  expect(ids(threadDetail(host(), 'github:7', undefined, 50, 'new'))).toEqual(['old', 'new'])
})

it('在同一时间的触发之间找到某条触发的前一项与后一项', () => {
  for (const item of [comment('a', '2026-10-01T00:00:01.000Z'), comment('b', '2026-10-01T00:00:01.000Z'), comment('c', '2026-10-01T00:00:01.000Z')]) store.triggers.save(item)
  const around = store.read.neighbours('github:7', '2026-10-01T00:00:01.000Z', 'b')
  expect([around.before?.id, around.after?.id]).toEqual(['a', 'c'])
})

it('把每条收到的触发的时间统一存储为既定格式', () => {
  engine().receive(comment('raw', '2026-10-01T08:00:00+08:00'))
  expect(store.triggers.get('raw')?.at).toBe('2026-10-01T00:00:00.000Z')
  expect(store.read.threadTriggers('github:7').map(item => item.at)).toEqual(['2026-10-01T00:00:00.000Z'])
})
