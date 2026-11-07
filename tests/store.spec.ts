import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { MemoryRepositories, key, type Assignment, type Decision, type Repositories, type Thread, type Ticket } from '../src/core/index.ts'
import { threadFacts } from '../src/app/views/records.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'


let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('拒绝比本构建更新的数据库，并回滚失败的原子操作', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  expect(() => store.atomic(() => { store.set('a', 1); throw new Error('boom') })).toThrow('boom')
  expect(store.get('a')).toBeUndefined()
  store.set('schema', SCHEMA_VERSION + 1); store.close()
  expect(() => new Store(path)).toThrow('Unsupported')
})
it('按线程查找触发', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.triggers.save({ id: 'a', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '2', text: 'later', meta: {} })
  store.triggers.save({ id: 'b', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }, { source: 'github', id: '3' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '1', text: 'earlier', meta: {} })
  store.triggers.save({ id: 'c', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_y_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '3', text: 'other', meta: {} })
  expect(store.read.threadTriggers('feishu:oc_1:om_%_x').map(trigger => trigger.id)).toEqual(['b', 'a'])
  expect(store.read.threadTriggers('github:3').map(trigger => trigger.id)).toEqual(['b'])
  // 再次保存一条触发会替换它能被找到的线程。
  store.triggers.save({ ...store.triggers.get('b')!, threads: [{ source: 'github', id: '3' }] })
  expect(store.read.threadTriggers('feishu:oc_1:om_%_x').map(trigger => trigger.id)).toEqual(['a'])
  expect(store.read.threadTriggers('github:3').map(trigger => trigger.id)).toEqual(['b'])
  expect(store.read.subscribedThreads()).toEqual([])
  store.close()
})
const ticket = (id: string, state: 'open' | 'ended', assignments: Pick<Assignment, 'state'>[], undelivered: string[] = []): Ticket => ({
  id, title: id, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
  channels: [], assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: '', ...item })), inputs: [],
  ...state === 'ended' ? { ended: { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } } : {},
  undelivered, createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] } })
const thread = (id: string, source: string, fields: Partial<Thread> = {}): Thread =>
  ({ key: `${source}:${id}`, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {}, ...fields })
