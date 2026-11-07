import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { basisOf, reasonsOf, withoutCopies } from '../src/app/migration.ts'
import { Prompts, composePrompt, defaultPrompts } from '../src/app/prompts.ts'
import { masterPrompt } from '../src/app/context.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-migration-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** 按 schema 10 布局种入一个 SQLite 数据库（包括遗留的 `outbox.sent` 列与 `inbox` 表）。 */
function schema10(path: string, records: Record<string, unknown>, rows: { ticket?: object[]; decision?: object[]; thread?: object[]; trigger?: object[] } = {}): void {
  new Store(path).close()
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE outbox; CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)')
  const set = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  set('schema', 10)
  for (const [name, value] of Object.entries(records)) set(name, value)
  for (const ticket of rows.ticket ?? []) db.prepare('INSERT INTO ticket VALUES (?,?)').run((ticket as { id: string }).id, JSON.stringify(ticket))
  for (const decision of rows.decision ?? []) {
    const { id, threadKey } = decision as { id: string; threadKey: string }
    db.prepare('INSERT INTO decision VALUES (?,?,?)').run(id, threadKey, JSON.stringify(decision))
  }
  for (const thread of rows.thread ?? []) db.prepare('INSERT INTO thread VALUES (?,?)').run((thread as { key: string }).key, JSON.stringify(thread))
  for (const trigger of rows.trigger ?? []) {
    const { id, at } = trigger as { id: string; at: string }
    db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(id, JSON.stringify(trigger), at)
  }
  db.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
}
const actor = { source: 'feishu', id: 'ou_alice' }
const mandate = (basis: object) => ({ strength: 'explicit', policyVersion: 'v1', basis, actor, scope: 'small' })

it('拒绝早于 schema 10 的数据库，并要求新的状态目录', () => {
  const path = join(directory, 'db.sqlite')
  new Store(path).close()
  const schema = (version: number) => { const db = new DatabaseSync(path); db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(version)); db.close() }
  schema(9)
  expect(() => new Store(path)).toThrow(/schema 9 predates schema 10, which this version cannot migrate; start with a new state directory/)
})

