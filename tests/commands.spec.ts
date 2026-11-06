import { basename } from 'node:path'
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
describe('account-isolated operations', () => {
  it('uses the agent account\'s GitHub CLI and preserves literal shell metacharacters in argv', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{}')
    await commands.gh(['api','some-path','-f','body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api','some-path','-f','body=`whoami` $(touch x)'])
  })
  it('runs every command with its environment over the process environment, where undefined removes a variable', async () => {
    process.env.GH_TOKEN = 'personal'
    try {
      // 用 Node 代替 `env`，因此在没有 POSIX shell 的平台上也能运行该检查。
      const script = 'console.log(JSON.stringify({ probe: process.env.DSH_SUPERAGENT_PROBE ?? null, token: process.env.GH_TOKEN ?? null }))'
      const output = await new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal).run(process.execPath, ['-e', script])
      expect(JSON.parse(output)).toEqual({ probe: 'agent', token: null })
    } finally { delete process.env.GH_TOKEN }
  })
  it('refuses Feishu commands when the deployment has no Feishu bot', async () => {
    await expect(new Commands(() => testDeployment({ feishu: undefined }), {}, new AbortController().signal).lark(['im', '+chat-list'])).rejects.toThrow('飞书 Source 没有可用的机器人 CLI')
  })
  it('reconciles an uncertain GitHub send with its stable marker', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands,'pages').mockResolvedValue([{ body:'<!-- dsh-superagent:stable-operation -->',user:{login:'agent-bot'} }])
    const gh = vi.spyOn(commands,'gh')
    await send(commands, reply); expect(gh).not.toHaveBeenCalled()
  })
  it('posts the reply as the model wrote it, only to the fixed repository', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValue({})
    await send(commands, reply)
    // 披露行是 prompt 文本：由模型写入，宿主不添加任何内容。
    expect(gh).toHaveBeenCalledWith(['api',`repos/${REPOSITORY}/issues/8/comments`,'--method','POST','-f',expect.stringMatching(/^body=Done\n\n<!-- dsh-superagent:stable-operation -->$/)])
    await expect(new Commands(() => deployment, {}, new AbortController().signal).pages(z.unknown(),
      '../../someone/else/issues')).rejects.toThrow()
  })
  it('routes review-comment replies to the root review comment', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValueOnce({ id: 7, in_reply_to_id: 3 }).mockResolvedValueOnce({})
    await send(commands, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })
    expect(gh.mock.calls[1]![0]).toEqual(['api', `repos/${REPOSITORY}/pulls/8/comments/3/replies`, '--method', 'POST', '-f', expect.stringContaining('Done')])
  })
  it('uses Feishu bot identity and one idempotency key on retries', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{"ok":true,"data":{}}')
    await send(commands, { ...reply, channel: feishuChannel('oc_1', 'om_1') })
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--as','bot','--idempotency-key','stable-operation','--message-id','om_1']))
  })
})