const ids = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key).sort()
it('单独读取工作集，SQLite 与内存实现一致，并跟随每次保存', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const repo of [store, new MemoryRepositories()] as Repositories[]) {
    repo.tickets.save(ticket('running', 'open', [{ state: 'running' }]))
    // 重试或恢复会在已结束的派工之后追加一个 pending 派工。
    repo.tickets.save(ticket('queued', 'open', [{ state: 'ended' }, { state: 'pending' }]))
    // 用户消息到达但未恢复的已结束工单；schema 11 之前的版本把它留到下一次 pass 处理。
    repo.tickets.save(ticket('waking', 'ended', [{ state: 'ended' }], ['input']))
    repo.tickets.save(ticket('done', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github', { pending: ['a'] }))
    repo.threads.save(thread('2', 'github', { subscriptions: ['running'], evaluating: { id: 'e', threadKey: 'github:2', triggerIds: ['b'], strength: 'explicit',
      actor: { source: 'github', id: 'alice' }, basis: { via: 'followup' }, policyVersion: '', startedAt: '', deadline: '' } }))
    repo.threads.save(thread('oc:om', 'feishu', { subscriptions: ['done'] }))
    repo.threads.save(thread('3', 'github'))
    expect(ids(repo.tickets.open())).toEqual(['queued', 'running'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'running', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['github:1', 'github:2'])
    repo.tickets.save(ticket('running', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github'))
    expect(ids(repo.tickets.open())).toEqual(['queued'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['github:2'])
  }
  expect(ids(store.read.subscribedThreads())).toEqual(['feishu:oc:om', 'github:2'])
  expect(ids(store.read.subscribedThreads('github'))).toEqual(['github:2'])
  store.close()
})
it('根据已有行把工作集补充到尚无它们的数据库中', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  db.prepare('INSERT INTO ticket VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
  db.prepare('INSERT INTO thread VALUES (?,?)').run('github:1', JSON.stringify(thread('1', 'github', { pending: ['a'], subscriptions: ['t'] })))
  db.close()
  const store = new Store(path)
  expect([ids(store.tickets.open()), ids(store.tickets.active())]).toEqual([['t'], ['t']])
  expect([ids(store.threads.active()), ids(store.read.subscribedThreads('github'))]).toEqual([['github:1'], ['github:1']])
  store.close()
})
it('用第一条人类触发为线程命名', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const base = { source: 'github', threads: [{ source: 'github', id: '5' }], actor: { source: 'github', id: 'x' }, meta: {} }
  store.triggers.save({ ...base, id: 'ci', human: false, at: '1', text: 'GitHub PR #5 CI: {}' })
  store.triggers.save({ ...base, id: 'person', human: true, at: '2', text: 'please look' })
  expect(store.read.firstTrigger('github:5')?.id).toBe('ci')
  expect(store.read.firstTrigger('github:5', true)?.id).toBe('person')
  store.close()
})

it('按来源统计触发并从新到旧列出，可选只列被过滤的', () => {
  const store = new Store(join(directory, 'db.sqlite'))
  const trigger = (id: string, source: string, at: string) => ({ id, source, threads: [{ source, id: 'x' }], actor: { source, id: 'a' }, human: true, at, text: id, meta: {} })
  store.triggers.save(trigger('old', 'feishu', '2026-09-01T00:00:00Z'))
  store.triggers.save(trigger('kept', 'feishu', '2026-09-23T00:00:00Z'))
  store.triggers.save(trigger('dropped', 'feishu', '2026-09-23T01:00:00Z'))
  store.triggers.saveDisposition('dropped', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
  store.triggers.save(trigger('gh', 'github', '2026-09-22T00:00:00Z'))
  expect(store.read.triggerStats('2026-09-22T12:00:00Z')).toEqual({ feishu: { received: 2, filtered: 1, lastAt: '2026-09-23T01:00:00Z' }, github: { received: 0, filtered: 0, lastAt: '2026-09-22T00:00:00Z' } })
  expect(store.read.triggers({ source: 'feishu' }, 0, 2)).toEqual({ items: [expect.objectContaining({ id: 'dropped' }), expect.objectContaining({ id: 'kept' })], more: true })
  expect(store.read.triggers({ filtered: true }).items.map(item => item.id)).toEqual(['dropped'])
  store.close()
})

it('把线程链接到其来源指名的页面，否则链接到发起它的消息', () => {
  const store = new Store(join(directory, 'links.sqlite'))
  const thread = (keyValue: string, source: string, id: string, meta: Record<string, unknown> = {}) => store.threads.save({ key: keyValue, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta })
  thread('github:7', 'github', '7', { url: 'https://github.com/acme/widgets/pull/7' })
  thread('feishu:oc_1:om_1', 'feishu', 'oc_1:om_1')
  store.triggers.save({ id: 'f1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true, at: '1', text: 'hi', url: 'https://applink.feishu.cn/client/message/link/open?token=t', meta: {} })
  expect(threadFacts(store, store.threads.get('github:7')!).url).toBe('https://github.com/acme/widgets/pull/7')
  expect(threadFacts(store, store.threads.get('feishu:oc_1:om_1')!).url).toBe('https://applink.feishu.cn/client/message/link/open?token=t')
  store.close()
})

it('设置和移除线程 meta 中来源的键', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: { isPr: true, gone: true } })
  store.threads.patchMeta('github:5', { gone: undefined, title: 'Fix' })
  expect(store.threads.get('github:5')!.meta).toEqual({ isPr: true, title: 'Fix' })
  store.threads.patchMeta('github:6', { title: 'none' })
  expect(store.threads.get('github:6')).toBeUndefined()
  store.close()
})
it('kv 键只在 KV 中拼写一次，每条记录由其中的条目命名', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const entries = Object.values(KV).flatMap(group => Object.values(group) as (string | { prefix: string })[])
  // 忽略与无关字符串字面量撞名的单词键。
  const keys = entries.map(entry => typeof entry === 'string' ? entry : entry.prefix).filter(name => /[-:]/.test(name))
  const modules = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path) && !['kv.ts', join('app', 'migration.ts')].includes(path))
  const spelled = modules.flatMap(path => {
    const text = readFileSync(join(src, path), 'utf8')
    return keys.filter(name => text.includes(`'${name}`) || text.includes(`\`${name}`)).map(name => `${path}: ${name}`)
  })
  expect(spelled).toEqual([])
})

it('最外层事务提交后运行等待提交的回调，绝不运行已回滚事务排队的回调', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const ran: string[] = []
  store.atomic(() => {
    store.afterCommit(() => { ran.push('outer') })
    store.atomic(() => { store.afterCommit(() => { ran.push('inner') }) })
    expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('rolled back') }); throw new Error('boom') })).toThrow('boom')
    // 最外层事务提交之前什么都不运行。
    expect(ran).toEqual([])
  })
  expect(ran).toEqual(['outer', 'inner'])
  expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('failed') }); throw new Error('boom') })).toThrow('boom')
  store.afterCommit(() => { ran.push('outside') })
  expect(ran).toEqual(['outer', 'inner', 'outside'])
  store.close()
})

it('上报提交后失败的回调，运行其余回调，并保留已提交的内容', () => {
  const reported: unknown[] = []
  const store = new Store(join(directory, 'orchestrator.sqlite'), error => { reported.push(error) })
  const ran: string[] = []
  const value = store.atomic(() => {
    store.set(KV.runtime.masterId, 'm')
    store.afterCommit(() => { throw new Error('cancel failed') })
    store.afterCommit(() => { ran.push('next') })
    return 'done'
  })
  expect(value).toBe('done')
  expect(ran).toEqual(['next'])
  expect(reported).toEqual([new Error('cancel failed')])
  expect(store.get(KV.runtime.masterId)).toBe('m')
  store.close()
})