it('把 schema 10 数据库一次性写成当前形状，使任何东西都不读旧形状', () => {
  const path = join(directory, 'db.sqlite')
  const ticket = {
    id: 't1', title: 'Fix', decisionId: 'd1', state: 'open', assignments: [], summary: '', createdAt: '1', updatedAt: '2',
    // 在 schema 10 中，没有评论链接的 GitHub 渠道标记工单开启的 PR。
    channels: [{ source: 'github', thread: 'github:8', address: { number: '8' } }, { source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    mandate: mandate({ chatId: 'oc_team', direct: false, member: 'ou_alice', mention: true }),
    inputs: [{ id: 'i1', kind: 'reopen', decisionId: 'd2', at: '3' }, { id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' },
      { id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4' }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }], undelivered: ['i1'],
    meta: { sourceTriggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.',
      prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', branch: 'agent/fix-1', deliveryError: 'offline', recovery: 2, worktreeName: 'fix', scope: 'small' },
  }
  const imported = { ...ticket, id: 't2', state: 'ended', channels: [], inputs: [], undelivered: [], mandate: mandate({ legacyAuthority: 'thread_followup', followup: true }),
    meta: { sourceTriggerId: 'old', workspace: '/w/task-2', sessionId: 'worker-task-2', legacyPrompt: 'Read event/old' },
    ended: { at: '6', by: 'executor', reason: 'merged' } }
  // 结束时还有人的消息在等待，且没有 execution 与来源触发。
  const waiting = { ...ticket, id: 't3', state: 'ended', channels: [], ended: { at: '6', by: 'human', reason: 'Not needed' }, inputs: [{ id: 'i5', kind: 'trigger', triggerId: 'trig-2', at: '7' }],
    undelivered: ['i5'], mandate: mandate({ chatId: 'p2p', direct: true, member: 'ou_alice' }), meta: {} }
  const bare = { ...ticket, id: 't4', channels: [], inputs: [], undelivered: [], meta: undefined }
  const reopened = { id: 'd2', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'reopen', reason: 'follow-up', at: '3', ticketId: 't1', policyVersion: 'v1' }
  const unavailable = { id: 'd3', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'unavailable', reason: 'Assessment timed out', at: '5', policyVersion: 'v1' }
  const triggers = [{ id: 'trig-2', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '4', text: 'more', meta: {} },
    { id: 'ci-1', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'ci' }, human: false, at: '5', text: 'CI', meta: {} }]
  const decision = { id: 'd1', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-1'], kind: 'accept', reason: '', at: '1', ticketId: 't1', policyVersion: 'v1',
    mandate: mandate({ legacyAuthority: 'proactive_rule', observation: true, rules: ['copy'] }) }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['x'], strength: 'inferred', actor, policyVersion: 'v1', startedAt: '', deadline: '',
    basis: { source: 'github', scope: { number: 5 }, row: 'issues', admission: 'listedUnaddressed', observation: true, mode: 'auto' } }
  const thread = { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }
  schema10(path, {
    settings: { policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'x', visual: true }] }, executor: { reviewer: 'bob', prepare: 'echo $DSH_TAG_DIR' },
      sources: { 'github-issue': { enabled: true, config: {} }, github: { enabled: true, config: { mergeCli: 'gh' } } } },
    'settings-version:1': { revision: 1, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [],
      settings: { allowedChats: ['oc_team'], members: [], sources: undefined } },
    'settings-version:2': { revision: 2, savedAt: '', source: 'orchestrator-tool', policyVersion: '', policyChanged: false, notified: [],
      settings: { sources: { 'github-issue': { enabled: true, config: {} } } } },
    'prompt-revision': 1,
    'github-ended:8': { at: '2026-09-01T00:00:00Z', reason: 'merged' },
    'problem-dismissed:d3': true,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config: { shared: 's', orchestrator: 'o', worker: 'w', guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    'prompt-settings-text': 1,
    'task/t1/input/i0': '{"text":"old input"}',
    'task/t1/input/i9': '{"text":"older copy"}', 'ticket/t1/input/i9': '{"text":"kept"}',
    'settings-version:3': { revision: 3, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings: { executor: { maxWorkers: 'many' } } },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { communication: 1 } },
    'answer-ready:t1:trig-3': true,
    'github-object-state:7': 'open', subscriptions: [], 'settings-before-9': { policy: {} }, 'thread-times-backfilled': true,
    'github-issue-pending': { 1: {} },
    // 读取的缓存，现在由内存保存。
    'feishu-read:orchestrator-1:feishu/e1/thread': '{}', 'github-read:worker-t1:github/pulls/7': '{}', 'feishu-source-link:oc_team:om_1': 'https://x',
    'orchestrator-1:prompt-preview/abc': 'prompt',
  }, { ticket: [ticket, imported, waiting, bare], decision: [decision, reopened, unavailable], thread: [thread], trigger: triggers })

  const store = new Store(path)
  expect(store.get('schema')).toBe(SCHEMA_VERSION)
  const settings = store.settings()
  expect(Object.keys(settings.sources)).toEqual(['github'])
  expect(settings.sources.github!.config).not.toHaveProperty('mergeCli')
  expect(settings.policy.rules[0]).not.toHaveProperty('visual')
  expect(settings.executor).not.toHaveProperty('reviewer')
  expect(settings.executor.prepare).toBe('echo $DSH_SUPERAGENT_DIR')
  // 当前设置成为最新版本，迁移保存了它，因为最新保存的版本与其不同。
  const [current, , second, first] = store.settingsHistory()
  expect(current).toMatchObject({ revision: 4, source: 'internal', settings })
  expect(store.get('settings')).toBeUndefined()
  expect(first).toMatchObject({ source: 'panel', settings: { sources: { feishu: { config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } } })
  expect(second).toMatchObject({ source: 'tool', settings: { sources: { 'github-issue': { enabled: true } } } })
  expect(store.get('prompt-version:1')).toMatchObject({ legacy: { config: { guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    config: { skills: { release: 'Use the github section and dsh-superagent-cn-feishu.' } } })
  // 无效的历史 prompt 版本把原始值留在 legacy 下，并回退到前一个版本的 config。
  expect(store.get('prompt-version:2')).toMatchObject({ legacy: { config: { communication: 1 } }, config: store.get<{ config: object }>('prompt-version:1')!.config })
  expect(store.get('settings-version:3')).toMatchObject({ source: 'panel', settings: { executor: { maxWorkers: 'many' } } })
  const migrated = store.tickets.get('t1')!
  expect(migrated).not.toHaveProperty('meta')
  expect(store.keys('github-ended:')).toEqual([])
  expect(store.decisions.get('d3')).toMatchObject({ kind: 'unavailable', dismissed: true })
  expect(store.keys('problem-dismissed:')).toEqual([])
  expect(migrated).toMatchObject({
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'] },
    execution: { name: 'fix-1', directory: '/w/fix-1', assignment: 'Read trigger/trig-1.' },
    delivery: { error: 'offline', at: '2' },
    follows: [{ thread: 'github:8', own: true, closed: { at: '2026-09-01T00:00:00Z', outcome: 'merged' } }, { thread: 'github:7', own: false }],
    channels: [{ source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    answers: ['trig-3'],
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'oc_team', direct: false }, sender: 'ou_alice', addressed: 'mention' } },
  })
  expect(migrated.inputs[0]).toMatchObject({ id: 'i1', kind: 'text', text: expect.stringContaining('"resumed":true') })
  expect(migrated.inputs[0]).not.toMatchObject({ text: expect.stringContaining('reopen') })
  expect(migrated.inputs[1]).toEqual({ id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' })
  expect(migrated.inputs.slice(2)).toEqual([{ id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4', human: true }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }])
  expect(migrated).not.toHaveProperty('execution.recoveries')
  expect(store.tickets.get('t2')).toMatchObject({ execution: { name: 'task-2', assignment: 'Read event/old' },
    mandate: { basis: { via: 'followup', authority: 'thread_followup' } } })
  expect(store.tickets.get('t2')).not.toHaveProperty('follows')
  // 只重复其结果的结束原因不会被保留。
  expect(store.tickets.get('t2')!.ended).toEqual({ at: '6', by: 'executor', outcome: 'merged' })
  // 被人停止的工单不保留任何等待内容；缺少属性的工单照样得到一个 origin。
  expect(store.tickets.get('t4')).toMatchObject({ origin: { triggerId: '', triggerIds: [] } })
  expect(store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'stopped' }, undelivered: [], origin: { triggerId: '', triggerIds: [] },
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'p2p', direct: true }, sender: 'ou_alice', addressed: 'direct' } } })
  expect(store.tickets.get('t3')).not.toHaveProperty('execution')
  // 原因是一个代码；评估器写下的文字原样保留。
  expect(store.decisions.get('d2')).toEqual({ ...reopened, reason: [{ code: 'said', values: { text: 'follow-up' } }] })
  expect(store.decisions.get('d3')!.reason).toEqual([{ code: 'timeout' }])
  expect(store.decisions.get('d1')!.mandate!.basis).toEqual({ via: 'listed', rules: ['copy'], observation: {}, authority: 'proactive_rule' })
  expect(store.threads.get('github:5')!.evaluating!.basis).toEqual({ via: 'admission', source: 'github', scope: { number: 5 }, row: 'issues',
    cell: 'listedUnaddressed', observation: { mode: 'auto' } })
  // kv：输入在读取时从其工单渲染，因此不保留正文；无人读取的记录会被移除，
  // 被迁移转换的已移除 Issue source 的记录也是如此。
  expect(store.get('ticket/t1/input/i0')).toBeUndefined()
  expect(store.get('ticket/t1/input/i9')).toBeUndefined()
  expect(store.keys('task/')).toEqual([])
  for (const name of ['answer-ready:t1:trig-3', 'github-object-state:7', 'subscriptions', 'settings-before-9', 'thread-times-backfilled', 'prompt-settings-text',
    'feishu-read:orchestrator-1:feishu/e1/thread', 'github-read:worker-t1:github/pulls/7', 'feishu-source-link:oc_team:om_1', 'orchestrator-1:prompt-preview/abc']) {
    expect(store.get(name)).toBeUndefined()
  }
  expect(store.get('github-issue-pending')).toBeUndefined()
  // schema 6 的表保留，带着 schema 7 导入遗漏的行。
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbox'").get()).toBeDefined()
  store.close()
  // 再次迁移结果不会改变任何东西。
  const db = new DatabaseSync(path)
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const again = new Store(path)
  expect(again.tickets.get('t1')).toEqual(migrated)
  again.close()
})

it('把每条消息保留为其去向的回执，丢弃原因按管理面板措辞它的代码记录', () => {
  const path = join(directory, 'db.sqlite')
  schema10(path, {})
  const db = new DatabaseSync(path)
  const message = (id: string, sent: number, fields: object = {}) => db.prepare('INSERT INTO outbox (id, value, sent) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: id, kind: 'reply', attempts: 2,
      error: 'offline', nextAttemptAt: 1, ...fields }), sent)
  message('gone', 1, { dropped: { at: '2026-09-01T00:00:00.000Z', reason: 'The conversation can no longer receive messages' } })
  message('ignored', 1, { dropped: { at: '2026-09-02T00:00:00.000Z', reason: 'The Source no longer listens to this conversation' } })
  message('sent', 1)
  message('waiting', 0)
  db.close()
  const store = new Store(path)
  expect(store.read.droppedReplies().map(item => [item.id, item.dropped.reason])).toEqual([['ignored', 'channelIgnored'], ['gone', 'channelGone']])
  expect(['gone', 'sent', 'waiting'].map(id => store.replyStatus(id))).toEqual(['dropped', 'sent', 'pending'])
  // 回执不保存 attempts：等待中的消息有一个 `reply` 效果，它保留原有的计数并继续累加。
  expect(store.receipts.get('waiting')).toEqual({ id: 'waiting', channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: 'waiting',
    kind: 'reply', status: 'pending' })
  expect(store.db.prepare('SELECT kind, key, attempts, error FROM effect').all()).toEqual([{ kind: 'reply', key: 'waiting', attempts: 2, error: 'offline' }])
  expect(store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => row.name)).not.toContain('sent')
  store.close()
})