it('reports Feishu failures with their code and without command arguments', () => {
  const membership = commandError({stderr:'[page 1] fetching...\n'+JSON.stringify({error:{code:232011,message:'operator is not in the chat'}})})
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(commandError({stderr:JSON.stringify({error:{code:999,message:'scope missing'}})}).message).toBe('scope missing (999)')
})
describe('Channels', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  const feishu = { ...reply, channel: feishuChannel('oc_1', 'om_1') }
  const lark = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })
  it('drop a Feishu reply to a recalled message or one Feishu no longer finds, and say how to add the bot to a chat', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run')
    for (const [code, message] of [[230011, 'The message is recalled'], [230001, 'message not found'], [231003,
      'The message is withdrawn']] as const) {
      run.mockRejectedValueOnce(lark(code, message))
      expect(await send(value, feishu)).toBe('gone')
    }
    run.mockRejectedValueOnce(lark(232011, 'operator is not in the chat'))
    const hint = '飞书机器人不在该群中。请在群设置中添加机器人，然后重试。'
    await expect(send(value, feishu)).rejects.toThrow(hint)
    run.mockRejectedValueOnce(lark(99991400, 'rate limited'))
    await expect(send(value, feishu)).rejects.toThrow('rate limited (99991400)')
  })
  it('keep a Feishu reply whose command timed out for a retry, whatever its text says', async () => {
    const value = commands()
    const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
    vi.spyOn(value, 'run').mockRejectedValueOnce(commandError(timedOut, 'lark-bot'))
    await expect(send(value, { ...feishu, text: 'The change was withdrawn' })).rejects.toThrow('lark-bot 在 90 秒后超时')
  })
  it('drop a GitHub reply to an Issue that is deleted or locked, and keep others for a retry', async () => {
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
    for (const stderr of ['gh: This issue was deleted (HTTP 410)', 'gh: Unable to create comment because issue is locked. (HTTP 403)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      expect(await send(value, reply)).toBe('gone')
    }
    // 对于 agent 失去访问权限的私有仓库，GitHub 也会返回 404，因此 404 会重试而非丢弃。
    for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: Server Error (HTTP 500)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      await expect(send(value, reply)).rejects.toThrow(stderr)
    }
  })
  it('reply on the PR\'s conversation when the review comment a reply points at is gone', async () => {
    const value = commands()
    const pages = vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
      .mockRejectedValueOnce(commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 })).mockResolvedValueOnce({})
    expect(await send(value, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })).toBe('sent')
    expect((pages.mock.calls[0] as unknown[])[1]).toBe('issues/8/comments')
    const post = ['api', `repos/${REPOSITORY}/issues/8/comments`, '--method', 'POST', '-f', expect.stringContaining('Done')]
    expect(gh.mock.calls[1]![0]).toEqual(post)
  })
  it('link each address to its page with its label', () => {
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

describe('GitHub calls', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  it('go only to paths inside the configured repository, and validate what GitHub answers', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12,"title":"Login fails","extra":true}')
    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toEqual({ number: 12, title: 'Login fails', extra: true })
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12`])
    await expect(value.api(z.looseObject({ number: z.string() }), 'issues/12')).rejects.toThrow()
    for (const path of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('GitHub 调用仅限于已配置的仓库')
    }
    expect(run).toHaveBeenCalledTimes(2)
    // 空路径指向仓库根目录。
    await value.api(z.unknown(), '')
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}`])
    // 没有 schema 时，api() 返回 CLI 的原始 stdout。
    run.mockResolvedValue('raw file')
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')
  })
  it('read every page of a list, and skip and count an item that does not validate', async () => {
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
it('says how to add the bot to a chat when Feishu answers that it is not a member, and keeps the code', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = vi.spyOn(commands, 'run').mockRejectedValueOnce(commandError({ stderr: membership, code: 1 }))
  const hint = '飞书机器人不在该群中。请在群设置中添加机器人，然后重试。'
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011, exitCode: 1 })
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011 })
})
it('names only the program and how it ended when a command prints no diagnostics, never its arguments', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const secret = 'secret reply text'
  const node = basename(process.execPath)
  // 用 Node 代替 `sh -c`，使该检查在没有 POSIX shell 的地方也能运行；断言不变。
  await expect(commands.run(process.execPath, ['-e', 'process.exit(3)', secret])).rejects.toMatchObject({ message: `${node} 退出码为 3`, exitCode: 3 })
  // POSIX 报告终止信号；Windows 报告 TerminateProcess 产生的退出码。
  const killed = commands.run(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"])
  if (process.platform === 'win32') await expect(killed).rejects.toMatchObject({ message: `${node} 退出码为 1`, exitCode: 1 })
  else await expect(killed).rejects.toMatchObject({ message: `${node} 被 SIGKILL 停止` })
  await expect(commands.run('/no/such/program', ['secret reply text'])).rejects.toMatchObject({ message: 'program 无法运行：ENOENT' })
  // 超时用 SIGTERM 杀死子进程；Node 默认的错误消息会回显每个参数。
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  expect(commandError(timedOut, '/path/lark-bot')).toMatchObject({ message: 'lark-bot 在 90 秒后超时' })
  expect(String(commandError(timedOut, '/path/lark-bot'))).not.toContain('withdrawn')
})
it('reports failures as CliError with the code the CLI names and the exit status', async () => {
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'gh: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  expect(commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
    code: 1 })).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // 被取消的命令仍为 AbortError，以便调用方区分取消与失败。
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await expect(commands.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
})

it('stops a running command when the signal of its work aborts, or the lifetime, and leaves the other work running', async () => {
  const lifetime = new AbortController(), work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = commands.withSignal(work.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  work.abort()
  await expect(running).rejects.toThrow()
  // 只有绑定到被中止的工作信号的命令才会停止。
  expect(await commands.run(process.execPath, ['-e', 'process.stdout.write("still\\n")'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  lifetime.abort()
  await expect(other).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(4000)
})
