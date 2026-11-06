import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, type Assessor, type Executor, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { backfillChat, consumerRetry, feishuKind, feishuTriggerId, feishuRef, feishuTime, feishuTrigger, historyEvent }
  from '../src/sources/feishu.ts'
import { KV } from '../src/kv.ts'
import { apply as applyFeishu, pollThreads as pollFeishuThreads } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { commentTrigger, githubAddress, githubChannel, issueTrigger, type GithubComment, type GithubIssue } from '../src/sources/github-trigger.ts'
import { claimPull, observePull, pullEndNotices, pullOf, ticketBranch, type Pull } from '../src/sources/github-pull.ts'
import { ciCounts, ciFact, ciSummary } from '../src/sources/github-read.ts'
import { apply as applyGithub, githubKind, pollFailure, pollRound } from '../src/sources/github.ts'
import { pollThreads as pollGithubThreads } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { cursorAt, POLL_HORIZON_MS } from '../src/sources/poll.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError, type SetupProblem } from '../src/setup.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MEMBER = 'ou_alice'
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sources-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' }, github: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' }, sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_observed', listen: 'all' }], directMessages: true } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment()
  sources.register(feishuKind); sources.register(githubKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // 在 store 中记录出站消息，但不实际发送。
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  // Source 的函数接收 context；插件条目与 kind 回调接收 host，由 host 构建每个 kind 的 context。
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'feishu', health: ['github', 'feishu', 'history'] })
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}
const subscribed = (h: ReturnType<typeof host>, ref: { source: string; id: string }, meta: Record<string, unknown> = {}) =>
  h.store.threads.save({ key: `${ref.source}:${ref.id}`, ref, createdAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [], meta })
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: `source-${id}`, triggerIds: [] } })
const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
const pulled = (number: number) => ({ follows: [{ thread: `github:${number}`, own: true }] })
const endedPull = (number: number, at: string, merged = true): Pull =>
  ({ ...openPull(number), state: 'closed', merged, ...merged ? { merged_at: at } : { closed_at: at } })
const agentsPull = (number: number, ref: string): Pull =>
  ({ ...openPull(number), user: { login: 'agent-bot' }, head: { sha: 'abc', ref, repo: { full_name: 'acme/widgets' } } })
const openPull = (number: number) => ({ number, title: 'Fix the margin', state: 'open',
  html_url: `https://github.com/acme/widgets/pull/${number}`, user: { login: 'carol' },
  head: { sha: 'abc', ref: 'fix', repo: { full_name: 'acme/widgets' } } })
const notification = (number: number, kind: 'issues' | 'pulls' = 'issues') => ({ id: `n${number}`, updated_at: '2026-09-09T00:00:00Z',
  reason: 'mention',
  repository: { full_name: 'acme/widgets' }, subject: { url: `https://api.github.com/repos/acme/widgets/${kind}/${number}`,
    type: kind === 'pulls' ? 'PullRequest' : 'Issue', title: '' } })