it('一步失败时什么都不改：数据库保持原样停在 schema 10', () => {
  const path = join(directory, 'db.sqlite')
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [], inputs: [], undelivered: [], summary: '', createdAt: '1',
    updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1', workspace: '/w/fix-1' } }
  // 当前设置必须通过校验；无效值会中止迁移事务。
  schema10(path, { settings: { executor: { maxWorkers: 'many' } } }, { ticket: [ticket] })
  expect(() => new Store(path)).toThrow(/^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: the settings: /)
  const db = new DatabaseSync(path)
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '10' })
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t1'").get()!.value))).toMatchObject({ meta: { workspace: '/w/fix-1' } })
  db.close()
})

it('把早期准入记录的每种依据读成当前形状', () => {
  const scope = { chatId: 'oc_1', direct: false }
  expect(basisOf({ source: 'feishu', scope, row: 'oc_1', sender: 'Alice', addressed: 'mention' })).toEqual({ via: 'addressed', source: 'feishu', scope, row: 'oc_1',
    sender: 'Alice', addressed: 'mention' })
  expect(basisOf({ source: 'feishu', scope, followup: true, rules: ['r'] })).toEqual({ via: 'followup', source: 'feishu', scope, rules: ['r'] })
  expect(basisOf({ source: 'feishu', scope, addressed: 'direct', admission: 'unlistedAddressed' })).toEqual({ via: 'admission', source: 'feishu', scope,
    cell: 'unlistedAddressed', addressed: 'direct' })
  // 在未记录 cell 的早期准入下被观察到：发送者必须在列表上。
  expect(basisOf({ source: 'feishu', scope, sender: 'Alice', observation: true, mode: 'auto', rules: ['r'] })).toEqual({ via: 'listed', source: 'feishu', scope,
    sender: 'Alice', rules: ['r'], observation: { mode: 'auto' } })
  expect(basisOf({ chatId: 'oc_1', direct: true, followup: true, member: 'ou_a' })).toEqual({ via: 'followup', source: 'feishu', scope: { chatId: 'oc_1', direct: true },
    sender: 'ou_a' })
  expect(basisOf({ member: 'ou_a', mention: true })).toEqual({ via: 'listed', sender: 'ou_a', addressed: 'mention' })
  expect(basisOf({ legacyAuthority: 'explicit_mention' })).toEqual({ via: 'listed', authority: 'explicit_mention' })
  expect(basisOf({ via: 'followup' })).toEqual({ via: 'followup' })
})

