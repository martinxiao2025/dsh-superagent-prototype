/** Session 工具注册、按角色限定的资源读取，以及路由/设置工具的契约。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TICKET_STATES } from '../src/app/cards.ts'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { UserError } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { IM_WORDS, NOTE_WORDS } from '../src/infra/text.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')
const read = (resource: string, page: { offset?: number; limit?: number } = {}) =>
  h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, ...page })

it('以资源形式读取列表、工单、决定、设置、提示词与模型', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  const tickets = await read('tickets', { limit: 1 })
  expect(tickets).toEqual({ items: [expect.objectContaining({ ticket_id: expect.any(String), state: 'working' })], next_offset: 1 })
  expect(await read('tickets', { offset: 1 })).toMatchObject({ items: [expect.objectContaining({ ticket_id: ticket.id })], next_offset: null })
  const triggers = await read('triggers') as { items: { trigger_id: string }[] }
  expect(triggers.items.map(item => item.trigger_id)).toEqual([expect.any(String), trigger.id])
  expect(await read('threads')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ tickets: [ticket.id] })]) })
  const decisions = await read('decisions') as { items: { decision_id: string; read: string }[] }
  const accepted = expect.objectContaining({ kind: 'accept', ticket_id: ticket.id, trigger_ids: [trigger.id], read: expect.stringMatching(/^decision\//) })
  expect(decisions.items).toContainEqual(accepted)
  expect(await read(decisions.items.at(-1)!.read)).toMatchObject({ kind: 'accept', ticket_id: ticket.id, mandate: { strength: 'explicit' } })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ ticket_id: ticket.id, state: 'working', directory: ticket.execution!.directory,
    trigger_id: trigger.id, assignments: { items: [expect.objectContaining({ state: 'running' })] }, assignment: `ticket/${ticket.id}/assignment` })
  // 设置标出每个块的修订号并包含小块；块按保存时使用的名称整体读取。
  const settings = await read('settings')
  expect(settings).toMatchObject({ eval: { value: { mode: 'auto' } }, policy: { revision: expect.any(Number), allowed: { feishu: 1, github: 1 }, read: 'settings/policy' },
    pause: { value: { paused: false } }, sources: expect.arrayContaining([expect.objectContaining({ id: 'github', read: 'settings/source:github' })]) })
  expect(JSON.stringify(settings)).not.toContain('ou_alice')
  for (const block of ['policy', 'eval', 'executor', 'pause', 'source:github']) {
    const page = await read(`settings/${block}`) as { text: string }
    expect(JSON.parse(page.text)).toEqual({ block, revision: h.runtime.store.blockRevision(block as 'policy'), value: h.runtime.settings.block(block).value })
  }
  expect(JSON.parse((await read('settings/policy') as { text: string }).text).value.sources.feishu.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
  await expect(read('settings/source:retired')).rejects.toThrow('Unknown settings block')
  const skills = { built_in: ['dsh-superagent-cn-feishu', 'dsh-superagent-cn-github'], team: [] }
  expect(await read('prompts')).toMatchObject({ revision: 0, read: 'prompts/0', skills, items: [expect.objectContaining({ revision: 0 })], next_offset: null })
  const models = [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }]
  const catalog = { default: { provider: 'p', model: 'm1' }, groups: [{ id: 'p', name: 'Provider', models }], failures: [] }
  Object.assign(h.controller, { modelCatalog: vi.fn(async () => catalog) })
  expect(await read('models')).toMatchObject({ providers: [{ id: 'p', count: 2, read: 'models/p' }], roles: expect.any(Object) })
  expect(await read('models/p', { limit: 1 })).toEqual({ items: [models[0]], next_offset: 1 })
  await expect(read('ticket')).rejects.toThrow('Unknown context resource')
  // 列表页最多容纳 50 条，提示词历史也是如此。
  const config = h.runtime.prompts.current().config
  for (let revision = 0; revision < 51; revision++) h.runtime.prompts.save({ ...config, scope: `Scope ${revision}.` }, revision, 'panel')
  expect(await read('prompts', { limit: 8000 })).toMatchObject({ items: expect.objectContaining({ length: 50 }), next_offset: 50 })
})

it('在 prompts 中列出团队覆盖后内置文本又发生变化的部件，并在 prompts/defaults 中提供内置部件', async () => {
  const read = (resource: string, offset = 0) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, offset, limit: 8000 })
  expect(await read('prompts')).not.toHaveProperty('default_changed')
  // 从早期版本内置文本编辑而来的覆盖。
  h.runtime.prompts.save({ ...defaultPrompts(), overrides: { 'runtime/dispatch': { text: '## dispatch\nOurs.', base: 'earlier' } } }, 0, 'panel')
  expect(await read('prompts')).toMatchObject({ default_changed: ['runtime/dispatch'] })
  // 逐页读取文本，再拼接为全文。
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read('prompts/defaults', offset) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  const defaults = JSON.parse(text) as { parts: Record<string, string> }
  expect(defaults.parts).toEqual(Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text])))
})

it('用提示词保存工具保存不带 base 的覆盖，拒绝任何版本都没有的部件，并丢弃回读时已移除的部件', async () => {
  const save = (overrides: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save',
    { config: { ...defaultPrompts(), overrides }, baseRevision: h.runtime.prompts.current().revision })
  await expect(save({ constructor: { text: 'x' } })).rejects.toThrow(new UserError('unknownPromptPart', { part: 'constructor' }))
  await save({ 'runtime/dispatch': { text: '## dispatch\nOurs.' } })
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // 已保存版本覆盖了本版本已不存在的部件：按读取原样保存回去会丢弃它。
  const { revision } = h.runtime.prompts.current(), read = { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch,
    'runtime/retired': { text: 'Old.', base: 'b' } } }
  h.runtime.store.set(KV.prompts.version(revision + 1), { revision: revision + 1, previousRevision: revision, savedAt: '', source: 'panel', config: read })
  h.runtime.store.set(KV.prompts.revision, revision + 1)
  await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config: read, baseRevision: revision + 1 })
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // 工具在其 schema 中只描述一次 overrides。
  const tool = h.tools.get(h.runtime.masterId)!.get('orchestrator_prompts_save') as unknown as { description: string }
  expect(tool.description).not.toContain('overrides')
})

it('不让执行器 Session 读取主 Session 的资源，它只列出自己的资源', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  for (const resource of ['tickets', 'triggers', 'threads', 'decisions', 'settings', 'prompts', 'models']) {
    await expect(h.runTool(sessionId, 'orchestrator_read', { resource })).rejects.toThrow('belongs to the main Session')
  }
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({ ticket_id: ticket.id })
  type Registered = { description: string; parameters: { properties: { resource: { description: string } } } }
  const registered = h.tools.get(sessionId)!.get('orchestrator_read') as unknown as Registered
  const offered = registered.description + registered.parameters.properties.resource.description
  for (const { name, executor } of RESOURCES) expect(offered.includes(`${name}:`), name).toBe(!!executor)
  expect(offered).not.toMatch(/preview/i)
})

it('以统一形态应答每个路由工具：其记录的决定、原因与工单卡片', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const card = expect.objectContaining({ ticket_id: ticket.id })
  const run = (name: string, args: unknown) => h.runTool(h.runtime.masterId, name, args)
  const route = async (item: Record<string, unknown>) => ((await run('orchestrator_route', { decisions: [item] })).results as unknown[])[0]
  const other = feishu('3', '@bot 顺便看看这个')
  h.runtime.receive(other); await h.runtime.idle()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })).toEqual({ trigger_id: other.id, kind: 'attach',
    reason: expect.any(String), ticket: card })
  const status = await run('orchestrator_ticket_request_status', { ticket_id: ticket.id })
  expect(status).toEqual({ reason: 'The worker is not waiting; nothing was sent', ticket: card })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'The build broke.' })
  expect(await run('orchestrator_ticket_retry', { ticket_id: ticket.id })).toEqual({ reason: 'Started a new assignment', ticket: card })
  const chatter = feishu('4', '@bot 谢谢')
  h.runtime.receive(chatter); await h.runtime.idle()
  expect(await route({ kind: 'ignore', trigger_id: chatter.id, reason: 'thanks' })).toEqual({ trigger_id: chatter.id, kind: 'ignore', decision: 'ignore',
    reason: 'thanks' })
  // 停止需要用户的停止消息，由准入研判；工单保留给出的原因。
  await expect(run('orchestrator_route', { decisions: [{ kind: 'stop', ticket_id: ticket.id, reason: 'Not needed after all' }] })).rejects.toThrow()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  const request = feishu('5', '@bot 不用修了')
  h.runtime.receive(request); await h.runtime.idle()
  const stopped = await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id, reason: 'Not needed after all' }) as { ticket: { state: string } }
  const ended = expect.objectContaining({ by: 'human', reason: 'Not needed after all' })
  expect(stopped).toEqual({ trigger_id: request.id, kind: 'stop', decision: 'stop', reason: 'Not needed after all',
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'stopped', ended }) })
  expect(TICKET_STATES).toContain(stopped.ticket.state)
})

it('一次调用按顺序路由多条触发，对被拒绝或失败的单项给出应答且不撤销其他项', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('2', '@bot 谢谢'), request = feishu('3', '@bot 另一个问题'), other = feishu('4', '@bot 顺便看看这个'), more = feishu('6', '@bot 还有这个')
  for (const trigger of [thanks, request, other, more]) h.runtime.receive(trigger)
  await h.runtime.idle()
  // 一次 attach 意外失败，如同数据库被占用时那样。
  const attach = h.runtime.engine.attach.bind(h.runtime.engine)
  vi.spyOn(h.runtime.engine, 'attach').mockImplementation((ticketId, triggerId, note) => {
    if (triggerId === more.id) throw new Error('database is locked')
    return attach(ticketId, triggerId, note)
  })
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    // 缺少工单的停止被单独拒绝。
    { kind: 'stop', trigger_id: request.id },
    { kind: 'accept', trigger_id: request.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' },
    { kind: 'attach', trigger_id: other.id, ticket_id: 'no-such-ticket' },
    { kind: 'attach', trigger_id: more.id, ticket_id: ticket.id },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: request.id, kind: 'stop', refused: 'stop needs ticket_id' },
    expect.objectContaining({ trigger_id: request.id, kind: 'accept', decision: 'accept', ticket: expect.objectContaining({ title: 'Other' }) }),
    { trigger_id: other.id, kind: 'attach', refused: 'Unknown ticket' },
    // 意外失败没有记录任何内容，该项可以重新发送。
    { trigger_id: more.id, kind: 'attach', refused: 'Not recorded: database is locked; retry this item' },
  ])
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
})

it('单独拒绝缺少其类型所需字段或超出字段上限的项并指名字段，未使用的字段则忽略', async () => {
  const triggers = ['2', '3', '4', '5', '6'].map(id => feishu(id, `@bot 请求 ${id}`))
  for (const trigger of triggers) h.runtime.receive(trigger)
  await h.runtime.idle()
  const [a, b, c, d, e] = triggers.map(trigger => trigger.id) as [string, string, string, string, string]
  const accept = { kind: 'accept', title: 'Fix', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: a },
    { ...accept, trigger_id: b, worktree_name: 'one-two-three-four-five' },
    { ...accept, trigger_id: c, worktree_name: 'fix-c', note: words(NOTE_WORDS + 1) },
    { ...accept, trigger_id: d, worktree_name: 'fix-d', title: '' },
    // 其他类型的字段无论是否为 null 都不会被读取。
    { kind: 'ignore', trigger_id: e, reason: 'chat', ticket_id: null, title: null, note: null },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: a, kind: 'accept', refused: 'accept needs worktree_name' },
    { trigger_id: b, kind: 'accept', refused: expect.stringMatching(/^worktree_name: /) },
    { trigger_id: c, kind: 'accept', refused: expect.stringMatching(new RegExp(`^note: .*${NOTE_WORDS} words`)) },
    { trigger_id: d, kind: 'accept', refused: 'accept needs title' },
    { trigger_id: e, kind: 'ignore', decision: 'ignore', reason: 'chat' },
  ])
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('按其卡片触发的批次决定候选：第二次接受保留第一次的结果，其他决定不得与其矛盾', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  h.runtime.receive(first); h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accept = { kind: 'accept', worktree_name: 'retitle', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: first.id, title: 'Retitle' },
    { ...accept, trigger_id: second.id, title: 'Another title' },
    { kind: 'ignore', trigger_id: second.id, reason: 'chat' },
  ] }) as { results: { ticket?: { ticket_id: string } }[] }
  const ticketId = results[0]!.ticket!.ticket_id
  expect(results).toEqual([
    expect.objectContaining({ trigger_id: first.id, decision: 'accept' }),
    expect.objectContaining({ trigger_id: second.id, decision: 'accept', reason: `Already accepted as ${ticketId}; title and acknowledgement unchanged` }),
    { trigger_id: second.id, kind: 'ignore', refused: `Decided in this call with ${first.id}, whose Decision took its batch` },
  ])
  expect(h.runtime.store.tickets.get(ticketId)!.title).toBe('Retitle')
})

it('在每个路由字段的描述中说明其上限，schema 把校验留给单项检查', () => {
  type Schema = { parameters: { properties: { decisions: { items: { properties: Record<string, { description?: string }> } } } } }
  const fields = (h.tools.get(h.runtime.masterId)!.get('orchestrator_route') as unknown as Schema).parameters.properties.decisions.items.properties
  const limits: Record<string, string[]> = { title: ['200 characters'], worktree_name: ['kebab-case', '32 characters'],
    acknowledgement: [`${IM_WORDS} words`], note: [`${NOTE_WORDS} words`, 'Never add implementation instructions'], reason: ['500 characters'] }
  for (const [field, phrases] of Object.entries(limits)) for (const phrase of phrases) expect(fields[field]!.description, field).toContain(phrase)
})

it('一次调用中，为停止消息到达的每个工单各停止一次', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const two = await h.acceptedTicket(feishu('3', '@bot 另一件事'))
  // 第二个工单也跟随第一个的线程，因此用户在那里的停止会到达两者。
  h.runtime.engine.bindThread(two.ticket.id, { source: 'feishu', id: `${CHAT}:om_1` }, false)
  const stop = feishu('7', '都先停一下', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(stop); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'stop', trigger_id: stop.id, ticket_id: one.ticket.id }, { kind: 'stop', trigger_id: stop.id, ticket_id: two.ticket.id }] }) as
    { results: Record<string, unknown>[] }
  expect(results.map(result => result.decision)).toEqual(['stop', 'stop'])
  expect([one, two].map(item => h.runtime.store.tickets.get(item.ticket.id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
})

it('在卡片上把主动型候选标记后与其他决定一起忽略，接受与否交给研判', async () => {
  const chat = feishu('2', '中午吃什么', { mentions: [] }), thanks = feishu('3', '@bot 谢谢'), proposal = feishu('4', '把标题改短一点', { mentions: [] })
  for (const trigger of [chat, thanks, proposal]) h.runtime.receive(trigger)
  await h.runtime.pump(); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    { kind: 'accept', trigger_id: proposal.id, title: 'Shorter title', worktree_name: 'short-title', acknowledgement: '收到。' },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: chat.id, kind: 'ignore', decision: 'ignore', reason: 'Ignored from its card, without a rule assessment; Lunch chat.' },
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: proposal.id, kind: 'accept', refused: expect.stringContaining('assess proactive candidates with orchestrator_eval') },
  ])
})

it('报告回复的状态：已发送，或会话无法再接收时被丢弃', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  const reply = (text: string) => h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text })
  expect(await reply('修好了。')).toEqual({ status: 'sent' })
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await reply('修好了，请看 PR。')).toEqual({ status: 'dropped' })
})

it('按即时消息的字数上限校验确认话术，而不是字符数', async () => {
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger); await h.runtime.idle()
  const accept = (acknowledgement: string) => h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement })
  await expect(accept(words(IM_WORDS + 1))).rejects.toThrow(`at most ${IM_WORDS} words`)
  expect(await accept(words(IM_WORDS))).toMatchObject({ decision: 'accept', ticket: { title: 'Fix' } })
})

it('按名称保存设置块，来源块带来源 id', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const github = { config: h.runtime.store.settings().sources.github!.config, revision: h.runtime.store.blockRevision('source:github') }
  const off = { enabled: false, config: github.config }
  await expect(save({ block: 'source', value: off, revision: github.revision })).rejects.toThrow('source names the Source')
  await expect(save({ block: 'source:github', value: off, revision: github.revision })).rejects.toThrow()
  expect(await save({ block: 'source', source: 'github', value: off, revision: github.revision })).toMatchObject({ saved: true })
  expect(h.runtime.store.settings().sources.github?.enabled).toBe(false)
  expect(await save({ block: 'pause', value: { paused: true }, revision: 0 })).toEqual({ paused: true })
})

it('预览提示词配置而不保存，且只针对所编辑的修订号保存', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', args)
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  const preview = await save({ config, preview: true }) as { previews: { role: string; read: string }[] }
  expect(preview.previews.map(item => item.role)).toEqual(['orchestrator', 'worker'])
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read(preview.previews[1]!.read, { offset, limit: 8000 }) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  expect(text).toContain('## 工单范围\nFinish what was asked.')
  expect(h.runtime.prompts.current().revision).toBe(0)
  await expect(save({ config })).rejects.toThrow('baseRevision')
  expect(await save({ config, baseRevision: 0 })).toMatchObject({ revision: 1 })
})

it('agent 被释放后收回为其 Session 注册的工具，其他 Session 的工具不受影响', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const worker = `worker-${ticket.id}`
  expect(h.tools.get(worker)!.size).toBeGreaterThan(0)
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect([h.tools.get(worker)!.size, h.tools.get(h.runtime.masterId)!.size > 0]).toEqual([0, true])
  // 再次释放（如同关机时）不会残留任何内容。
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect(h.tools.get(worker)!.size).toBe(0)
})

it('按卡片显示的键读取线程：标签、工单、最近的决定与触发，从新到旧，其自己的执行器 Session 也可以', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const key = `feishu:${CHAT}:om_1`
  const threads = await read('threads') as { items: { thread: string; label: string; read: string }[] }
  expect(threads.items[0]).toMatchObject({ thread: key, label: '@bot 修一下回归', read: `thread/${key}` })
  const thread = await read(`thread/${key}`)
  expect(thread).toMatchObject({ thread: key, label: '@bot 修一下回归', tickets: [expect.objectContaining({ ticket_id: ticket.id })],
    decisions: [expect.objectContaining({ kind: 'accept', ticket_id: ticket.id })], items: [expect.objectContaining({ trigger_id: trigger.id, read: `trigger/${trigger.id}` })],
    next_offset: null })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `thread/${key}` })).toMatchObject({ thread: key })
  const elsewhere = feishu('5', '@bot 别的事', { chat_id: 'oc_other' })
  h.runtime.store.triggers.save(elsewhere)
  h.runtime.store.threads.save({ key: `feishu:oc_other:om_5`, ref: { source: 'feishu', id: 'oc_other:om_5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} })
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: 'thread/feishu:oc_other:om_5' })).rejects.toThrow('Unknown or inaccessible thread')
})

it('读取工单及其关联 id、按派工组织的报告，分页读取其派工与输入，各按其行给出的名称或 id', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const at = (n: number) => `2026-10-05T00:${String(n).padStart(2, '0')}:00.000Z`
  const report = (n: number) => ({ state: 'progress' as const, summary: `Report ${n}: ${'checked the config and the build. '.repeat(46)}`.slice(0, 1500), at: at(n) })
  const assignments = [1, 2, 3, 4, 5, 6, 7].map(n => ({ ...stored.assignments[0]!, id: `a${n}`, state: n < 7 ? 'ended' as const : 'running' as const, report: report(n), createdAt: at(n) }))
  const inputs = Array.from({ length: 24 }, (_, n) => n === 23 ? { id: 'text:long', kind: 'text' as const, text: `Note: ${'check the margin on mobile as well. '.repeat(4)}`, at: at(n) }
    : n % 2 ? { id: `text:${n}`, kind: 'text' as const, text: `Note ${n}: check the margin.`, at: at(n) }
    : { id: `trigger:${n}`, kind: 'trigger' as const, triggerId: `trigger-${n}`, at: at(n) })
  h.runtime.store.tickets.save({ ...stored, assignments, inputs: [...stored.inputs, ...inputs] })
  type Page = { items: { read?: string; report: { read: string } }[]; next_resource?: string; next_offset?: number }
  const details = await read(`ticket/${ticket.id}`) as { inputs: Page; assignments: Page }
  expect(details).toMatchObject({ trigger_id: ticket.origin.triggerId, decision_id: ticket.decisionId, threads: [{ thread: `feishu:${CHAT}:om_1` }],
    inputs: { next_resource: `ticket/${ticket.id}/inputs`, next_offset: 10 }, assignments: { next_resource: `ticket/${ticket.id}/assignments`, next_offset: 3 } })
  expect([details.inputs.items.length, details.assignments.items.length]).toEqual([10, 3])
  // 较早的派工可以继续读取，执行器 Session 能看到它接续的每份报告。
  const earlier = await read(details.assignments.next_resource!, { offset: details.assignments.next_offset! }) as Page
  expect([earlier.items.map(item => (item as { id?: string }).id), earlier.next_offset]).toEqual([['a4', 'a3', 'a2'], 6])
  expect(await read(details.assignments.next_resource!, { offset: 6 })).toEqual({ next_offset: null,
    items: [expect.objectContaining({ id: 'a1', report: expect.objectContaining({ read: `ticket/${ticket.id}/report/a1` }) })] })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/report/a1` })).toMatchObject({ text: report(1).summary })
  expect(JSON.stringify(details).length).toBeLessThan(3000)
  const page = await read(details.inputs.items[0]!.read!) as { text: string }
  expect(page.text).toContain('check the margin on mobile as well.')
  // 输入也可以用在工单上的 id 读取。
  expect(await read(`ticket/${ticket.id}/input/text:long`)).toMatchObject({ text: page.text })
  expect(await read(`ticket/${ticket.id}/inputs`, { offset: 20 })).toMatchObject({ items: expect.objectContaining({ length: 4 }), next_offset: null })
  expect(await read(details.assignments.items[0]!.report.read)).toMatchObject({ text: report(7).summary.slice(0, 4000) })
  vi.mocked(h.controller.inspect).mockResolvedValueOnce({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant',
    content: [{ type: 'text', text: `I fixed the margin. ${'Details. '.repeat(20)}` }] } } }] } as never)
  const transcript = JSON.parse((await read(`ticket/${ticket.id}/transcript`) as { text: string }).text) as { preview: string; read: string }
  expect(transcript).toMatchObject({ preview: expect.stringMatching(/^I fixed the margin\./), read: `ticket/${ticket.id}/message/0` })
  expect(transcript.preview.length).toBeLessThanOrEqual(80)
})

it('一次性读取触发及其所回复的消息与线程上其周围的消息，不含 CI 运行', async () => {
  const at = (minute: number) => `2026-10-06T00:0${minute}:00.000Z`
  const message = (id: string, minute: number, overrides: Record<string, unknown> = {}) => ({ ...feishu(id, `message ${id}`, { root_id: 'om_root', ...overrides }), at: at(minute) })
  const ci = (id: string, minute: number) => ({ ...message(id, minute), source: 'github', human: false, text: '{"check":"build"}', meta: { ci: true } })
  const asked = message('asked', 1), replying = message('reply', 3, { parent_id: 'om_asked' })
  for (const item of [message('root', 0, { root_id: undefined }), asked, ci('ci-1', 2), replying, ci('ci-2', 4), message('later', 5)]) h.runtime.store.triggers.save(item)
  const page = await read(`trigger/${replying.id}`)
  expect(page).toMatchObject({ trigger_id: replying.id, replied_to: { trigger_id: asked.id, read: `trigger/${asked.id}` },
    around: { before: { trigger_id: asked.id }, after: { trigger_id: feishu('later', '').id } }, text: 'message reply' })
  // 页面中的文本只出现一次，也没有指向自身的指针。
  expect(page).not.toHaveProperty('preview')
  expect(page).not.toHaveProperty('read')
})

const relaysOf = (kind: string) => h.relays(h.runtime.masterId).filter(item => item.kind === kind)
const notices = () => h.agents.get(h.runtime.masterId)!.inject.mock.calls
  .map(([message]) => JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join('')) as Record<string, unknown>)

it('在候选中先列出其线程上已打开的工单、它到达的工单、其文本提到的工单，以及简短的下一步', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const a = first.ticket
  // 其线程上的请求到达执行器 Session，不属于它的会被交回，再由主 Session 路由。
  const handBack = async (id: string) => {
    await h.runTool(first.sessionId, 'orchestrator_trigger_handback', { trigger_id: id, reason: 'Another change.' })
    await h.runtime.pump(); await h.runtime.idle()
  }
  const second = feishu('2', '@bot 另一个问题', { root_id: 'om_1' })
  h.runtime.receive(second); await h.runtime.idle()
  await handBack(second.id)
  const b = (await h.route({ kind: 'accept', trigger_id: second.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' })).ticket as
    { ticket_id: string }
  h.runtime.engine.stopTicket(b.ticket_id)
  // 后续消息未经评估即到达进行中的工单；交回后其候选显示去向。
  const more = feishu('3', '@bot 还有按钮', { root_id: 'om_1' })
  h.runtime.receive(more); await h.runtime.idle()
  await handBack(more.id)
  const followup = relaysOf('candidate').at(-1)!
  expect((followup.related_tickets as { ticket_id: string }[]).map(card => card.ticket_id)).toEqual([a.id, b.ticket_id])
  expect(followup).toMatchObject({ tickets_total: 2, delivered_to: [a.id], thread: `feishu:${CHAT}:om_1` })
  expect(String(followup.next_action).length).toBeLessThanOrEqual(100)
  // 别处提到某个 PR 的消息会读取跟随它的工单。
  const thread = { key: 'github:123', ref: { source: 'github', id: '123' }, createdAt: '', subscriptions: [a.id], correlated: [], pending: [], meta: {} }
  h.runtime.store.threads.save(thread)
  h.runtime.receive(feishu('4', '@bot 看看 #123 的进展')); await h.runtime.idle()
  expect(relaysOf('candidate').at(-1)).toMatchObject({ related_tickets: [], tickets_total: 0, referenced_tickets: [{ ticket_id: a.id }] })
})

it('转发执行器 Session 的报告（附工单卡片与摘要开头），问题则只附卡片', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await h.runtime.idle()
  expect(relaysOf('worker_attention').at(-1)).toEqual({ kind: 'worker_attention', state: 'progress', read: `ticket/${ticket.id}/result`,
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'person/answer', attention: expect.objectContaining({ question: 'Desktop too?' }) }) })
  const summary = 'Done. ' + 'Evidence. '.repeat(100)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary, human_action: null })
  await h.runtime.idle()
  const report = relaysOf('worker_report').at(-1)!
  expect(report).toMatchObject({ ticket: { ticket_id: ticket.id, title: ticket.title }, trigger_id: trigger.id, state: 'ready', chars: summary.length,
    read: `ticket/${ticket.id}/result` })
  expect(String(report.summary)).toBe(summary.slice(0, 600))
  expect(report.ticket).not.toHaveProperty('preview')
  // ready 报告带来的工单结束通知也附其卡片。
  expect(notices().at(-1)).toMatchObject({ ticket_ended: { ticket_id: ticket.id, state: 'completed' } })
})

it('把别人所做的设置、提示词、重新入队与退订变更通知主 Session，自己的变更不通知', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const evaluation = h.runtime.store.settings().eval
  await h.runtime.settings.save('eval', { ...evaluation, mode: 'observe' }, h.runtime.store.blockRevision('eval'), 'panel')
  await h.runtime.idle()
  expect(notices().at(-1)).toEqual({ settings_saved: 'eval', changed: ['eval.mode'], read: 'settings/eval' })
  const before = notices().length
  expect(await save({ block: 'eval', value: { ...evaluation, mode: 'auto' }, revision: h.runtime.store.blockRevision('eval') })).not.toHaveProperty('context_delivery')
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config, baseRevision: 0 })).not.toHaveProperty('context_delivery')
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('5', '@bot 谢谢')
  h.runtime.receive(thanks); await h.runtime.idle()
  await h.route({ kind: 'ignore', trigger_id: thanks.id, reason: 'thanks' })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_trigger_requeue', { trigger_id: thanks.id })).toEqual({ queued: true })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_thread_unsubscribe', { thread: `feishu:${CHAT}:om_1` })).toEqual({ removed: true, thread: `feishu:${CHAT}:om_1` })
  await h.runtime.idle()
  expect(notices().slice(before).filter(notice => !('ticket_ended' in notice))).toEqual([])
})

it('策略同步只应答计数与变更内容，不返回完整名单', async () => {
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_bob', name: 'Bob' }], has_more: false })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_policy_sync', { source: 'feishu' })).toEqual({ source: 'feishu', allowed: 2, added: ['Bob'], removed: [] })
})

it('不向执行器 Session 展示其无权读取的 id：无决定、无其他工单、无未到达其工单的触发', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const another = feishu('2', '@bot 再修一个', { root_id: 'om_1' })
  h.runtime.receive(another); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another fix.' })
  const other = await h.acceptedTicket(another)
  const worker = (resource: string) => h.runTool(sessionId, 'orchestrator_read', { resource })
  const thread = await worker(`thread/feishu:${CHAT}:om_1`)
  expect(thread).not.toHaveProperty('tickets')
  expect(thread).not.toHaveProperty('decisions')
  for (const page of [thread, await worker(`ticket/${ticket.id}`), await worker(`trigger/${trigger.id}`)]) {
    const shown = JSON.stringify(page)
    expect(shown).not.toContain(ticket.decisionId)
    expect(shown).not.toContain(other.ticket.id)
  }
  expect(await read(`thread/feishu:${CHAT}:om_1`)).toMatchObject({ tickets: expect.arrayContaining([expect.objectContaining({ ticket_id: other.ticket.id })]),
    decisions: expect.arrayContaining([expect.objectContaining({ decision_id: ticket.decisionId })]) })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ decision_id: ticket.decisionId })
})

it('把执行器 Session 作上下文跟随的线程与来源绑定到工单的线程区分开', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '12' }, true)
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:9', reason: 'The Issue it fixes.' })
  const { threads } = await read(`ticket/${ticket.id}`) as { threads: { thread: string }[] }
  expect(threads).toEqual(expect.arrayContaining([{ thread: `feishu:${CHAT}:om_1` }, { thread: 'github:12', bound: true }, { thread: 'github:9', context: true }]))
  expect(threads).toHaveLength(3)
})

it('把工单所从接受请求的其他消息交给执行器 Session，体现在其首条消息与工单上', async () => {
  // 接收两条消息时暂停处理，使它们作为同一批次研判。
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  await h.runtime.receive(first); await h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: second.id, title: 'Retitle', worktree_name: 'retitle', acknowledgement: '收到。' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  const other = ticket.origin.triggerIds.find(id => id !== ticket.origin.triggerId)!
  expect(ticket.origin.triggerIds).toHaveLength(2)
  const message = h.relays(`worker-${ticket.id}`)[0]!
  expect(message.batch).toEqual([expect.objectContaining({ trigger_id: other, preview: expect.any(String), read: `trigger/${other}` })])
  const page = await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}` })
  expect(page).toMatchObject({ batch: [{ trigger_id: other, read: `trigger/${other}` }] })
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `trigger/${other}` })).toMatchObject({ trigger_id: other })
})