const refused = (status: number, text: string) => commandError({ stderr: `gh: ${text} (HTTP ${status})`, code: 1 })
/** 对 `acme/widgets` 打桩 `gh api` 调用，并按顺序返回被请求的路径。 */
function github(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!.replace(/^repos\/acme\/widgets\//, ''))
    const path = reads.at(-1)!.split('?')[0]!
    const list = /\/(comments|reviews|statuses)$/.test(path) ? [] : refused(404, 'Not Found')
    const route = routes[path] ?? (path.endsWith('/check-runs') ? { check_runs: [] } : list)
    const value: unknown = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    if (args.includes('--include')) return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(value)}`
    return JSON.stringify(args.includes('--slurp') ? [value] : value)
  })
  return reads
}
const bare = (reads: string[]) => reads.map(path => path.split('?')[0])
describe('feishu source', () => {
  it('registers its kind without a bot, and names on its health what setup still needs', async () => {
    const run = async (overrides: Partial<SourceContextDeps>) => {
      // 夹具的 registry 已持有该 kind；这个从空开始，以便显示插件的注册。
      const value = host({ sources: emptyRegistry(), ...overrides })
      const disposers: (() => unknown)[] = []
      applyFeishu({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.waitFor(() => expect(value.health.history).toBeDefined())
      const registered = value.sources.kind('feishu')
      // 在 dispose 清空已注册条目之前快照 health。
      const health = { ...value.health }
      for (const dispose of disposers) await dispose()
      return { ...value, registered, health }
    }
    const unset = await run({ deployment: testDeployment({ feishu: undefined }) })
    expect(unset.registered).toBe(feishuKind)
    expect(unset.health).toMatchObject({ feishu: { state: 'paused', code: 'feishuCliUnset' }, history: { state: 'paused', code: 'feishuBotMissing' } })
    const problem = new SetupError('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }).problem
    const refused = await run({ deployment: testDeployment({ feishu: undefined }), feishuProblem: problem })
    // bot 检查失败会等待操作者修复并重新检查；它不会像轮询错误那样自行重试。
    expect(refused.health.feishu).toEqual({ state: 'paused', detail: problem.detail })
    expect((await run({ configured: () => false })).health.feishu).toEqual({ state: 'paused', detail: '等待部署检查', code: 'setupPending' })
  })
  it('translates live events into triggers keyed by root message, and drops the bot\'s own messages', () => {
    const trigger = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1757376000000', mentions: [{ id: 'cli_bot' }], root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1', message_app_link: 'https://applink/x' }, 'ou_bot', 'cli_bot')!
    expect(trigger).toMatchObject({ id: key('feishu', 'om_2'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '2025-09-09T00:00:00.000Z', url: 'https://applink/x', channel: { source: 'feishu', address: { chatId: 'oc_1', messageId: 'om_2' } }, meta: { chatId: 'oc_1', direct: false, mentioned: true, rootId: 'om_1', parentId: 'om_1', threadId: 'omt_1', messageId: 'om_2' } })
    expect(trigger.addressed).toBe('mention')
    expect(feishuTrigger({ message_id: 'om_5', chat_id: 'oc_2', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')!.addressed).toBe('direct')
    expect(feishuTrigger({ message_id: 'om_6', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')).not.toHaveProperty('addressed')
    expect(feishuRef(trigger)).toEqual({ triggerId: trigger.id, chatId: 'oc_1', messageId: 'om_2', at: trigger.at })
    expect(feishuTrigger({ message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', sender_id: 'ou_bot', sender_type: 'bot', content: 'me', create_time: '1' }, 'ou_bot', 'cli_bot')).toBeUndefined()
    expect(feishuTrigger(historyEvent({ message_id: 'om_4', chat_id: 'oc_1', create_time: '2', sender: { id: 'ou_x', sender_type: 'app' }, body: { content: '{"text":"from app"}' } }, 'oc_1', false), 'ou_bot', 'cli_bot')).toMatchObject({ human: false, text: 'from app', threads: [{ id: 'oc_1:om_4' }] })
  })
  it('polls subscribed threads and stores unseen replies as triggers on that thread', async () => {
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const reply = { message_id: 'om_reply', chat_id: 'oc_1', msg_type: 'text', content: 'more details', sender: { id: 'ou_guest', sender_type: 'user' }, create_time: '1757376000000', thread_id: 'omt_1', root_id: 'om_root', mentions: [] }
    const mine = { ...reply, message_id: 'om_mine', sender: { id: 'ou_bot', sender_type: 'app', open_bot_id: 'ou_bot' } }
    const earlier = { ...reply, message_id: 'om_old', create_time: '1700000000000' }
    const lark = vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      return { thread_id: 'omt_1', has_more: false, messages: [mine, reply, earlier] }
    })
    await pollFeishuThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('feishu', 'om_reply'), threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
      actor: { id: 'ou_guest' }, human: true, text: 'more details', meta: expect.objectContaining({ threadId: 'omt_1' }) })
    expect(h.store.get('thread-seen:feishu:oc_1:om_root')).toEqual(expect.arrayContaining(['om_reply', 'om_mine', 'om_old']))
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta).toMatchObject({ threadId: 'omt_1', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', facts: { chat: { value: 'oc_1' } } })
    lark.mockRejectedValue(new Error('rate limited'))
    await pollFeishuThreads(h)
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta.pollError).toContain('rate limited')
    h.store.close()
  })
  it('translates a polled topic reply as the event consumer translates the live event', async () => {
    const h = host()
    // bot 从其事件中得知的私聊 chat。
    h.store.set('feishu-chats', { oc_dm: true })
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_dm:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const page = (message_id: string, sender: Record<string, string>, extra: Record<string, unknown> = {}) => ({ message_id,
      chat_id: 'oc_dm', msg_type: 'text', content: 'and the header', sender,
      create_time: '2026-09-11 12:00', thread_id: 'omt_dm', ...extra })
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_dm', thread_id: 'omt_dm' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // 该页列出了不带根消息的回复，以及由 bot 所属 app 发出的自身消息。
      const messages = [page('om_mine', { id: 'cli_bot', sender_type: 'app' }), page('om_reply', { id: MEMBER, sender_type: 'user' })]
      return { thread_id: 'omt_dm', has_more: false, messages }
    })
    await pollFeishuThreads(h)
    const live = feishuTrigger({ message_id: 'om_reply', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'and the header',
      create_time: String(Date.parse('2026-09-11 12:00')), root_id: 'om_root', thread_id: 'omt_dm' }, 'ou_bot', 'cli_bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([live])
    expect(live).toMatchObject({ addressed: 'direct', threads: [{ source: 'feishu', id: 'oc_dm:om_root' }] })
    h.store.close()
  })
  it('reads message times given as epoch milliseconds or as local times, and refuses others', () => {
    expect(feishuTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(feishuTime('2026-09-11 12:00')).toBe(new Date(2026, 8, 11, 12, 0).toISOString())
    expect(() => feishuTime('soon')).toThrow('无法解析的飞书消息时间')
  })
  it('polls a subscribed topic while a live ticket follows it or it had a message in the last two weeks', async () => {
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: '1' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!,
      lastAt: new Date(Date.now() - 15 * 24 * 3600_000).toISOString() })
    const lark = vi.spyOn(h.commands, 'lark').mockResolvedValue({ items: [] })
    await pollFeishuThreads(h)
    expect(lark).not.toHaveBeenCalled()
    h.store.tickets.save(openTicket('ticket'))
    await pollFeishuThreads(h)
    expect(lark).toHaveBeenCalled()
    h.store.close()
  })
  it('keeps a quiet topic in history recovery while a subscribed Thread that is polled follows it', async () => {
    const h = host()
    const day = 24 * 3600_000
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_team', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: String(Date.now() - 30 * day), thread_id: 'omt_followed' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.tickets.save(openTicket('ticket'))
    const old = new Date(Date.now() - 30 * day).toISOString()
    h.store.set('feishu-history-threads:oc_team', { omt_followed: old, omt_quiet: old })
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'lark').mockResolvedValue({ has_more: false, items: [] })
    const now = new Date().toISOString()
    await backfillChat(h, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    expect(h.store.get('feishu-history-threads:oc_team')).toEqual({ omt_followed: old })
    h.store.close()
  })
  it('refuses a history page with a message outside its chat or topic, and a page token that does not advance', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const message = (fields: Record<string, unknown>) => ({ message_id: 'om_1', chat_id: 'oc_team', create_time: String(Date.now() - 1000),
      sender: { id: MEMBER, sender_type: 'user' }, body: { content: '{"text":"hi"}' }, ...fields })
    const lark = vi.spyOn(h.commands, 'lark')
    const now = new Date().toISOString()
    const recover = () => backfillChat(h, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    lark.mockResolvedValueOnce({ has_more: false, items: [message({ chat_id: 'oc_other' })] })
    await expect(recover()).rejects.toThrow('飞书历史返回了所请求群聊或话题之外的消息')
    // 包含另一个 topic 消息的 topic 页面。
    h.store.set('feishu-history-threads:oc_team', { omt_1: now })
    lark.mockResolvedValueOnce({ has_more: false, items: [] }).mockResolvedValueOnce({ has_more: false, items: [message({ thread_id: 'omt_2' })] })
    await expect(recover()).rejects.toThrow('飞书历史返回了所请求群聊或话题之外的消息')
    h.store.set('feishu-history-threads:oc_team', {})
    const stuck = { has_more: true, page_token: 'p1', items: [] }
    lark.mockResolvedValueOnce(stuck).mockResolvedValueOnce(stuck)
    await expect(recover()).rejects.toThrow('飞书历史分页没有推进')
    lark.mockResolvedValueOnce({ has_more: true, items: [] })
    await expect(recover()).rejects.toThrow('飞书历史分页没有推进')
    h.store.close()
  })
  it('stops reading a polled topic at the first message it knew, once the topic\'s first poll ran', async () => {
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, lastAt: new Date().toISOString() })
    h.store.set('thread-seen:feishu:oc_1:om_root', ['om_2'])
    h.store.set('thread-initialized:feishu:oc_1:om_root', true)
    const reply = (id: string) => ({ message_id: id, chat_id: 'oc_1', msg_type: 'text', content: `reply ${id}`, create_time: String(Date.now()),
      sender: { id: 'ou_guest', sender_type: 'user' }, thread_id: 'omt_1', root_id: 'om_root' })
    const lark = vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // 最新优先：一条新回复，然后是 Thread 已知的那条，以及一个不会被读取的更旧页面。
      return { thread_id: 'omt_1', has_more: true, page_token: 'older', messages: [reply('om_3'), reply('om_2')] }
    })
    await pollFeishuThreads(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_3'])
    expect(lark.mock.calls.filter(([args]) => args[1] === '+threads-messages-list')).toHaveLength(1)
    h.store.close()
  })
  it('recovers the topics of a chat while they had a message in the last two weeks, and forgets quieter ones', async () => {
    const h = host()
    const day = 24 * 3600_000
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    h.store.set('feishu-history-threads:oc_team', { omt_old: new Date(start).toISOString() })
    let round = 0
    const scans: string[] = []
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      const params = JSON.parse(args[args.indexOf('--params') + 1]!) as { container_id_type: string; container_id: string }
      scans.push(params.container_id)
      // 每天的 chat 扫描产出一个新 thread；thread 扫描不再返回更多消息。
      return { has_more: false, items: params.container_id_type === 'chat' ? [{ message_id: `om_${round}`, chat_id: 'oc_team',
        create_time: String(start + round * day), thread_id: `omt_${round}`,
        sender: { id: 'ou_bob', sender_type: 'user' }, body: { content: '{"text":"hi"}' } }] : [] }
    })
    for (round = 0; round < 30; round++) {
      scans.length = 0
      const since = new Date(start + round * day - 60_000).toISOString()
      await backfillChat(h, 'oc_team', false, since, new Date(start + round * day + 60_000).toISOString(), new AbortController().signal)
      if (round === 0) expect(scans).toContain('omt_old')
    }
    // 该 chat，以及在最近 14 天内有过消息的 topic。
    expect(scans).toHaveLength(1 + 14)
    expect(Object.keys(h.store.get<Record<string, string>>('feishu-history-threads:oc_team')!)).toHaveLength(14)
    expect(h.store.get<Record<string, string>>('feishu-history-threads:oc_team')!.omt_29).toBe(new Date(start + 29 * day).toISOString())
    h.store.close()
  })
  it('skips and counts a history message it cannot read, and takes in the others', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const item = (id: string) => ({ message_id: id, chat_id: 'oc_team', create_time: String(Date.now()), sender: { id: MEMBER,
      sender_type: 'user' },
      body: { content: '{"text":"@bot fix it"}' } })
    vi.spyOn(h.commands, 'lark').mockResolvedValue({ has_more: false, items: [item('om_good'), { message_id: 'om_bad',
      chat_id: 'oc_team' }] })
    const tally = { skipped: 0 }
    const since = new Date(Date.now() - 60_000).toISOString()
    await backfillChat(h, 'oc_team', false, since, new Date().toISOString(), new AbortController().signal, tally)
    expect(tally.skipped).toBe(1)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_good'])
    h.store.close()
  })
  it('waits a second before restarting the event consumer after a run that stayed up for a minute, and backs off otherwise', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 500)).toBe(2000)
    expect(consumerRetry(32_000, 500)).toBe(60_000)
    expect(consumerRetry(60_000, 120_000)).toBe(1000)
  })
  it('syncs its part of the Policy from the sync chat: people who left are removed, names follow the chat, new people are appended', async () => {
    const h = host()
    // sync 在其信号下读取 chat，因此停止 sync 就会停止读取。
    const withSignal = vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const lark = vi.spyOn(h.commands, 'lark').mockResolvedValue({ users: [{ member_id: 'ou_carol', name: 'Carol' }, { member_id: MEMBER, name: 'Alice Li' }], has_more: false })
    const sync = feishuKind.policy!.sync!
    expect(sync.ready({ allowed: [] })).toBe(false)
    const signal = new AbortController().signal
    expect(await sync.run(h, { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: 'oc_team' }, signal))
      .toEqual({ allowed: [{ id: MEMBER, name: 'Alice Li' }, { id: 'ou_carol', name: 'Carol' }], syncChat: 'oc_team' })
    expect(withSignal).toHaveBeenCalledWith(signal)
    expect(lark.mock.calls[0]![0]).toEqual(expect.arrayContaining(['+chat-members-list', '--chat-id', 'oc_team']))
    lark.mockResolvedValue({ users: [], has_more: true })
    await expect(sync.run(h, { allowed: [], syncChat: 'oc_team' }, new AbortController().signal)).rejects.toThrow('飞书返回的成员列表不完整')
    h.store.close()
  })
})
describe('github source', () => {
  it('normalizes comments and reviews into triggers with review-thread channels, and marks only GitHub Apps and machine accounts as automated', () => {
    const trigger = commentTrigger({ id: 5, body: 'nit', user: { login: 'review-bot[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5', updated_at: '2026-09-01T00:00:00Z' }, { number: 7, isPr: true, prAuthor: 'agent-bot' }, 'inline', 'agent-bot')
    expect(trigger).toMatchObject({ source: 'github', threads: [{ source: 'github', id: '7' }], human: false, channel: { address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#discussion_r5' } }, meta: { commentId: 5, kind: 'inline', prAuthor: 'agent-bot' } })
    // 普通账号上的 review bot 在此按人计算；提示词中将其称为自动化。
    expect(commentTrigger({ id: 6, body: 'x', user: { login: 'review-bot', type: 'User' } }, { number: 7, isPr: false }, 'conversation', 'agent-bot').human).toBe(true)
    expect(commentTrigger({ id: 7, body: 'x', user: { login: 'ci[bot]', type: 'Bot' } }, { number: 7, isPr: false }, 'conversation', 'agent-bot').human).toBe(false)
    // 即使没有正文，review decision 也会送达 ticket；普通 review 评论只携带其正文。
    const review = (fields: Partial<GithubComment>) => commentTrigger({ id: 8, user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-01T00:00:00Z', ...fields }, { number: 7, isPr: true }, 'review', 'agent-bot').text
    expect(review({ state: 'APPROVED', commit_id: 'abc123' })).toBe('对提交 abc123 的 APPROVED review')
    expect(review({ state: 'CHANGES_REQUESTED', commit_id: 'abc123', body: 'Keep the margin' })).toBe('对提交 abc123 的 CHANGES_REQUESTED review\n\nKeep the margin')
    expect(review({ state: 'COMMENTED', commit_id: 'abc123' })).toBe('')
    // 对 agent 的提及无论大小写都会指向它；agent 自己的消息则按自动化处理。
    expect(commentTrigger({ id: 9, body: '@Agent-Bot please fix', user: { login: 'alice', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot')).toMatchObject({ human: true, addressed: 'mention' })
    expect(commentTrigger({ id: 10, body: 'mail@agent-bot.example', user: { login: 'alice', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot')).not.toHaveProperty('addressed')
    expect(commentTrigger({ id: 11, body: 'pushed', user: { login: 'Agent-Bot', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot').human).toBe(false)
  })
  it('reads the address of an Issue, a PR or a review comment of the repository, and nothing else', () => {
    expect(githubAddress('https://api.github.com/repos/acme/widgets/pulls/9', 'acme/widgets')).toEqual({ number: 9, pr: true })
    expect(githubAddress('https://api.github.com/repos/Acme/Widgets/issues/12', 'acme/widgets')).toEqual({ number: 12, pr: false })
    expect(githubAddress('https://github.com/acme/widgets/pull/7/#discussion_r5', 'acme/widgets')).toEqual({ number: 7, pr: true,
      discussion: 5 })
    expect(githubAddress('https://github.com/acme/widgets/issues/7#issuecomment-3', 'acme/widgets')).toEqual({ number: 7, pr: false })
    for (const url of ['https://github.com/acme/gadgets/pull/7', 'https://api.github.com/repos/acme/widgets/commits/abc',
      'https://github.com/acme/widgets/pull/7/files', '']) {
      expect(githubAddress(url, 'acme/widgets')).toBeUndefined()
    }
  })
  it('matches a branch to a ticket by its short name as the last path segment', () => {
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c')).toBe(true)
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'fix-title-1a2b3c')).toBe(true)
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c-2')).toBe(false)
    expect(ticketBranch({}, 'agent/x')).toBe(false)
  })
  it('describes CI as one fact: failed checks first, then unfinished ones, otherwise passed', () => {
    const counts = ciCounts({ head: 'abc', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }, { name: 'docs', status: 'completed', conclusion: 'skipped' }], statuses: [{ context: 'deploy', state: 'error' }, { context: 'preview', state: 'pending' }] })
    expect(counts).toEqual({ failed: 2, running: 2 })
    expect(ciFact(counts)).toEqual({ label: { zh: 'CI 失败', en: 'CI failed' }, value: '2', problem: true })
    expect(ciFact({ failed: 0, running: 1 })).toEqual({ label: { zh: 'CI 进行中', en: 'CI running' }, value: '1' })
    expect(ciFact({ failed: 0, running: 0 })).toEqual({ label: 'CI', value: { zh: '通过', en: 'passed' } })
  })
  it('starts a review comment\'s text with its file, line and diff lines, and keeps them and the comment it answers', () => {
    const comment: GithubComment = { id: 5, body: 'Use the theme token', user: { login: 'carol', type: 'User' }, path: 'src/render.ts', line: 43,
      diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8', in_reply_to_id: 4,
      html_url: 'https://github.com/acme/widgets/pull/9#discussion_r5', created_at: '2026-09-09T00:00:00Z' }
    const trigger = commentTrigger(comment, { number: 9, isPr: true }, 'inline', 'agent-bot')
    expect(trigger.text).toBe('src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\nUse the theme token')
    expect(trigger.meta).toMatchObject({ path: 'src/render.ts', line: 43, inReplyTo: 4, commentId: 5, kind: 'inline' })
  })
  it('gives an assessment of a review comment the earlier comments of its review thread', async () => {
    const h = host()
    const comment = (id: number, reply?: number) => ({ id, body: `comment ${id}`, user: { login: 'carol', type: 'User' }, path: 'src/render.ts',
      line: 43, html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`, created_at: `2026-09-09T00:00:0${id}Z`,
      ...reply ? { in_reply_to_id: reply } : {} })
    vi.spyOn(h.commands, 'pages').mockResolvedValue([comment(1), comment(2, 1), comment(3), comment(4, 1)])
    const trigger = commentTrigger(comment(4, 1), { number: 9, isPr: true }, 'inline', 'agent-bot')
    const context = h.sources.threadContext(trigger)!
    const thread = await context.read(h.commands, 'thread')
    expect(thread).toMatchObject({ status: 'review_thread' })
    expect(thread.messages.map(message => message.id)).toEqual([1, 2, 4].map(id => `https://github.com/acme/widgets/pull/9#discussion_r${id}`))
    expect(context.messageId).toBe(thread.messages[2]!.id)
    expect((await context.read(h.commands, 'parent')).messages.map(message => message.id)).toEqual([thread.messages[0]!.id])
    h.store.close()
  })
  it('starts a CI Trigger\'s text with what failed or still runs, so its preview says it', () => {
    const check = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion })
    const failing = { head: 'abc1234def', checks: [check('lint', 'completed', 'failure'), check('e2e', 'completed', 'timed_out'),
      check('unit', 'completed', 'success'), check('docs', 'in_progress', null)], statuses: [] }
    const read = 'github/pulls/9/checks'
    expect(ciSummary(failing, 'PR #9',
      read)).toBe('CI 失败 2/4 于 PR #9（提交 abc1234）：lint, e2e；1 个仍在运行\n用 github/pulls/9/checks 读取每一项检查。')
    expect(ciSummary({ ...failing, checks: [check('docs', 'queued', null)] }, 'PR #9',
      read)).toMatch(/^CI 进行中 1\/1 于 PR #9（提交 abc1234）：docs/)
    expect(ciSummary({ ...failing, checks: [check('unit', 'completed', 'success')] }, 'PR #9',
      read)).toMatch(/^CI 通过 1\/1 于 PR #9（提交 abc1234）/)
  })
  it('binds a PR to the unique live ticket on its branch and ends tickets when the PR closes', async () => {
    const h = host()
    const decisionId = 'd'
    const request = feishuTrigger({ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot 修一下标题', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(request)
    h.store.tickets.save({ id: 't1', title: 'one', decisionId, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }], assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: execution('one'), origin: { triggerId: request.id, triggerIds: [request.id] } })
    const agentsPull = (number: number): Pull => ({ ...openPull(number), user: { login: 'agent-bot' }, head: { sha: 'abc',
      ref: 'agent/one', repo: { full_name: 'acme/widgets' } } })
    await observePull(h, agentsPull(9))
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(h.store.threads.get('github:9')?.subscriptions).toEqual(['t1'])
    // 追随某个 PR 的 ticket 只有经由其 Executor 的报告才会转到另一个 PR。
    await observePull(h, agentsPull(10))
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(await observePull(h, endedPull(9, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
    expect(h.store.threads.get('github:9')?.subscriptions).toEqual(['t1'])
    // 其结束所产生的通知会遵循源请求的语言。
    const notices = pullEndNotices(h.store.tickets.get('t1')!, request.text, 'acme/widgets')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: expect.objectContaining({ source: 'feishu' }), text: expect.stringContaining('已合并') })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    // 合并后恢复的 ticket 会继续工作：之后再查看该已合并的 PR 不会再报告任何内容。
    h.store.tickets.save({ ...h.store.tickets.get('t1')!, ended: undefined, assignments: [...h.store.tickets.get('t1')!.assignments, { id: 'a2', state: 'pending', createdAt: '2026-09-03T00:00:00Z' }] })
    expect(await observePull(h, endedPull(9, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    // 一旦恢复后的工作报告 ready，ticket 便随该已合并 PR 在当时结束，且不会产生第二次通知。
    h.engine.report('t1', { state: 'ready', summary: 'answered' })
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    expect(Date.parse(h.store.tickets.get('t1')!.ended!.at)).toBeGreaterThan(Date.parse('2026-09-03T00:00:00Z'))
    // 它的通知沿用第一个通知的 id，因此只会发出一次。
    expect(pullEndNotices(h.store.tickets.get('t1')!, request.text, 'acme/widgets').map(notice => notice.id)).toEqual(notices.map(notice => notice.id))
    h.store.close()
  })
  it('keeps a ticket working on its other open PR when one of its PRs merges', async () => {
    const h = host()
    h.store.tickets.save({ id: 't3', title: 'three', decisionId: 'd3', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], execution: execution('fix-3'), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
    expect(claimPull(h, 't3', agentsPull(21, 'agent/fix-3'))).toBeUndefined()
    expect(claimPull(h, 't3', agentsPull(22, 'agent/fix-3'))).toBeUndefined()
    expect(await observePull(h, endedPull(22, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ follows: [{ thread: 'github:21', own: true },
      { thread: 'github:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } }] })
    expect(h.store.tickets.get('t3')).not.toHaveProperty('ended')
    expect(pullOf(h.store.tickets.get('t3')!)).toBe(21)
    expect(h.executor.stop).not.toHaveBeenCalled()
    expect(await observePull(h, endedPull(21, '2026-09-03T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'merged', at: '2026-09-03T00:00:00.000Z' } })
    // PR 的结束会记录在追随它的 ticket 上，因此绑定与关闭不会写入键值记录。
    expect(h.store.keys('github-')).toEqual([])
    h.store.close()
  })
  it('follows a PR it opened again when it reopens, while another PR it opened is open', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t5'), execution: execution('fix-5'),
      follows: [{ thread: 'github:21', own: true }, { thread: 'github:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] })
    await observePull(h, agentsPull(22, 'agent/fix-5'))
    expect(h.store.tickets.get('t5')!.follows).toEqual([{ thread: 'github:21', own: true }, { thread: 'github:22', own: true }])
    h.store.close()
  })
  it('ends a ticket when its own PR merges, though the PR it started from is still open', async () => {
    const h = host()
    h.store.tickets.save({ id: 't4', title: 'four', decisionId: 'd4', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [githubChannel(30, 'https://github.com/acme/widgets/pull/30#issuecomment-1')], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], execution: execution('fix-4'), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
    h.store.threads.save({ key: 'github:30', ref: { source: 'github', id: '30' }, createdAt: '', subscriptions: ['t4'], correlated: [], pending: [], meta: { number: 30, isPr: true } })
    expect(claimPull(h, 't4', agentsPull(31, 'agent/fix-4'))).toBeUndefined()
    expect(await observePull(h, endedPull(31, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t4')).toMatchObject({ ended: { outcome: 'merged' } })
    h.store.close()
  })
  it('writes the terminal notice in English for a request without Han characters', async () => {
    const h = host()
    const request = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix the title', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(request)
    h.store.tickets.save({ id: 't2', title: 'two', decisionId: 'd2', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_2' } }], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', ...pulled(12), origin: { triggerId: request.id, triggerIds: [request.id] } })
    expect(await observePull(h, endedPull(12, '2026-09-02T00:00:00Z', false))).toBe(true)
    expect(pullEndNotices(h.store.tickets.get('t2')!, request.text, 'acme/widgets'))
      .toEqual([expect.objectContaining({ text: '[PR #12](https://github.com/acme/widgets/pull/12) was closed without merging.' })])
    h.store.close()
  })
  it('polls subscribed PR threads since their checkpoint and skips the bot\'s own comments', async () => {
    const h = host()
    const thread: Thread = { key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true } }
    h.store.threads.save(thread)
    const comment = (id: number, login: string, at: string, body: string) => ({ id, body, user: { login }, created_at: at, updated_at: at })
    github(h, { 'issues/7': { ...issue(7, { title: 'Fix the margin' }), pull_request: { url: 'x' } }, 'pulls/7': openPull(7),
      'issues/7/comments': [comment(1, 'agent-bot', '2026-09-01T01:00:00Z', 'mine'), comment(2, 'a', '2026-08-01T00:00:00Z', 'old'),
        comment(3, 'b', '2026-09-01T02:00:00Z', 'new')] })
    await pollGithubThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { id: 'b' }, text: 'new', threads: [{ source: 'github', id: '7' }] })
    expect(h.store.get('github-cursor:7')).toBeDefined()
    // Source 尚未读到标题的 Thread 会用其编号和标题来命名，并以编号作为事实。
    expect(h.store.threads.get('github:7')!.meta).toMatchObject({ title: 'Fix the margin', label: '#7 Fix the margin', facts: { number: { value: '#7' } } })
    h.store.close()
  })
  it('polls a subscribed Thread for two weeks after the Ticket that follows it ended', async () => {
    const h = host()
    const day = 24 * 3600_000
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date(Date.now() - 30 * day).toISOString(), subscriptions: ['t1'], correlated: [], pending: [],
      meta: { number: 7, isPr: false, title: 'Login fails' } })
    const ended = (ago: number) => h.store.tickets.save({ ...openTicket('t1'),
      ended: { at: new Date(Date.now() - ago).toISOString(), by: 'executor', reason: 'merged', outcome: 'merged' } })
    const reads = github(h, {})
    ended(3 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    ended(15 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    h.store.close()
  })
  it('polls a subscribed Thread while a live ticket follows it or its last Trigger is under two weeks old', async () => {
    const h = host()
    const day = 24 * 3600_000
    const thread = (lastAt: number, subscriptions = ['t']) => h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' },
      createdAt: '2026-09-01T00:00:00Z', lastAt: new Date(Date.now() - lastAt).toISOString(),
      subscriptions, correlated: [], pending: [], meta: { number: 7, isPr: false, title: 'Login fails' } })
    const reads = github(h, {})
    thread(15 * day)
    await pollGithubThreads(h)
    expect(reads).toEqual([])
    thread(13 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    // 活跃的 ticket 会让安静的 Thread 继续被轮询。
    h.store.tickets.save(openTicket('t9'))
    thread(15 * day, ['t9'])
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments', 'issues/7/comments'])
    h.store.close()
  })
  it('takes in a review decision without a body and skips a plain review comment without one', async () => {
    const h = host()
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true,
      title: 'Fix the margin' } })
    github(h, { 'pulls/7': openPull(7), 'pulls/7/reviews': [
      { id: 4, state: 'APPROVED', commit_id: 'abc123', user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-02T00:00:00Z' },
      { id: 5, state: 'COMMENTED', commit_id: 'abc123', body: '', user: { login: 'dave', type: 'User' }, submitted_at: '2026-09-02T00:01:00Z' },
    ] })
    await pollGithubThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { id: 'carol' }, text: '对提交 abc123 的 APPROVED review', meta: { kind: 'review' } })
    h.store.close()
  })
  it('reads each PR once per round and takes its end, auto-merge and CI from that read', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t9'), ...pulled(9) })
    h.store.threads.save({ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', lastAt: new Date().toISOString(),
      subscriptions: ['t9'], correlated: [], pending: [], meta: { number: 9, isPr: true, title: 'Fix' } })
    const pr = { number: 9, title: 'Fix', state: 'open', auto_merge: { merge_method: 'merge' } as unknown,
      html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'agent-bot' },
      head: { sha: 'abc', ref: 'agent/nine', repo: { full_name: 'acme/widgets' } } }
    const checks = { check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }] }
    const routes: Record<string, unknown> = { notifications: [notification(9, 'pulls')], 'pulls/9': pr, 'commits/abc/check-runs': checks }
    const reads = github(h, routes)
    await pollRound(h)
    // 通知、ticket 的 PR 与订阅的 Thread 共用一次 PR 读取。
    expect(reads.filter(path => path === 'pulls/9')).toHaveLength(1)
    const facts = () => h.store.threads.get('github:9')!.meta.facts as Record<string, unknown>
    expect(facts()).toMatchObject({ autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' } }, ci: { value: '1' } })
    routes['pulls/9'] = { ...pr, auto_merge: null }
    routes['commits/abc/check-runs'] = { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }
    await pollRound(h)
    expect(facts()).not.toHaveProperty('autoMerge')
    // 只有首次查看之后的变更才算 Trigger。
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta)).toEqual([expect.objectContaining({ ci: true, revision: 1 })])
    routes['pulls/9'] = { ...pr, state: 'closed', merged: true, merged_at: '2026-09-09T00:00:00Z' }
    await pollRound(h)
    expect(h.store.tickets.get('t9')).toMatchObject({ ended: { outcome: 'merged' } })
    h.store.close()
  })
  it('reads each notified Issue alone and reads a failed one again next round, from where it was', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:12', ref: { source: 'github', id: '12' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} })
    const mention = (id: number, number: number, at: string): GithubComment => ({ id, body: '@agent-bot take this',
      user: { login: 'alice', type: 'User' }, html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${id}`,
      created_at: at, updated_at: at })
    const routes: Record<string, unknown> = { notifications: [notification(12), notification(13)], 'issues/12': refused(502, 'Bad Gateway'),
      'issues/13': issue(13, { created_at: '2026-08-01T00:00:00Z' }),
      'issues/13/comments': [mention(1, 13, '2026-09-08T01:00:00Z')] }
    github(h, routes)
    // 若非因 Issue 缺失而读取失败，则在所有步骤运行后使该轮失败。
    await expect(pollRound(h)).rejects.toThrow('#12: Error: gh: Bad Gateway (HTTP 502)')
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13])
    // 游标随着那个它尚未覆盖的 Issue 一起前移。
    expect(Date.parse(h.store.get<string>('github-since')!)).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
    expect(h.store.get('github-retry')).toEqual({ 12: { since: '2026-09-08T00:00:00.000Z', pr: false, attempts: 1, failedAt: expect.any(String) } })
    expect(h.store.threads.get('github:12')!.meta.pollError).toContain('Bad Gateway')
    Object.assign(routes, { notifications: [], 'issues/12': issue(12, { created_at: '2026-08-01T00:00:00Z' }),
      'issues/12/comments': [mention(2, 12, '2026-09-08T02:00:00Z')] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13, 12])
    expect(h.store.get('github-retry')).toEqual({})
    expect(h.store.threads.get('github:12')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('drops an Issue GitHub reports as deleted after recording it, and reads one it answers 404 for again', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.tickets.save(openTicket('t14'))
    h.store.threads.save({ key: 'github:14', ref: { source: 'github', id: '14' }, createdAt: '', lastAt: new Date().toISOString(),
      subscriptions: ['t14'], correlated: [], pending: [], meta: { number: 14, isPr: false, title: 'Gone' } })
    const deleted = refused(410, 'This issue was deleted')
    github(h, { notifications: [notification(14), notification(15)], 'issues/14': deleted, 'issues/15': deleted })
    await pollRound(h)
    expect(h.store.get('github-retry')).toEqual({})
    // 丢弃一次读取不会移动读取位置。
    expect(h.store.get('github-cursor:14')).toBeUndefined()
    expect(h.store.threads.get('github:14')!.meta.pollError).toContain('deleted')
    // 没有 Thread 承载它时，会由 Source 的 health 指出它。
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '2 条通知；下次轮询 ≥ 60 秒；已在 GitHub 删除：#14, #15' })
    // GitHub 对 agent 失去访问权限的私有仓库也会返回 404：这种情况会作为失败再次读取。
    github(h, { notifications: [notification(16)] })
    await expect(pollRound(h)).rejects.toThrow('#16: Error: gh: Not Found (HTTP 404)')
    expect(h.store.get('github-retry')).toEqual({ 16: expect.objectContaining({ pr: false }) })
    h.store.close()
  })
  it('skips and counts a notification or comment it cannot read, and names the count in the health', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const comment = { id: 3, body: '@agent-bot please fix', user: { login: 'alice', type: 'User' },
      html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-3', created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' }
    github(h, { notifications: [notification(12), { id: 'n-odd', subject: {} }], 'issues/12': issue(12,
      { created_at: '2026-08-01T00:00:00Z' }),
      'issues/12/comments': [comment, { body: 'no id' }] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['@agent-bot please fix'])
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '1 条通知；下次轮询 ≥ 60 秒；跳过 2 个无法读取的条目' })
    h.store.close()
  })
  it('reads every page of the notifications when GitHub says there are more, and waits as long as GitHub asks', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const calls: string[][] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications' && args.includes('--include')) {
        return 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/notifications?page=2>; rel="next"\r\nX-Poll-Interval: 120\r\n\r\n[]'
      }
      if (path === 'notifications') return JSON.stringify([[notification(12)], [notification(13)]])
      if (/^issues\/\d+$/.test(path)) return JSON.stringify(issue(Number(path.split('/')[1]), { created_at: '2026-08-01T00:00:00Z' }))
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    expect(await pollRound(h)).toBe(120)
    const notifications = calls.filter(args => args[1]!.includes('/notifications'))
    expect(notifications.map(args => args.includes('--paginate'))).toEqual([false, true])
    const paths = calls.map(args => args[1]!.split('?')[0])
    expect(paths).toEqual(expect.arrayContaining(['repos/acme/widgets/issues/12', 'repos/acme/widgets/issues/13']))
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '2 条通知；下次轮询 ≥ 120 秒' })
    h.store.close()
  })
  it('drops a notified Issue whose reads fail for a day, so the Source leaves the error, and keeps its read position', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:16', ref: { source: 'github', id: '16' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
      meta: {} })
    h.store.set('github-cursor:16', '2026-09-01T00:00:00.000Z')
    github(h, { notifications: [notification(16)] })
    await expect(pollRound(h)).rejects.toThrow('#16: Error: gh: Not Found (HTTP 404)')
    const first = h.store.get<Record<string, { failedAt: string; attempts: number }>>('github-retry')![16]!
    expect(first).toMatchObject({ attempts: 1, failedAt: expect.any(String) })
    // 无论多少读取失败，只要未满一天的失败期：读取会被重试，而该轮仍然失败。
    h.store.set('github-retry', { 16: { ...first, attempts: 99 } })
    github(h, { notifications: [] })
    await expect(pollRound(h)).rejects.toThrow('#16')
    // 首次读取失败一天后，它会被丢弃：其 Thread 保留错误，health 会指出它，而该轮不再失败。
    // 它的读取位置仍保留，因此后续读取会补入失败读取遗漏的内容。
    h.store.set('github-retry', { 16: { ...first, failedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } })
    await pollRound(h)
    expect(h.store.get('github-retry')).toEqual({})
    expect(h.store.get('github-cursor:16')).toBe('2026-09-01T00:00:00.000Z')
    expect(h.store.threads.get('github:16')?.meta.pollError).toContain('Not Found')
    expect(h.health.github).toMatchObject({ state: 'ready',
      detail: '0 条通知；下次轮询 ≥ 60 秒；读取持续失败后放弃：#16' })
    h.store.close()
  })
  it('polls the PRs of open tickets and subscribed Threads although the notifications fail, and then fails the round', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: false,
      title: 'Login fails' } })
    github(h, { notifications: refused(503, 'Service Unavailable'), 'issues/7/comments': [{ id: 3, body: 'still broken',
      user: { login: 'b', type: 'User' }, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' }] })
    await expect(pollRound(h)).rejects.toThrow('HTTP 503')
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: 'still broken' }))
    expect(h.store.get('github-since')).toBe('2026-09-08T00:00:00.000Z')
    h.store.close()
  })
  it('takes in the description of a notified PR someone opened since the cursor, as a new PR\'s stream does', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const pr = { ...openPull(9), body: '@agent-bot please review', created_at: '2026-09-09T00:00:00Z' }
    github(h, { notifications: [notification(9, 'pulls')], 'pulls/9': pr })
    await pollRound(h)
    const opened = h.receive.mock.calls.map(([trigger]) => trigger).filter(trigger => trigger.meta.kind === 'pull')
    const id = issueTrigger({ ...pr, id: 9 } as GithubIssue, 'agent-bot').id
    expect(opened).toEqual([expect.objectContaining({ id, addressed: 'mention', actor: { source: 'github', id: 'carol' },
      meta: expect.objectContaining({ number: 9, isPr: true, prAuthor: 'carol' }) })])
    // agent 自己的 PR，以及在游标之前开启的 PR，都不会带来描述。
    h.receive.mockClear()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    github(h, { notifications: [notification(9, 'pulls')], 'pulls/9': { ...pr, user: { login: 'agent-bot' } } })
    await pollRound(h)
    h.store.set('github-since', '2026-09-10T00:00:00.000Z')
    github(h, { notifications: [{ ...notification(9, 'pulls'), updated_at: '2026-09-11T00:00:00Z' }], 'pulls/9': pr })
    await pollRound(h)
    expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.kind === 'pull')).toEqual([])
    h.store.close()
  })
  it('reads a subscribed default-branch CI Thread as no Issue, and keeps no poll error on it', async () => {
    const h = host()
    h.store.tickets.save(openTicket('ticket'))
    subscribed(h, { source: 'github', id: 'ci:main' })
    h.store.threads.save({ ...h.store.threads.get('github:ci:main')!, lastAt: new Date().toISOString() })
    const reads = github(h, {})
    await pollGithubThreads(h)
    expect(reads).toEqual([])
    expect(h.store.threads.get('github:ci:main')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('drops an Issue or a ticket\'s PR that GitHub answers 410 for, and keeps a failed PR read on its Thread', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.tickets.save({ ...openTicket('ticket'), follows: [{ thread: 'github:7', own: true }, { thread: 'github:8', own: true }] })
    subscribed(h, { source: 'github', id: '5' }, { number: 5, isPr: false, title: 'Gone' })
    h.store.threads.save({ ...h.store.threads.get('github:5')!, lastAt: new Date().toISOString() })
    // 这些 PR 的 Thread 没有任何订阅，因此只有 ticket 的 PR 读取会到达它们。
    for (const number of [7, 8]) {
      h.store.threads.save({ key: `github:${number}`, ref: { source: 'github', id: String(number) }, createdAt: '', subscriptions: [],
        correlated: [], pending: [], meta: {} })
    }
    github(h, { notifications: [], 'issues/5/comments': refused(410, 'Gone'), 'pulls/7': refused(410, 'Gone') })
    // 除 #8 外每次 PR 读取都成功或被丢弃；#8 像网络错误一样失败。
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (path === 'issues/5/comments' || path === 'pulls/7') throw refused(410, 'Gone')
      if (path === 'pulls/8') throw refused(502, 'Bad Gateway')
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    await expect(pollRound(h)).rejects.toThrow(/#8: .*502/)
    expect(h.store.threads.get('github:8')!.meta.pollError).toContain('502')
    expect(h.store.threads.get('github:7')!.meta.pollError).toContain('410')
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (path === 'issues/5/comments' || path === 'pulls/7' || path === 'pulls/8') throw refused(410, 'Gone')
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    // 当每次失败都是 410 时，该轮成功，并指出 GitHub 删除了哪些内容。
    await pollRound(h)
    expect(h.health.github).toMatchObject({ state: 'ready', detail: expect.stringContaining('已在 GitHub 删除：#5, #7, #8') })
    h.store.close()
  })
  it('waits for setup, pauses while the Source is off, and counts only consecutive failed polls towards an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const start = async (overrides: Partial<SourceContextDeps>,
        github: { enabled: boolean; config: Record<string, unknown> } = { enabled: true, config: {} }) => {
        const board = new HealthBoard()
        const settings = SettingsSchema.parse({ sources: { github } })
        const sources = new SourceRegistry(() => settings, board)
        healthOf.set(sources, board)
        const value = host({ sources, ...overrides })
        const disposers: (() => unknown)[] = []
        applyGithub({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
        return { value, stop: async () => { for (const dispose of disposers) await dispose(); value.store.close() } }
      }
      const pending = await start({ configured: () => false })
      await vi.waitFor(() => expect(pending.value.health.github).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await pending.stop()
      const off = await start({}, { enabled: false, config: {} })
      await vi.waitFor(() => expect(off.value.health.github).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await off.stop()
      // 各轮依次失败、成功、失败、失败：只有连续最后两次才产生该错误。每轮都通过自己的 Commands 读取。
      const outcomes = [false, true, false, false]
      let round = 0
      const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async () => {
        if (!outcomes[round++]) throw refused(502, 'Bad Gateway')
        return 'HTTP/2.0 200 OK\r\n\r\n[]'
      })
      const flaky = await start({}, { enabled: true, config: { failuresBeforeError: 2 } })
      // 每轮读取一次通知，然后等待一分钟进入下一轮。
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(60_000)
        }
      }
      await until(3)
      expect(flaky.value.health.github).toMatchObject({ state: 'ready' })
      await until(4)
      await vi.waitFor(() => expect(flaky.value.health.github).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      await flaky.stop()
      run.mockRestore()
    } finally { vi.useRealTimers() }
  })
  it('reports a failure that escapes the polling loop as its health instead of an unhandled rejection', async () => {
    // 夹具的 registry 已持有该 kind；这个从空开始，以便插件注册它。
    const value = host({ sources: emptyRegistry(), ready: Promise.reject(new Error('lock held')) })
    const disposers: (() => unknown)[] = []
    applyGithub({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(value.health.github).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    for (const dispose of disposers) await dispose()
    value.store.close()
  })
  /** GitHub 返回的 Issue，由 alice 开启。 */
  const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({ id: 1000 + number, number, title: 'Login fails',
    body: 'details', state: 'open', created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/acme/widgets/issues/${number}`,
    user: { login: 'alice', type: 'User' }, ...fields })
  /** 按 `pollRound` 在 `since` 之后读取的 GitHub 视图：每个 Issue 一条通知、各 Issue，以及按编号索引的对话评论。 */
  function notify(h: ReturnType<typeof host>, issues: GithubIssue[], comments: Record<number, GithubComment[]> = {},
    since = '2026-09-08T00:00:00.000Z') {
    h.store.set('github-since', since)
    // 通知的新旧程度取决于它所报告的最新变更：该 Issue 或其最新评论。
    const updated = (item: GithubIssue) => [item.updated_at ?? item.created_at,
      ...(comments[item.number] ?? []).map(comment => comment.updated_at ?? '')].sort().at(-1)!
    const notifications = issues.map(item => ({ id: `n${item.number}`, updated_at: updated(item), reason: 'mention',
      repository: { full_name: 'acme/widgets' },
      subject: { url: `https://api.github.com/repos/acme/widgets/issues/${item.number}`, type: 'Issue', title: item.title } }))
    // 属于 PR 的 Issue 也会作为该 PR 应答。
    const routes: Record<string, unknown> = { notifications, ...Object.fromEntries(issues.flatMap(item => [[`issues/${item.number}`, item],
      [`pulls/${item.number}`, openPull(item.number)],
      [`issues/${item.number}/comments`, comments[item.number] ?? []]])) }
    return { routes, reads: github(h, routes) }
  }
  it('takes in a new Issue from its notification as a Trigger with its body, addressed to the agent when the body mentions it', async () => {
    const h = host()
    // 以 Issue 地址报告的 pull request，以及 agent 自己开启的 Issue，都不会带来内容。
    const agents = { user: { login: 'agent-bot', type: 'User' } }
    notify(h, [issue(12, { body: '@agent-bot please fix the login' }), issue(13, { pull_request: { url: 'x' } }), issue(14, agents)])
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledOnce()
    const id = key('github-issue', '12')
    const url = 'https://github.com/acme/widgets/issues/12'
    expect(h.receive.mock.calls[0]![0]).toEqual({ id, source: 'github', threads: [{ source: 'github', id: '12' }],
      actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-09T00:00:00Z',
      text: 'Login fails\n\n@agent-bot please fix the login', addressed: 'mention', channel: githubChannel(12, url), url,
      meta: { number: 12, isPr: false, kind: 'issue' } })
    // 允许的发送者的提及会在该次轮询中构成显式请求。
    expect(h.engine.candidate(id)?.strength).toBe('explicit')
    expect(h.store.threads.get('github:12')!.meta).toMatchObject({ title: 'Login fails', label: '#12 Login fails' })
    h.store.close()
  })
  it('takes in a comment on an earlier Issue from its notification, without the Issue body', async () => {
    const h = host()
    const url = 'https://github.com/acme/widgets/issues/12'
    const comment: GithubComment = { id: 5, body: '@agent-bot can you take this?', user: { login: 'alice', type: 'User' },
      html_url: `${url}#issuecomment-5`, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' }
    const { reads } = notify(h, [issue(12, { created_at: '2026-08-01T00:00:00Z' })], { 12: [comment] })
    await pollRound(h)
    const expected = commentTrigger(comment, { number: 12, isPr: false, url }, 'conversation', 'agent-bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expected])
    // Issue 只有其对话；评论从通知游标之后开始读取。
    const since = encodeURIComponent('2026-09-08T00:00:00.000Z')
    expect(reads.filter(path => path.includes('/comments'))).toEqual([`issues/12/comments?per_page=100&since=${since}`])
    h.store.close()
  })
  it('keeps one body Trigger for an Issue that a later poll reads again', async () => {
    const h = host()
    // 该 Issue 恰在轮询前开启，仍在下一次轮询所依据的游标之后。
    notify(h, [issue(12, { created_at: new Date(Date.now() - 1000).toISOString() })], {}, new Date(Date.now() - 60_000).toISOString())
    await pollRound(h)
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.store.read.threadTriggers('github:12', 10).map(trigger => trigger.id)).toEqual([key('github-issue', '12')])
    expect(h.store.decisions.byThread('github:12').map(decision => decision.triggerIds)).toEqual([[key('github-issue', '12')]])
    h.store.close()
  })
  it('takes in an Issue without a mention as a Trigger that is not addressed, and a bot\'s Issue as automated', async () => {
    const h = host()
    notify(h, [issue(12, { body: 'Login fails on Safari' }), issue(15, { user: { login: 'dependabot[bot]', type: 'Bot' } })])
    await pollRound(h)
    const taken = (number: number) => h.receive.mock.calls.map(([trigger]) => trigger).find(trigger => trigger.meta.number === number)
    const [plain, bot] = [taken(12), taken(15)]
    expect(plain).toMatchObject({ id: key('github-issue', '12'), human: true })
    expect(plain).not.toHaveProperty('addressed')
    expect(bot).toMatchObject({ id: key('github-issue', '15'), human: false })
    // 该 Issue 自身的读取位置会越过本轮已读取的内容。
    expect(Date.parse(h.store.get<string>('github-cursor:12')!)).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
    h.store.close()
  })
  it('keeps an Issue body the unclaimed-Issue Source stored before as the one Trigger of that body', async () => {
    const h = host()
    const stored: Trigger = { id: key('github-issue', '12'), source: 'github-issue', threads: [{ source: 'github', id: '12' }],
      actor: { source: 'github', id: 'alice' },
      human: true, at: '2026-09-09T00:00:00Z', text: 'Login fails\n\n@agent-bot please fix the login', meta: { number: 12, isPr: false,
        eligibleAt: '' } }
    h.store.triggers.save(stored)
    notify(h, [issue(12, { body: '@agent-bot please fix the login' })])
    await pollRound(h)
    expect(await h.receive.mock.results[0]!.value).toBe('duplicate')
    expect(h.store.read.threadTriggers('github:12', 10)).toEqual([stored])
    h.store.close()
  })
  it('takes in an Issue body only when the Issue was opened since the cursor, not when an edit or a comment changed it', async () => {
    const h = host()
    // 无论谁编辑正文，其作者都会成为 actor，因此由编辑添加的提及不会被读取。
    const edited = issue(12, { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
      body: 'Login fails. @agent-bot can you look?' })
    notify(h, [edited])
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    h.store.close()
  })
  it('reads a PR that a notification names by its Issue address as the PR', async () => {
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const review = { id: 4, state: 'APPROVED', commit_id: 'abc', user: { login: 'carol', type: 'User' },
      submitted_at: '2026-09-09T00:00:00Z' }
    const reads = github(h, { notifications: [notification(9)], 'issues/9': { ...issue(9), pull_request: { url: 'x' } },
      'pulls/9/reviews': [review],
      'pulls/9': { title: 'Fix', state: 'open', html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'carol' },
        head: { sha: 'abc', ref: 'fix', repo: null } } })
    await pollRound(h)
    expect(bare(reads)).toEqual(['notifications', 'issues/9', 'pulls/9', 'issues/9/comments', 'pulls/9/comments', 'pulls/9/reviews'])
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ text: '对提交 abc 的 APPROVED review',
      meta: expect.objectContaining({ isPr: true }) })])
    h.store.close()
  })
  it('moves no read position when the Source is turned off during a read', async () => {
    const h = host()
    const comment: GithubComment = { id: 5, body: 'more', user: { login: 'alice', type: 'User' }, created_at: '2026-09-09T00:00:00Z',
      updated_at: '2026-09-09T00:00:00Z' }
    const { routes } = notify(h, [issue(12, { created_at: '2026-08-01T00:00:00Z' })], { 12: [comment] })
    routes['issues/12/comments'] = () => {
      h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, github: { enabled: false, config: {} } } })
      return [comment]
    }
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('github-cursor:12')).toBeUndefined()
    expect(h.store.get('github-since')).toBe('2026-09-08T00:00:00.000Z')
    h.store.close()
  })
  it('lets a ticket follow its source PR or the agent\'s PR from its branch, and refuses others', async () => {
    const h = host()
    const source = commentTrigger({ id: 1, body: '@agent-bot fix', user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/30#issuecomment-1' }, { number: 30, isPr: true }, 'conversation', 'agent-bot')
    h.store.triggers.save(source)
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('fix-1'), origin: { triggerId: source.id, triggerIds: [source.id] } })
    h.store.tickets.save({ ...openTicket('t2'), execution: execution('other-2'), ...pulled(41) })
    const agents = (number: number, ref: string, repo = 'acme/widgets'): Pull => ({ ...openPull(number), user: { login: 'agent-bot' },
      head: { sha: 'abc', ref, repo: { full_name: repo } } })
    expect(claimPull(h, 't1', agents(40, 'agent/fix-1', 'someone/fork'))).toContain('PR 不属于这个工单')
    expect(claimPull(h, 't1', { ...openPull(31), head: { sha: 'abc', ref: 'agent/fix-1',
      repo: { full_name: 'acme/widgets' } } })).toContain('PR 不属于这个工单')
    expect(claimPull(h, 't1', agents(41, 'agent/fix-1'))).toBe('PR 已属于另一个未结工单')
    // 未开启的 PR 不会被绑定，而这并不构成拒绝。
    expect(claimPull(h, 't1', { ...agents(42, 'agent/fix-1'), state: 'closed' })).toBeUndefined()
    expect(pullOf(h.store.tickets.get('t1')!)).toBeUndefined()
    expect(claimPull(h, 't1', openPull(30))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'github:30', own: false }])
    expect(claimPull(h, 't1', agents(43, 'agent/fix-1'))).toBeUndefined()
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'github:30', own: false }, { thread: 'github:43', own: true }], channels: [] })
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(43)
    expect(h.store.threads.get('github:43')).toMatchObject({ subscriptions: ['t1'], meta: { isPr: true, prAuthor: 'agent-bot' } })
    // ticket 起始所依据的 PR 并非它自己开启的：当它自己的 PR 合并时，ticket 会结束而不是追随该 PR。
    expect(await observePull(h, endedPull(43, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    expect(claimPull(h, 't1', openPull(30))).toBe('工单已结束，因为它的 PR 已关闭')
    h.store.close()
  })
})