/** 构造团队小节出现之前的 prompt 版本，其中固定与内置指南存在 config 对象内。 */
const legacyPrompts = (revision: number, guides: Record<string, string> = {}) => ({
  [`prompt-version:${revision}`]: { revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'web',
    config: { shared: 'Legacy shared rule.', orchestrator: 'Legacy orchestrator: only route.', worker: 'Legacy worker.',
      guides: { replies: 'Legacy replies.', dispatch: 'Accept any screenshot.', work: 'Legacy work. Enable auto-merge once it changes fewer than 350 lines (additions plus deletions); and so on.',
        feishu: 'Legacy Feishu skill.', identities: 'Alice is @alice.', ...guides } } },
  'prompt-revision': revision, 'prompt-settings-text': 1,
})
const opened = (records: Record<string, unknown>) => {
  const path = join(directory, `db-${Math.random()}.sqlite`)
  schema10(path, records)
  return new Store(path)
}

it('把保存在团队小节之前的 prompt 版本写入其中，保留其 skills 与自动合并阈值，并作出标记', () => {
  const store = opened({ ...legacyPrompts(3, { notes: 'Call orchestrator_create_task with event_id, read event/<id>, follow guide/work and guide/release, load dsh-tag-github, cd "$DSH_TAG_DIR".' }) })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const { config } = prompts.version(3)
  expect(config.communication).toBe(defaultPrompts().communication)
  expect(config.delivery).toContain('它改动少于 350 行（新增加删除）；')
  expect(config.delivery).not.toContain('fewer than 200 lines')
  // 如今已固定或内置的指南被移除；团队自己的 skills 保留，使用当前名称。
  expect(Object.keys(config.skills)).toEqual(['identities', 'notes'])
  expect(config.skills.notes).toBe('Call orchestrator_route (kind accept) with trigger_id, read trigger/<id>, follow the work section and skill dsh-superagent-cn-release, load dsh-superagent-cn-github, cd "$DSH_SUPERAGENT_DIR".')
  const prompt = composePrompt(config, 'orchestrator')
  expect(prompt).not.toContain('Legacy orchestrator')
  expect(prompt).toContain(masterPrompt)
  expect(prompts.current().revision).toBe(3)
  // 读取为内置文本时，legacy 版本如此声明，而不是列出其差异。
  expect(prompts.history(0, 1).revisions.map(version => version.changed)).toEqual([['legacy']])
  store.close()
})