it('关闭无法按本版本打开的数据库，让之后的尝试可以再打开它', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  store.set(KV.store.schema, SCHEMA_VERSION + 1)
  store.close()
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  try {
    expect(() => new Store(path)).toThrow('Unsupported orchestrator database version')
    expect(close).toHaveBeenCalledOnce()
  } finally { close.mockRestore() }
})
it('把设置保存为版本：当前设置即当前修订的快照，不另存于别处', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  expect(store.settings()).toEqual(SettingsSchema.parse({}))
  store.saveSettings({ ...store.settings(), paused: true }, { source: 'panel', block: 'pause', policyVersion: 'v', policyChanged: false, notified: [] })
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 5 } })
  expect(store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  expect(store.settingsHistory().map(version => [version.revision, version.source])).toEqual([[2, 'internal'], [1, 'panel']])
  expect([store.get(KV.settings.revision), store.blockRevision('pause'), store.keys('settings').filter(name => name === 'settings')]).toEqual([2, 1, []])
  store.close()
})

it('替换早期构建以其他方式定义的工作集列，并删除本版本已不存在的列', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE ticket ADD COLUMN open INTEGER AS (CASE WHEN value ->> '$.state' = 'open' THEN 1 END);
    ALTER TABLE ticket ADD COLUMN ref TEXT AS (nullif(value ->> '$.assignments[#-1].ref', ''));
    CREATE INDEX ticket_open ON ticket(open) WHERE open IS NOT NULL; CREATE INDEX ticket_ref ON ticket(ref) WHERE ref IS NOT NULL`)
  db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  db.prepare('INSERT INTO ticket (id, value) VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
  db.close()
  const store = new Store(path)
  // open 集现在读取工单的结束状态。
  expect(ids(store.tickets.open())).toEqual(['t'])
  expect(store.db.prepare("SELECT name FROM pragma_table_xinfo('ticket') WHERE name = 'ref'").all()).toEqual([])
  store.close()
})

it('在 SQLite 与内存中以相同顺序列出，且两者的失败嵌套事务都只回滚自身', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const order = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key)
  const decision = (id: string): Decision => ({ id, evalId: '', threadKey: 'github:1', triggerIds: [], policyVersion: '', at: id, kind: 'ignore', reason: [],
    strength: 'explicit' })
  const run = (repo: Repositories) => {
    repo.tickets.save(ticket('first', 'open', [{ state: 'running' }]))
    repo.tickets.save(ticket('second', 'ended', [{ state: 'ended' }]))
    repo.tickets.save(ticket('third', 'open', [{ state: 'pending' }]))
    // 再次保存工单保持其原有位置。
    repo.tickets.save({ ...repo.tickets.get('first')!, title: 'again' })
    repo.threads.save(thread('1', 'github', { pending: ['a'] })); repo.threads.save(thread('2', 'github')); repo.threads.save(thread('3', 'github', { pending: ['b'] }))
    repo.decisions.save(decision('d2'))
    repo.decisions.save(decision('d1'))
    // 失败的嵌套事务回滚它自己的写入；包裹它的事务继续进行并保留自己的写入。
    repo.atomic(() => {
      repo.tickets.save(ticket('outer', 'open', []))
      expect(() => repo.atomic(() => { repo.tickets.save(ticket('inner', 'open', [])); throw new Error('boom') })).toThrow('boom')
    })
    return { tickets: order(repo.tickets.list()), open: order(repo.tickets.open()), active: order(repo.tickets.active()), threads: order(repo.threads.list()),
      activeThreads: order(repo.threads.active()), decisions: order(repo.decisions.byThread('github:1')) }
  }
  const memory = run(new MemoryRepositories())
  expect(memory).toEqual({ tickets: ['outer', 'third', 'second', 'first'], open: ['outer', 'third', 'first'], active: ['third', 'first'],
    threads: ['github:1', 'github:2', 'github:3'], activeThreads: ['github:1', 'github:3'], decisions: ['d2', 'd1'] })
  expect(run(store)).toEqual(memory)
  store.close()
})

it('创建仅属主可访问的状态目录，以及仅属主可读的数据库', () => {
  const path = join(directory, 'state', 'orchestrator.sqlite')
  new Store(path).close()
  // POSIX 权限位在 Windows 上无意义；在那里只检查 Store 创建了两者。
  if (process.platform !== 'win32') expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600])
  expect(existsSync(path)).toBe(true)
})

it('键前缀与搜索查询中的 `%` 和 `_` 按字面读取，不当作通配模式', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const name of ['a%b', 'axb', 'a_c', 'abc']) store.set(name, 1)
  expect([store.keys('a%').sort(), store.keys('a_').sort()]).toEqual([['a%b'], ['a_c']])
  const said = (id: string, text: string) => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'u' },
    human: true, at: '2026-10-01T00:00:00.000Z', text, meta: {} })
  for (const [id, text] of [['p', 'grew 50% today'], ['q', 'grew 500 today'], ['r', 'see a_b'], ['s', 'see axb']]) store.triggers.save(said(id!, text!))
  expect([store.read.search('50%').map(item => item.id), store.read.search('a_b').map(item => item.id)]).toEqual([['p'], ['r']])
  store.close()
})