describe('source context', () => {
  it('gives each kind the setup problem whose place it is', () => {
    const feishu: SetupProblem = { place: 'feishu', code: 'feishuNoBot', values: {}, detail: 'No bot' }
    const github: SetupProblem = { place: 'github', code: 'agentCliUnset', values: {}, detail: 'No CLI' }
    const h = host({ feishuProblem: feishu, setupProblem: github })
    expect(h.context(feishuKind).problem).toBe(feishu)
    expect(h.context(githubKind).problem).toBe(github)
    expect(h.context({ kind: 'probe', health: [] }).problem).toBeUndefined()
    h.store.close()
  })
  it('lets a kind report only its own health entries', () => {
    const h = host()
    const github = h.context(githubKind)
    github.report('github', { state: 'ready', detail: 'ok' })
    expect(h.health.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => github.report('feishu', { state: 'error', detail: 'x' })).toThrow('没有健康条目 feishu')
    h.store.close()
  })
  it('patches a Thread\'s meta as it is now, so a change another writer made meanwhile stays', () => {
    const h = host()
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: { title: 'old', pollError: 'boom' } })
    const snapshot = h.store.threads.get('github:7')!
    h.store.threads.save({ ...snapshot, subscriptions: ['t'], meta: { ...snapshot.meta, label: '#7 old' } })
    h.threads.patch('github:7', { title: 'new', pollError: undefined })
    expect(h.store.threads.get('github:7')).toMatchObject({ subscriptions: ['t'], meta: { title: 'new', label: '#7 old' } })
    expect(h.store.threads.get('github:7')!.meta).not.toHaveProperty('pollError')
    // 不存在的 Thread 不会被创建。
    h.threads.patch('github:8', { title: 'x' })
    expect(h.store.threads.get('github:8')).toBeUndefined()
    h.store.close()
  })
  it('reads the configuration of an instance that is on, removes a record set to undefined, and merges ticket meta', () => {
    const h = host()
    expect(h.config('feishu')).toMatchObject({ directMessages: true })
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, feishu: { enabled: false, config: {} } } })
    expect(h.config('feishu')).toBeUndefined()
    h.state.set('github-retry', { 1: {} })
    h.state.set('github-retry', undefined)
    expect(h.store.keys('github-retry')).toEqual([])
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('one') })
    h.tickets.bindThread('t1', { source: 'github', id: '4' }, true)
    // ticket 会追随该 Thread；它的其他字段保持原样。
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'github:4', own: true }], execution: execution('one'),
      origin: { triggerId: 'source-t1' } })
    h.store.close()
  })
})
it('reports GitHub as failing only after the configured number of consecutive failed polls', () => {
  const eof = new Error('Get "https://api.github.com/x": EOF')
  expect(pollFailure(1, 3, eof)).toBeUndefined()
  expect(pollFailure(2, 3, eof)).toBeUndefined()
  expect(pollFailure(3, 3, eof)).toEqual({ state: 'error', detail: '连续 3 次轮询失败；最近一次：Error: Get "https://api.github.com/x": EOF', code: 'pollFailures', values: { count: '3', error: 'Error: Get "https://api.github.com/x": EOF' } })
  expect(githubKind.schema.parse({})).toEqual({ repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3, observeIssues: false,
    observePulls: false, observeComments: false, observeCi: false })
})
// 假的 bot CLI 是一个 POSIX shell 脚本（`#!/bin/sh` 配合 `sleep`），消费者在其支持的每个平台上都会
// 启动它；Windows 无法执行 shebang 脚本，因此该代码块仅在 POSIX 上验证（范围外）。
describe.skipIf(process.platform === 'win32')('feishu event consumer', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  // 假的 CLI 是真实进程，在整个测试套件运行时启动会更慢。
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-consumer-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  /**
   * 一个 bot CLI，其 `event consume` 按 `mode` 描述行事：`never` 表示进入 ready，`warn` 表示 ready 后警告一次，`ready`
   * 表示保持运行，`flaky` 表示在首次 ready 后退出。它会记录每次运行以及最近一次的 PID。
   */
  function cli(mode: 'never' | 'warn' | 'ready' | 'flaky' | 'events' | 'late'): string {
    const path = join(dir, 'lark-bot')
    writeFileSync(path, `#!/bin/sh
  [ "$1" = event ] || { echo '{"ok":true,"data":{}}'; exit 0; }
  n=$(cat '${dir}/runs' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${dir}/runs'; echo $$ > '${dir}/pid'
  case ${mode} in
    never) exec sleep 60 ;;
    warn) echo '[event] ready' >&2; echo 'WARN the connection was reset' >&2; exec sleep 60 ;;
    ready) echo '[event] ready' >&2; exec sleep 60 ;;
    flaky) echo '[event] ready' >&2; [ "$n" -gt 1 ] && exec sleep 60; exit 1 ;;
    events) echo '[event] ready' >&2; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
    late) echo '[event] ready' >&2; sleep 1; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
  esac
  `, { mode: 0o755 })
    return path
  }
  const runs = () => existsSync(join(dir, 'runs')) ? Number(readFileSync(join(dir, 'runs'), 'utf8')) : 0
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  /** Feishu Source 的 context，基于一个 Feishu Source 已开启的新 Store，并以 `cli` 作为 bot CLI。 */
  function consumerSource(path: string, config: Record<string, unknown> = { chats: [] }) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(feishuKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const policy = () => settingsPolicy(store.settings(), sources)
    const engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox })
    const deployment = testDeployment({ feishu: { ...testDeployment().feishu!, cli: path } })
    const health = board.all
    const commands = new Commands(() => deployment, {}, controller.signal)
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(), configured: () => true,
      receive: (trigger: Trigger) => engine.receive(trigger) }
    const turnOff = () => store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: false, config: { chats: [] } } } }))
    return { ctx: sourceContextOf(deps, feishuKind), health, store, turnOff }
  }

  /** `event consume` 输出的消息事件行；群消息会提及 bot。 */
  const event = (id: string, chat: string, type: 'group' | 'p2p') => JSON.stringify({ message_id: id, chat_id: chat, chat_type: type,
    sender_id: 'ou_alice', sender_type: 'user', content: 'fix it', create_time: String(Date.now()),
    ...type === 'group' ? { mentions: [{ id: 'ou_bot', name: 'Bot' }] } : {} })
  it('takes in the event lines it reads, records each chat as direct or not, and reports a malformed line without stopping', async () => {
    writeFileSync(join(dir, 'events'), [event('om_1', 'oc_group', 'group'), event('om_2', 'oc_dm', 'p2p'), 'not json',
      event('om_3', 'oc_group', 'group')].join('\n') + '\n')
    const { ctx, health, store } = consumerSource(cli('events'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(feishuTriggerId('om_3'))).toBeDefined(), until)
    expect(['om_1', 'om_2'].map(id => store.triggers.get(feishuTriggerId(id))?.meta.direct)).toEqual([false, true])
    expect(store.get(KV.feishu.chats)).toEqual({ oc_group: false, oc_dm: true })
    expect(health.feishu).toMatchObject({ state: 'error', detail: expect.stringContaining('JSON') })
    controller.abort(); await running; store.close()
  }, 20_000)
  it('drops the events it reads once the Source is off', async () => {
    writeFileSync(join(dir, 'events'), event('om_9', 'oc_group', 'group') + '\n')
    const { ctx, health, store, turnOff } = consumerSource(cli('late'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    turnOff()
    // CLI 在 ready 一秒后打印该事件，此时消费者尚未因 Source 关闭而停止。
    await vi.waitFor(() => expect(existsSync(join(dir, 'printed'))).toBe(true), until)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(store.triggers.get(feishuTriggerId('om_9'))).toBeUndefined()
    controller.abort(); await running; store.close()
  }, 20_000)
  it('keeps a chat\'s history cursor when its read fails, and recovers known direct chats only while direct messages are on', async () => {
    const hour = new Date(Date.now() - 3_600_000).toISOString()
    const recovered = async (directMessages: boolean) => {
      const chat = (chatId: string) => ({ chatId, listen: 'mentions' })
      const { ctx, health, store } = consumerSource(cli('ready'), { chats: [chat('oc_a'), chat('oc_b')], directMessages })
      store.set(KV.feishu.chats, { oc_dm: true, oc_a: false })
      for (const chat of ['oc_a', 'oc_b', 'oc_dm']) store.set(KV.feishu.history(chat), hour)
      const chats: string[] = []
      const lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async args => {
        const params = args[2] === '/open-apis/im/v1/messages' ? JSON.parse(args.at(-1)!) as { container_id: string } : undefined
        if (params) chats.push(params.container_id)
        if (params?.container_id === 'oc_a') throw new Error('rate limited')
        return { has_more: false, items: [] }
      })
      const stop = new AbortController()
      const loops = runFeishu(ctx, AbortSignal.any([stop.signal, controller.signal]))
      await vi.waitFor(() => expect(['ready', 'error']).toContain(health.history?.state), until)
      stop.abort(); await loops; lark.mockRestore()
      const cursors = Object.fromEntries(['oc_a', 'oc_b', 'oc_dm'].map(chat => [chat, store.get(KV.feishu.history(chat))]))
      const result = { chats, cursors, history: health.history }
      store.close(); rmSync(join(dir, 'db.sqlite'), { force: true }); rmSync(join(dir, 'db.sqlite-wal'), { force: true })
      rmSync(join(dir, 'db.sqlite-shm'), { force: true })
      return result
    }
    const on = await recovered(true)
    expect(on.chats).toEqual(['oc_a', 'oc_b', 'oc_dm'])
    expect(on.history).toMatchObject({ state: 'error', detail: expect.stringContaining('oc_a: Error: rate limited') })
    expect(on.cursors.oc_a).toBe(hour)
    expect(Date.parse(on.cursors.oc_b!)).toBeGreaterThan(Date.parse(hour))
    expect(Date.parse(on.cursors.oc_dm!)).toBeGreaterThan(Date.parse(hour))
    const off = await recovered(false)
    expect(off.chats).toEqual(['oc_a', 'oc_b'])
    expect(off.cursors.oc_dm).toBe(hour)
  }, 20_000)
  it('reports an error when the consumer is not ready within 45 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ctx, health, store } = consumerSource(cli('never'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(runs()).toBe(1), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error',
      detail: expect.stringContaining('did not become ready within 45 seconds') }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reports a warning the consumer prints as an error', async () => {
    const { ctx, health, store } = consumerSource(cli('warn'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error', detail: 'WARN the connection was reset' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('stops the consumer within five seconds once the Source is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { ctx, health, store, turnOff } = consumerSource(cli('ready'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready', detail: 'Listening for bot events' }), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    turnOff()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'paused', code: 'sourceOff' }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('starts the consumer again after it exits, and is ready once the next run listens', async () => {
    const { ctx, health, store } = consumerSource(cli('flaky'))
    running = runFeishu(ctx, controller.signal)
    const exited = { state: 'error', detail: expect.stringContaining('exited (1, ready=true)') }
    await vi.waitFor(() => expect(health.feishu).toMatchObject(exited), until)
    // 第一次重启会等待一秒。
    await vi.waitFor(() => expect(runs()).toBe(2), until)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
})

describe('observing the GitHub repository', () => {
  /** 前天第 `hour` 小时，完全在轮询时间窗内。 */
  const at = (hour: number) => new Date(Math.floor(Date.now() / 86_400_000 - 2) * 86_400_000 + hour * 3_600_000).toISOString()
  const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({ id: 1000 + number, number, title: `Issue ${number}`,
    body: 'details', state: 'open', created_at: at(0), updated_at: at(0),
    html_url: `https://github.com/acme/widgets/issues/${number}`, user: { login: 'carol', type: 'User' }, ...fields })
  const observe = (h: ReturnType<typeof host>, config: Record<string, boolean>) =>
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, github: { enabled: true, config } } })
  /** GitHub 按仓库各列表与默认分支应答的视图；携带未变更列表 ETag 的请求会得到 304。 */
  function repository(h: ReturnType<typeof host>, answers: { issues?: unknown[]; comments?: unknown[]; reviewComments?: unknown[];
    branch?: { sha: string; checks: unknown[] } }) {
    const calls: string[][] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      const bare = args[1]!.replace(/^repos\/acme\/widgets\/?/, '').split('?')[0]!
      const listed = (list: unknown[] | undefined) => `HTTP/2.0 200 OK\r\nETag: "same"\r\n\r\n${JSON.stringify(list ?? [])}`
      if (bare === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (args.includes('If-None-Match: "same"')) throw commandError({ stderr: 'gh: HTTP 304', code: 1 })
      if (bare === 'issues') return listed(answers.issues)
      if (bare === 'issues/comments') return listed(answers.comments)
      if (bare === 'pulls/comments') return listed(answers.reviewComments)
      if (bare === '') return JSON.stringify({ default_branch: 'main' })
      if (bare === 'commits/main') return JSON.stringify({ sha: answers.branch!.sha })
      if (bare.endsWith('/check-runs')) return JSON.stringify([{ check_runs: answers.branch!.checks }])
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    return calls
  }
  it('takes in the new Issues and PRs from when it started observing them, and asks again with the ETag while nothing is newer',
    async () => {
    const h = host()
    observe(h, { observeIssues: true, observePulls: true })
    h.store.set('github-since', at(-24))
    h.store.set('github-stream:issues', { since: at(0), started: { issues: at(0), pulls: at(0) } })
    const calls = repository(h, { issues: [issue(3, { created_at: at(-24), updated_at: at(1) }),
      issue(4, { created_at: at(2), updated_at: at(2) }),
      { ...issue(5, { created_at: at(3), updated_at: at(3) }), pull_request: { url: 'x' } },
      issue(6, { created_at: at(4), updated_at: at(4), user: { login: 'agent-bot', type: 'User' } })] })
    await pollRound(h)
    // #3 在 Source 观察 Issues 之前就已开启，而 #6 是 agent 自己的。
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind, trigger.id]))
      .toEqual([[4, 'issue', issueTrigger(issue(4), 'agent-bot').id], [5, 'pull', issueTrigger(issue(5), 'agent-bot').id]])
    const started = { issues: at(0), pulls: at(0) }
    expect(h.store.get('github-stream:issues')).toEqual({ since: cursorAt(at(4)), started })
    const list = () => calls.filter(args => args[1]!.startsWith('repos/acme/widgets/issues?'))
    expect(list()[0]![1]).toContain(`since=${encodeURIComponent(at(0))}`)
    // 下一轮会在最新 Issue 处重复该请求，再下一轮发送它的 ETag，GitHub 对此返回 304。
    await pollRound(h)
    expect(h.store.get('github-stream:issues')).toEqual({ since: cursorAt(at(4)), started, etag: '"same"' })
    h.receive.mockClear()
    await pollRound(h)
    expect(list().at(-1)).toEqual(expect.arrayContaining(['-H', 'If-None-Match: "same"']))
    expect(h.receive).not.toHaveBeenCalled()
    // 关闭后，该 stream 会忘记原先的位置，因此再次开启时会从头开始。
    observe(h, {})
    await pollRound(h)
    expect(h.store.get('github-stream:issues')).toBeUndefined()
    h.store.close()
  })
  it('takes in the repository\'s conversation and review comments, on the Issue or PR each is on', async () => {
    const h = host()
    observe(h, { observeComments: true })
    h.store.set('github-since', at(-24))
    for (const stream of ['comments', 'review-comments']) {
      h.store.set(`github-stream:${stream}`, { since: at(0), started: { comments: at(0) } })
    }
    const comment = (id: number, fields: Record<string, unknown>) => ({ id, body: `comment ${id}`, user: { login: 'carol', type: 'User' },
      created_at: at(1), updated_at: at(1), ...fields })
    repository(h, {
      comments: [comment(1, { issue_url: 'https://api.github.com/repos/acme/widgets/issues/7',
        html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }),
        comment(2, { issue_url: 'https://api.github.com/repos/acme/widgets/issues/9',
          html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-2',
          user: { login: 'dependabot[bot]', type: 'Bot' } })],
      reviewComments: [comment(3, { pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/9', path: 'src/a.ts', line: 4,
        html_url: 'https://github.com/acme/widgets/pull/9#discussion_r3' })] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.isPr, trigger.meta.kind, trigger.human]))
      .toEqual([[7, false, 'conversation', true], [9, true, 'conversation', false], [9, true, 'inline', true]])
    h.store.close()
  })
  it('fails the round for a stream whose read fails, keeps its cursor, and still reads the other streams', async () => {
    const h = host()
    observe(h, { observeIssues: true, observeComments: true })
    h.store.set('github-since', at(-24))
    const kind = (stream: string) => stream === 'issues' ? 'issues' : 'comments'
    for (const stream of ['issues', 'comments', 'review-comments']) {
      h.store.set(`github-stream:${stream}`, { since: at(0), started: { [kind(stream)]: at(0) } })
    }
    const comment = { id: 1, body: 'looks off', user: { login: 'carol', type: 'User' }, created_at: at(1), updated_at: at(1),
      issue_url: 'https://api.github.com/repos/acme/widgets/issues/7', html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }
    repository(h, { comments: [comment] })
    const run = h.commands.run as unknown as { getMockImplementation(): (program: string, args: string[]) => Promise<string> }
    const answer = run.getMockImplementation()
    vi.mocked(h.commands.run).mockImplementation(async (program, args) => {
      if (args[1]!.startsWith('repos/acme/widgets/issues?')) throw refused(502, 'Bad Gateway')
      return answer(program, args)
    })
    await expect(pollRound(h)).rejects.toThrow(/issues: .*502/)
    expect(h.store.get('github-stream:issues')).toEqual({ since: at(0), started: { issues: at(0) } })
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: 'looks off' }))
    expect(h.store.get('github-stream:comments')).toEqual({ since: cursorAt(at(1)), started: { comments: at(0) } })
    h.store.close()
  })
  it('reads a stream whose cursor is older than the polling horizon from the horizon, without the ETag of the older request', async () => {
    const h = host()
    observe(h, { observeIssues: true })
    h.store.set('github-since', at(-24))
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
    h.store.set('github-stream:issues', { since: old, started: { issues: old }, etag: '"same"' })
    const calls = repository(h, {})
    await pollRound(h)
    const list = calls.find(args => args[1]!.startsWith('repos/acme/widgets/issues?'))!
    expect(list).not.toContain('-H')
    const since = Date.parse(decodeURIComponent(/since=([^&]+)/.exec(list[1]!)![1]!))
    // 时间窗的整点边界。
    expect(Date.now() - POLL_HORIZON_MS - since).toBeGreaterThanOrEqual(0)
    expect(Date.now() - POLL_HORIZON_MS - since).toBeLessThan(3_600_000)
    h.store.close()
  })
  it('starts the default branch\'s CI afresh when the default branch is renamed, without a Trigger', async () => {
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since', at(-24))
    h.store.set('github-branch-ci', { branch: 'master', failures: [], revision: 2 })
    const answers = { branch: { sha: 'ddd4444', checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' }] } }
    repository(h, answers)
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('github-branch-ci')).toEqual({ branch: 'main', failures: ['lint'], revision: 2 })
    h.store.close()
  })
  it('takes in new PRs only from when their switch turned on, apart from when new Issues were', async () => {
    const h = host()
    observe(h, { observeIssues: true, observePulls: true })
    h.store.set('github-since', at(-24))
    // 该 stream 从第 0 小时开始接收 Issues；PR 直到现在才开启。
    h.store.set('github-stream:issues', { since: at(0), started: { issues: at(0) } })
    repository(h, { issues: [{ ...issue(5, { created_at: at(2), updated_at: at(2) }), pull_request: { url: 'x' } },
      issue(6, { created_at: at(3), updated_at: at(3) })] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind])).toEqual([[6, 'issue']])
    expect(h.store.get<{ started: Record<string, string> }>('github-stream:issues')!.started).toEqual({ issues: at(0), pulls: expect.any(String) })
    // 关闭后，某个 kind 会忘记它的起点。
    observe(h, { observePulls: true })
    await pollRound(h)
    expect(Object.keys(h.store.get<{ started: Record<string, string> }>('github-stream:issues')!.started)).toEqual(['pulls'])
    h.store.close()
  })
  it('keeps a stream\'s cursor five seconds before its newest item, and a stale cursor on the hour, so the ETag is sent again', async () => {
    const h = host()
    observe(h, { observeIssues: true })
    h.store.set('github-since', at(-24))
    h.store.set('github-stream:issues', { since: at(0), started: { issues: at(0) } })
    repository(h, { issues: [issue(6, { created_at: at(3), updated_at: at(3) })] })
    await pollRound(h)
    expect(h.store.get<{ since: string }>('github-stream:issues')!.since).toBe(new Date(Date.parse(at(3)) - 5000).toISOString())
    // 落在时间窗之前的游标会从时间窗的整点开始读取，下一轮同样如此，并发送该 ETag。
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
    h.store.set('github-stream:issues', { since: old, started: { issues: old } })
    const calls = repository(h, {})
    await pollRound(h); await pollRound(h)
    const lists = calls.filter(args => args[1]!.startsWith('repos/acme/widgets/issues?'))
    const since = (args: string[]) => decodeURIComponent(/since=([^&]+)/.exec(args[1]!)![1]!)
    expect(since(lists[0]!)).toBe(since(lists[1]!))
    expect(Date.parse(since(lists[0]!)) % 3_600_000).toBe(0)
    expect(lists[1]).toEqual(expect.arrayContaining(['-H', 'If-None-Match: "same"']))
    h.store.close()
  })
  it('gives each change of the default branch\'s CI its own id, also when one commit fails, passes and fails again', async () => {
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since', at(-24))
    const check = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion })
    const answers = { branch: { sha: 'eee5555', checks: [check('lint', 'success')] } }
    repository(h, answers)
    await pollRound(h)
    for (const conclusion of ['failure', 'success', 'failure']) {
      answers.branch = { sha: 'eee5555', checks: [check('lint', conclusion)] }
      await pollRound(h)
    }
    const ids = h.receive.mock.calls.map(([trigger]) => trigger.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // 关闭再开启后，CI 会从新的首次查看开始，而其 id 继续递增。
    observe(h, {})
    await pollRound(h)
    observe(h, { observeCi: true })
    await pollRound(h)
    answers.branch = { sha: 'eee5555', checks: [check('lint', 'success')] }
    await pollRound(h)
    expect(new Set(h.receive.mock.calls.map(([trigger]) => trigger.id)).size).toBe(4)
    h.store.close()
  })
  it('tells of the default branch\'s CI when its failed checks change and once it passes again, after a first look', async () => {
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since', at(-24))
    const check = (name: string, conclusion: string | null) => ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion })
    const answers = { branch: { sha: 'aaa1111', checks: [check('lint', 'success'), check('e2e', 'success')] } }
    repository(h, answers)
    const texts = () => h.receive.mock.calls.map(([trigger]) => trigger.text.split('\n')[0])
    await pollRound(h)
    expect(texts()).toEqual([])
    answers.branch = { sha: 'bbb2222', checks: [check('lint', 'failure'), check('e2e', null)] }
    await pollRound(h)
    answers.branch = { sha: 'bbb2222', checks: [check('lint', 'failure'), check('e2e', 'success')] }
    await pollRound(h)
    // 仍在运行的 rerun 尚不算恢复；只有所有检查都通过时才会报告恢复。
    answers.branch = { sha: 'ccc3333', checks: [check('lint', null), check('e2e', null)] }
    await pollRound(h)
    answers.branch = { sha: 'ccc3333', checks: [check('lint', 'success'), check('e2e', 'success')] }
    await pollRound(h)
    expect(texts()).toEqual(['CI 失败 1/2 于 main（提交 bbb2222）：lint；1 个仍在运行', 'CI 通过 2/2 于 main（提交 ccc3333）'])
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ human: false, actor: { id: '' }, threads: [{ source: 'github', id: 'ci:main' }],
      meta: { ci: true, branch: 'main', sha: 'bbb2222' }, url: 'https://github.com/acme/widgets/commit/bbb2222' })
    expect(h.receive.mock.calls[0]![0].text).toContain('用 github/commits/bbb2222/checks 读取每一项检查。')
    h.store.close()
  })
})