it('按当前名称写出已保存的团队小节与 skills：旧项目名、变成读取的工具与路由工具', () => {
  const config = { ...defaultPrompts(), delivery: 'Merge with --repo $DSH_FREELANCER_GITHUB_REPOSITORY.',
    skills: { notes: 'Load dsh-freelancer-github; cd "$DSH_FREELANCER_DIR". List with orchestrator_tickets, then orchestrator_ticket_inspect.',
      routing: 'Accept with orchestrator_ticket_accept; stop with orchestrator_ticket_stop, never orchestrator_trigger_ignore.' } }
  const store = opened({ 'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config }, 'prompt-revision': 1, 'prompt-settings-text': 1 })
  const { config: current } = new Prompts(store, () => 100000, () => undefined, () => true).current()
  expect(current.delivery).toBe('Merge with --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY.')
  expect(current.skills.notes).toBe('Load dsh-superagent-cn-github; cd "$DSH_SUPERAGENT_DIR". List with orchestrator_read tickets, then orchestrator_read ticket/<id>.')
  // 四个路由工具合而为一。
  expect(current.skills.routing).toBe('Accept with orchestrator_route (kind accept); stop with orchestrator_route (kind stop), never orchestrator_route (kind ignore).')
  store.close()
})

it('把已移除的自动合并阈值与成员身份写成一个新版本写入 prompt，除非更早的版本已经写过', () => {
  const before = { policy: { autoMergeLineLimit: 350, members: [{ name: 'Alice', feishuId: 'ou_alice', github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }] } }
  const store = opened({ 'settings-before-9': before })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const migrated = prompts.current()
  expect(migrated).toMatchObject({ revision: 1, previousRevision: 0, source: 'settings-migration' })
  expect(migrated.config.delivery).toContain('它改动少于 350 行（新增加删除）；')
  expect(migrated.config.skills.identities).toContain('- Alice（飞书 ou_alice）在 GitHub 上是 @alice')
  expect(migrated.config.skills.identities).not.toContain('Bob')
  expect(store.get('settings-before-9')).toBeUndefined()
  store.close()
  // 默认阈值与没有双身份的成员不改变任何东西；其他交付文本把阈值作为独立句子加入。
  const unchanged = opened({ 'settings-before-9': { policy: { members: [{ name: 'Bob', feishuId: 'ou_bob', github: '' }] } } })
  expect(new Prompts(unchanged, () => 100000, () => undefined, () => true).current().revision).toBe(0)
  unchanged.close()
  const own = opened({ 'settings-before-9': { policy: { autoMergeLineLimit: 80 } }, 'prompt-revision': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config: { ...defaultPrompts(), delivery: 'Deliver PRs.' } } })
  expect(new Prompts(own, () => 100000, () => undefined, () => true).current().config.delivery)
    .toBe('Deliver PRs.\n仅对改动少于 80 行（新增加删除）的 PR 开启自动合并。')
  own.close()
  const done = opened({ 'settings-before-9': before, 'prompt-settings-text': 1 })
  expect(new Prompts(done, () => 100000, () => undefined, () => true).current().revision).toBe(0)
  done.close()
})

it('读取与其前一版读取结果不同的当前 prompt 版本，保留其所言', () => {
  const config = { ...defaultPrompts(), delivery: 'Deliver PRs.' }
  const store = opened({ 'prompt-revision': 2, 'prompt-settings-text': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { delivery: ['not text'] } } })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  expect(prompts.current()).toMatchObject({ revision: 2, config, legacy: { config: { delivery: ['not text'] } } })
  expect(prompts.history(0, 2).revisions.map(version => version.changed)).toEqual([['legacy'], []])
  store.close()
})

/**
 * 创建一个原始 SQLite 数据库，与最后一个 schema 10 发布的表的 DDL 完全一致（在加入工作集列与
 * `effect` 表之前，并带有遗留的 schema 6 `inbox` 与 `task` 表）。
 */
