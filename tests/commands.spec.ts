import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { githubKind } from '../src/sources/github.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(feishuKind); sources.register(githubKind)
const send = (commands: Commands, message: OutboundMessage) => sources.send(message, commands)
const deployment = testDeployment({ github: { ...testDeployment().github, cli: '/path/agent-gh' } })
const REPOSITORY = deployment.repository
const reply = { id: 'stable-operation', channel: githubChannel(8), text: 'Done', kind: 'reply' as const }
describe('按账号隔离的操作', () => {
  it('使用 agent 账号的 GitHub CLI，并在 argv 中原样保留 shell 元字符', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{}')
    await commands.gh(['api','some-path','-f','body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api','some-path','-f','body=`whoami` $(touch x)'])
  })
  it('每条命令都用其环境覆盖进程环境，undefined 表示移除一个变量', async () => {
    process.env.GH_TOKEN = 'personal'
    try {
      const output = await new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal).run('env', [])
      expect(output).toContain('DSH_SUPERAGENT_PROBE=agent')
      expect(output).not.toContain('GH_TOKEN=')
    } finally { delete process.env.GH_TOKEN }
  })
  it('部署没有飞书 bot 时拒绝飞书命令', async () => {
    await expect(new Commands(() => testDeployment({ feishu: undefined }), {}, new AbortController().signal).lark(['im', '+chat-list'])).rejects.toThrow('The Feishu Source has no working bot CLI')
  })
  it('用稳定标记核对结果不确定的 GitHub 发送', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands,'pages').mockResolvedValue([{ body:'<!-- dsh-superagent-cn:stable-operation -->',user:{login:'agent-bot'} }])
    const gh = vi.spyOn(commands,'gh')
    await send(commands, reply); expect(gh).not.toHaveBeenCalled()
  })
  it('按模型所写原样发布回复，且只发布到固定仓库', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValue({})
    await send(commands, reply)
    // 披露行属于 prompt 文本：由模型书写，host 不添加任何内容。
    expect(gh).toHaveBeenCalledWith(['api',`repos/${REPOSITORY}/issues/8/comments`,'--method','POST','-f',expect.stringMatching(/^body=Done\n\n<!-- dsh-superagent-cn:stable-operation -->$/)])
    await expect(new Commands(() => deployment, {}, new AbortController().signal).pages(z.unknown(),
      '../../someone/else/issues')).rejects.toThrow()
  })
  it('把评审评论的回复路由到根评审评论', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValueOnce({ id: 7, in_reply_to_id: 3 }).mockResolvedValueOnce({})
    await send(commands, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })
    expect(gh.mock.calls[1]![0]).toEqual(['api', `repos/${REPOSITORY}/pulls/8/comments/3/replies`, '--method', 'POST', '-f', expect.stringContaining('Done')])
  })
  it('重试时使用飞书 bot 身份和同一个幂等键', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{"ok":true,"data":{}}')
    await send(commands, { ...reply, channel: feishuChannel('oc_1', 'om_1') })
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--as','bot','--idempotency-key','stable-operation','--message-id','om_1']))
  })
})

it('报告飞书失败时带其代码且不带命令参数', () => {
  const membership = commandError({stderr:'[page 1] fetching...\n'+JSON.stringify({error:{code:232011,message:'operator is not in the chat'}})})
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(commandError({stderr:JSON.stringify({error:{code:999,message:'scope missing'}})}).message).toBe('scope missing (999)')
})
describe('渠道', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  const feishu = { ...reply, channel: feishuChannel('oc_1', 'om_1') }
  const lark = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })
  it('丢弃对已撤回消息或飞书找不到的消息的回复，并说明如何把 bot 加进会话', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run')
    for (const [code, message] of [[230011, 'The message is recalled'], [230001, 'message not found'], [231003,
      'The message is withdrawn']] as const) {
      run.mockRejectedValueOnce(lark(code, message))
      expect(await send(value, feishu)).toBe('gone')
    }
    run.mockRejectedValueOnce(lark(232011, 'operator is not in the chat'))
    const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
    await expect(send(value, feishu)).rejects.toThrow(hint)
    run.mockRejectedValueOnce(lark(99991400, 'rate limited'))
    await expect(send(value, feishu)).rejects.toThrow('rate limited (99991400)')
  })
  it('命令超时的飞书回复保留以待重试，无论其文本内容如何', async () => {
    const value = commands()
    const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
    vi.spyOn(value, 'run').mockRejectedValueOnce(commandError(timedOut, 'lark-bot'))
    await expect(send(value, { ...feishu, text: 'The change was withdrawn' })).rejects.toThrow('lark-bot timed out after 90 s')
  })
  it('丢弃对已删除或已锁定 Issue 的 GitHub 回复，其余保留以待重试', async () => {
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
    for (const stderr of ['gh: This issue was deleted (HTTP 410)', 'gh: Unable to create comment because issue is locked. (HTTP 403)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      expect(await send(value, reply)).toBe('gone')
    }
    // 对 agent 失去访问权限的私有仓库，GitHub 也会返回 404，因此 404 会被重试而不是丢弃。
    for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: Server Error (HTTP 500)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      await expect(send(value, reply)).rejects.toThrow(stderr)
    }
  })
  it('回复所指向的评审评论消失时，在 PR 的会话上回复', async () => {
    const value = commands()
    const pages = vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
      .mockRejectedValueOnce(commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 })).mockResolvedValueOnce({})
    expect(await send(value, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })).toBe('sent')
    expect((pages.mock.calls[0] as unknown[])[1]).toBe('issues/8/comments')
    const post = ['api', `repos/${REPOSITORY}/issues/8/comments`, '--method', 'POST', '-f', expect.stringContaining('Done')]
    expect(gh.mock.calls[1]![0]).toEqual(post)
  })
  it('把每个地址连同其标签链接到其页面', () => {
    const links = { repository: REPOSITORY, feishu: deployment.feishu! }
    expect(githubKind.channel!.link(githubChannel(8).address, links)).toEqual({ url: `https://github.com/${REPOSITORY}/issues/8`,
      label: { zh: 'GitHub #8', en: 'GitHub #8' } })
    const review = `https://github.com/${REPOSITORY}/pull/8#discussion_r7`
    expect(githubKind.channel!.link(githubChannel(8, review).address, links))
      .toEqual({ url: review, label: { zh: 'GitHub #8 的 review 讨论', en: 'Review discussion on GitHub #8' } })
    expect(githubKind.channel!.link(githubChannel(8).address, {}).url).toBe('')
    const message = feishuChannel('oc_1', 'om_1').address
    expect(feishuKind.channel!.link(message, links)).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: key('feishu', 'om_1') })
  })
})