function lastSchema10(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL, PRIMARY KEY (thread, id));
    CREATE INDEX trigger_at ON trigger(at);
    CREATE INDEX trigger_thread_at ON trigger_thread(thread, at);
    CREATE INDEX decision_thread ON decision(thread);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const kv = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?)').run(name, JSON.stringify(value))
  kv('schema', 10); kv('master-id', 'orchestrator-1'); kv('settings', { executor: { maxWorkers: 2 } })
  kv('relay-queue', [{ id: 'report:old', text: '{"kind":"worker_report"}' }])
  const trigger = { id: 'trig-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '2026-10-01T00:00:00Z', text: 'fix it', meta: {} }
  db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
  db.prepare('INSERT INTO trigger_thread VALUES (?,?,?,1)').run('feishu:oc_team:om_1', trigger.id, trigger.at)
  const thread = { key: 'feishu:oc_team:om_1', ref: trigger.threads[0], createdAt: trigger.at, subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
  db.prepare('INSERT INTO thread VALUES (?,?)').run(thread.key, JSON.stringify(thread))
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', summary: '', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: mandate({ source: 'feishu', scope: { chatId: 'oc_team' }, sender: 'Alice', addressed: 'mention' }), inputs: [], undelivered: [],
    assignments: [{ id: 'a1', state: 'running', createdAt: trigger.at }],
    meta: { sourceTriggerId: trigger.id, triggerIds: [trigger.id], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.' } }
  db.prepare('INSERT INTO ticket VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
  const reply = { id: 'reply-1', channel: { source: 'feishu', thread: thread.key, address: { chatId: 'oc_team', messageId: 'om_1' } }, text: '收到', kind: 'reply', attempts: 0, error: '' }
  db.prepare('INSERT INTO outbox VALUES (?,?,0)').run(reply.id, JSON.stringify(reply))
  db.prepare('INSERT INTO inbox VALUES (?,?,0)').run('left-out', '{"id":"left-out"}')
  db.close()
}

it('打开最后一个 schema 10 构建留下的数据库，在其旁边加入本版本保留的内容，并迁移它', () => {
  const path = join(directory, 'db.sqlite')
  lastSchema10(path)
  const store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(store.tickets.active().map(ticket => ticket.id)).toEqual(['t1'])
  expect(store.read.subscribedThreads('feishu').map(thread => thread.key)).toEqual(['feishu:oc_team:om_1'])
  expect(store.tickets.get('t1')).toMatchObject({ origin: { triggerId: 'trig-1' }, execution: { name: 'fix-1', directory: '/w/fix-1' },
    mandate: { basis: { via: 'addressed', addressed: 'mention' } } })
  expect(store.receipts.waiting().map(item => item.id)).toEqual(['reply-1'])
  expect(store.db.prepare('SELECT kind, key, generation FROM effect ORDER BY seq').all()).toEqual([{ kind: 'relay', key: 'report:old', generation: 0 },
    { kind: 'reply', key: 'reply-1', generation: 0 }])
  expect(store.db.prepare('SELECT id FROM inbox').all()).toEqual([{ id: 'left-out' }])
  const migrated = store.tickets.get('t1')
  store.close()
  const again = new Store(path)
  expect(again.tickets.get('t1')).toEqual(migrated)
  expect(again.db.prepare('SELECT COUNT(*) AS n FROM effect').get()).toEqual({ n: 2 })
  again.close()
})
it('把各 source 的记录一次性写成当前形状，使任何 source 读取更早记录时都不再转换', () => {
  const path = join(directory, 'db.sqlite')
  const recent = new Date(Date.now() - 3600_000).toISOString()
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['issue'], strength: 'inferred', actor, policyVersion: 'v1',
    startedAt: '',
    deadline: '', basis: { via: 'listed' } }
  schema10(path, {
    'feishu-chats': { oc_dm: true, oc_team: false }, 'feishu-history:oc_team': '2026-09-01T00:00:00.000Z',
    // 早期版本把会话的话题保存为列表。
    'feishu-history-threads:oc_team': ['omt_old'],
    'github-thread:7': '2026-09-02T00:00:00.000Z', 'thread-since:github:7': '2026-09-03T00:00:00.000Z',
    'github-thread:8': '2026-09-04T00:00:00.000Z',
    'github-issue-pending': { a: { number: 12, at: recent }, b: { number: 13,
      at: '2026-01-01T00:00:00.000Z' } }, 'github-issues-since': 'x',
  }, {
    trigger: [{ id: 'dm', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_dm:om_1' }], actor, human: true,
      at: '2026-09-01T00:00:00Z',
      text: 'fix', channel: dm, meta: {} },
    { id: 'issue', source: 'github-issue', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Login fails', meta: { number: 12 } }],
    thread: [{ key: 'feishu:oc_team:om_9', ref: { source: 'feishu', id: 'oc_team:om_9' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} },
    { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating,
      meta: {} }],
  })
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('r1', JSON.stringify({ id: 'r1', channel: dm, text: 'Done', kind: 'reply',
    attempts: 0, error: '' }))
  // 在效果指名其触发之前排队的研判：一个其评估仍在运行，一个其评估已结束。
  for (const [seq, evalId] of [[1, 'e1'], [2, 'e2']] as const) {
    db.prepare('INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)').run('assessment', evalId, '{}', seq, 0,
      '')
  }
  db.close()
  const store = new Store(path)
  expect(store.get(KV.feishu.topics('oc_team'))).toEqual({ omt_old: '2026-09-01T00:00:00.000Z' })
  expect(store.triggers.get('dm')!.channel!.address).toEqual({ chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  expect(store.receipts.waiting()[0]!.channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  expect(store.threads.get('feishu:oc_team:om_9')!.meta.url).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_team')
  expect(store.triggers.get('issue')!.source).toBe('github')
  // 轮询范围内等待的提及会被再次读取；更旧的那个不是新请求。
  expect(store.get(KV.github.retries)).toEqual({ 12: { since: recent, pr: false } })
  expect(store.get(KV.github.cursor(7))).toBe('2026-09-03T00:00:00.000Z')
  expect(store.get(KV.github.cursor(8))).toBe('2026-09-04T00:00:00.000Z')
  for (const name of ['github-issue-pending', 'github-issues-since', 'github-thread:7', 'thread-since:github:7', 'github-thread:8']) {
    expect(store.get(name)).toBeUndefined()
  }
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key,
    JSON.parse(String(row.value))])
  expect(effects).toEqual([['e1', { triggerId: 'issue' }]])
  store.close()
})

it('工单的每个事实只保留一次：其结束、其最新报告，且不保留可推导出的 worker Session', () => {
  const base = { id: 't', title: 'Fix', decisionId: 'd', channels: [], inputs: [], undelivered: [], createdAt: '1', updatedAt: '2',
    mandate: mandate({ via: 'listed' }), origin: { triggerId: 'x', triggerIds: ['x'] }, execution: { name: 'fix', directory: '/w', session: 'worker-t', assignment: 'Do it.' } }
  const open = withoutCopies({ ...base, state: 'open', summary: 'Working on it',
    assignments: [{ id: 'a1', ticketId: 't', ref: 'worker-t', state: 'running', createdAt: '1' }] })
  expect(open).toEqual({ ...base, execution: { name: 'fix', directory: '/w', assignment: 'Do it.' },
    assignments: [{ id: 'a1', state: 'running', createdAt: '1', report: { state: 'progress', summary: 'Working on it', at: '2' } }] })
  // 工单已有的报告保持为最新一份；没有结束记录的已结束工单以 closed 结束。
  const reported = { id: 'a1', ticketId: 't', ref: '', state: 'ended', createdAt: '1', report: { state: 'ready', summary: 'Done', at: '2' } }
  expect(withoutCopies({ ...base, state: 'ended', summary: 'Done', assignments: [reported] })).toMatchObject({
    ended: { at: '2', by: 'executor', outcome: 'closed' }, assignments: [{ id: 'a1', state: 'ended', report: { summary: 'Done' } }] })
})

it('把早期版本以文字保存的原因读成代码，其余文字原样保留', () => {
  expect(reasonsOf('Assessment timed out')).toEqual([{ code: 'timeout' }])
  expect(reasonsOf('a1: not_a_member; b2: no_mention')).toEqual([{ code: 'not_a_member', triggerId: 'a1' }, { code: 'no_mention', triggerId: 'b2' }])
  expect(reasonsOf('Routed to ticket t9')).toEqual([{ code: 'routed', values: { ticket: 't9' } }])
  expect(reasonsOf('Observe mode: would accept (a copy fix)')).toEqual([{ code: 'observed', values: { text: 'a copy fix' } }])
  // 评估器的文字可能包含冒号或分号；它们保持为一条原因。
  expect(reasonsOf('Not a request: chatter; nothing to do')).toEqual([{ code: 'said', values: { text: 'Not a request: chatter; nothing to do' } }])
  expect(reasonsOf([{ code: 'timeout' }])).toEqual([{ code: 'timeout' }])
})

const ticket10 = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [],
  inputs: [], undelivered: [], summary: '', createdAt: '1', updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1' }, ...fields })
/** 按 schema 10 保存时的做法为 `triggers` 填充 `trigger_thread` 行。 */
function indexed(path: string, triggers: { id: string; at: string; threads: { source: string; id: string }[] }[]): void {
  const db = new DatabaseSync(path)
  for (const { id, at, threads } of triggers) {
    for (const thread of threads) db.prepare('INSERT INTO trigger_thread VALUES (?, ?, ?, 1)').run(`${thread.source}:${thread.id}`, id, at)
  }
  db.close()
}

it('从其触发推算每个线程的时间，并把每个触发的时间统一为已存时间采用的那一种形式', () => {
  const path = join(directory, 'db.sqlite')
  const comment = (id: string, at: string) => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor, human: true, at, text: id, meta: {} })
  // GitHub 以整秒写入其时间；schema 10 构建在得知活动时间之前保存的线程没有时间。
  const triggers = [comment('first', '2026-10-01T00:00:00Z'), comment('last', '2026-10-09T00:00:00.000Z')]
  schema10(path, {}, { trigger: triggers,
    thread: [{ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-10-05T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  indexed(path, triggers)
  const store = new Store(path)
  expect(store.threads.get('github:7')).toMatchObject({ createdAt: '2026-10-01T00:00:00.000Z', lastAt: '2026-10-09T00:00:00.000Z' })
  expect(store.triggers.get('first')!.at).toBe('2026-10-01T00:00:00.000Z')
  expect(store.db.prepare("SELECT at FROM trigger WHERE id = 'first' UNION ALL SELECT at FROM trigger_thread WHERE id = 'first'").all())
    .toEqual([{ at: '2026-10-01T00:00:00.000Z' }, { at: '2026-10-01T00:00:00.000Z' }])
  store.close()
})

it('某个工单读取失败时指名它停在哪一个，数据库保持原样停在 schema 10', () => {
  const path = join(directory, 'db.sqlite')
  const { inputs: _inputs, ...broken } = ticket10('t9')
  schema10(path, {}, { ticket: [broken] })
  expect(() => new Store(path)).toThrow(/^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: ticket t9: /)
  const db = new DatabaseSync(path)
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '10' })
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t9'").get()!.value))).toEqual(broken)
  db.close()
})

it('当最新保存的版本已持有当前设置时使其成为当前设置，并把滞后的指针移到它上', () => {
  const path = join(directory, 'db.sqlite')
  const version = (revision: number, settings: object) => ({ revision, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings })
  schema10(path, { settings: { executor: { maxWorkers: 4 } }, 'settings-revision': 1, 'settings-version:1': version(1, {}),
    'settings-version:2': version(2, { executor: { maxWorkers: 4 } }) })
  const store = new Store(path)
  expect(store.settingsHistory().map(item => item.revision)).toEqual([2, 1])
  expect([store.get(KV.settings.revision), store.settings().executor.maxWorkers, store.get('settings')]).toEqual([2, 4, undefined])
  store.close()
})

it('把触发过滤与派工结束以文字保存的原因读成代码，结束的原因只保留一次', () => {
  const path = join(directory, 'db.sqlite')
  const assignment = (id: string, endedReason: string) => ({ id, ticketId: 't1', ref: '', state: 'ended', createdAt: '1', endedAt: '2', endedReason })
  schema10(path, {}, { ticket: [ticket10('t1', { assignments: [assignment('a1', 'Retried by a person'), assignment('a2', 'host restarted'),
    { id: 'a3', ticketId: 't1', ref: '', state: 'running', createdAt: '2' }] })] })
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO disposition VALUES (?, ?)').run('trig-1', JSON.stringify({ filtered: 'Sender is not an authorized human member', fanout: [], at: '' }))
  db.close()
  const store = new Store(path)
  expect(store.tickets.get('t1')!.assignments.map(item => item.endedReason)).toEqual(['retried', 'hostRestarted', undefined])
  expect(store.triggers.disposition('trig-1')).toMatchObject({ filtered: { code: 'senderNotMember' } })
  store.close()
  // 被结束停止的派工不重复结束的原因，原因由结束本身保留。
  const ended = withoutCopies({ ...ticket10('t2'), state: 'ended', ended: { at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: '1', endedAt: '5', endedReason: 'Not needed' }] })
  expect([ended.ended, ended.assignments[0]]).toEqual([{ at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' }, { id: 'a1', state: 'ended', createdAt: '1', endedAt: '5' }])
})

it('把工单到飞书私聊会话的渠道标记为 direct，存储的是 Lark 链接时线程也按 Lark 品牌链接', () => {
  const path = join(directory, 'db.sqlite')
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const lark = { id: 'lark', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_2' }], actor, human: true, at: '2026-10-01T00:00:00.000Z',
    text: 'hi', url: 'https://applink.larksuite.com/client/message/link/open?token=x', meta: {} }
  schema10(path, { 'feishu-chats': { oc_dm: true } }, { ticket: [ticket10('t1', { channels: [dm] })], trigger: [lark],
    thread: [{ key: 'feishu:oc_other:om_9', ref: { source: 'feishu', id: 'oc_other:om_9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  const store = new Store(path)
  expect(store.tickets.get('t1')!.channels).toEqual([{ ...dm, address: { ...dm.address, direct: 'true' } }])
  expect(store.threads.get('feishu:oc_other:om_9')!.meta.url).toBe('https://applink.larksuite.com/client/chat/open?openChatId=oc_other')
  store.close()
})

it('升级时把进行中评估的候选再次送达，使其 deadline 开始计时并可以到期', () => {
  const path = join(directory, 'db.sqlite')
  const evaluating = { id: 'e9', threadKey: 'github:9', triggerIds: ['issue-9'], strength: 'explicit', actor, policyVersion: 'v1', startedAt: '1',
    deadline: '2', basis: { via: 'listed' } }
  schema10(path, {}, {
    trigger: [{ id: 'issue-9', source: 'github', threads: [{ source: 'github', id: '9' }], actor, human: true, at: '2026-09-01T00:00:00Z', text: 'Fix it', meta: {} }],
    thread: [{ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }],
  })
  const store = new Store(path)
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key, JSON.parse(String(row.value))])
  expect(effects).toEqual([['e9', { triggerId: 'issue-9' }]])
  store.close()
})