describe('GitHub 调用', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  it('只访问所配置仓库内的路径，并校验 GitHub 的应答', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12,"title":"Login fails","extra":true}')
    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toEqual({ number: 12, title: 'Login fails', extra: true })
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12`])
    await expect(value.api(z.looseObject({ number: z.string() }), 'issues/12')).rejects.toThrow()
    for (const path of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('restricted to the configured repository')
    }
    expect(run).toHaveBeenCalledTimes(2)
    // 空路径指向仓库根目录。
    await value.api(z.unknown(), '')
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}`])
    // 不带 schema 时，api() 返回 CLI 的原始 stdout。
    run.mockResolvedValue('raw file')
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')
  })
  it('读取列表的每一页，跳过并计数未通过校验的条目', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('[[{"id":1}],[{"id":2}]]')
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments?per_page=100')).toEqual([{ id: 1 }, { id: 2 }])
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12/comments?per_page=100`, '--paginate',
      '--slurp'])
    run.mockResolvedValue('[[{"id":1}],[{"id":"two"}]]')
    const tally = { skipped: 0 }
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally)).toEqual([{ id: 1 }])
    expect(tally).toEqual({ skipped: 1 })
    run.mockResolvedValue('{"message":"not a list"}')
    await expect(value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments')).rejects.toThrow()
  })
})
it('飞书答复 bot 不是成员时给出如何把 bot 加进会话的说明，并保留代码', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = vi.spyOn(commands, 'run').mockRejectedValueOnce(commandError({ stderr: membership, code: 1 }))
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011, exitCode: 1 })
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011 })
})
it('命令没有输出诊断信息时只说明程序名与结束方式，绝不提及参数', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const secret = 'secret reply text'
  await expect(commands.run('sh', ['-c', 'exit 3', secret])).rejects.toMatchObject({ message: 'sh exited with code 3', exitCode: 3 })
  // 只有在 POSIX 上信号结束才会以信号形式到达 Node；MSYS sh 把 SIGKILL 报告为退出码 2304（9 << 8）。
  if (process.platform !== 'win32') await expect(commands.run('sh', ['-c', 'kill -9 $$', secret])).rejects.toMatchObject({ message: 'sh was stopped by SIGKILL' })
  await expect(commands.run('/no/such/program', ['secret reply text'])).rejects.toMatchObject({ message: 'program could not run: ENOENT' })
  // 超时以 SIGTERM 杀死子进程；Node 默认的错误消息会回显每一个参数。
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  expect(commandError(timedOut, '/path/lark-bot')).toMatchObject({ message: 'lark-bot timed out after 90 s' })
  expect(String(commandError(timedOut, '/path/lark-bot'))).not.toContain('withdrawn')
})
it('以 CliError 报告失败，带 CLI 给出的代码与退出状态', async () => {
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'gh: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  expect(commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
    code: 1 })).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // 被取消的命令保持为 AbortError，调用方由此区分取消与失败。
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run('sleep', ['5'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await expect(commands.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
})

it('工作的 signal 中止或生命周期结束时停止运行中的命令，其他工作继续运行', async () => {
  const lifetime = new AbortController(), work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = commands.withSignal(work.signal).run('sleep', ['5'])
  work.abort()
  await expect(running).rejects.toThrow()
  // 只有绑定到被中止工作 signal 的命令才会停止。
  expect(await commands.run('echo', ['still'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run('sleep', ['5'])
  lifetime.abort()
  await expect(other).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(4000)
})
