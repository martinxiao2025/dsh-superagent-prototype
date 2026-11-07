import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
type Answers = (args: string[]) => string
let dir: string
let path: string
/** CLI 的替身，在进程内应答，因此任何平台都不需要 POSIX shell 来运行它们。 */
const programs = new Map<string, Answers>()
const program = (file: string, answers: Answers = () => { throw new Error(`${file} was run with no answers`) }): string => {
  writeFileSync(file, '')
  chmodSync(file, 0o755)
  programs.set(file, answers)
  return file
}
/** 假冒的 gh CLI，以 `login` 身份登录，对 acme/widgets（含其旧名 acme/gadgets）的 push 权限可配置。 */
const gh = (file: string, login: string, push = true): string => program(file, args => {
  const line = args.join(' ')
  if (line === 'api user') return JSON.stringify({ login, id: 7 })
  if (line.startsWith('api repos/acme/') && line.endsWith('--jq {name: .full_name, push: .permissions.push}')) return JSON.stringify({ name: 'acme/widgets', push })
  throw new Error(`unexpected gh arguments: ${line}`)
})
/** 假冒的 lark-cli 对 auth status、strict-mode 和 bot info 的应答。 */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): Answers => args => {
  const line = args.join(' ')
  if (line === 'auth status') return JSON.stringify(status)
  if (line === 'config strict-mode') return `strict-mode: ${mode} (source: profile)`
  if (line === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') return JSON.stringify(bot)
  throw new Error(`unexpected lark-cli arguments: ${line}`)
}
// 配置 schema 描述的是 POSIX 绝对路径；下面的 setup 用例改用真实目录。
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: '/srv/state', ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config.parse(minimal())), stateDir: join(dir, 'state'), ...overrides })
/** 在飞书探测添加的 `env` 前缀之后，应答 worker shell 本会启动的那个 CLI。 */
const probe: Probe = async argv => {
  let at = 0
  if (argv[0] === 'env') { at = 1; while (at < argv.length && argv[at]!.includes('=')) at++ }
  const file = argv[at]!
  const answers = programs.get(file)
  if (!answers) throw new Error(`${file} is not an executable file`)
  return answers(argv.slice(at + 1))
}
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), join(dir, 'state', 'worker-bin'), join(dir, 'bin'),
    ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter)
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // 无论 PATH 是否归一化或是否存在符号链接，同名的陈旧 worker shim 都必须被跳过。
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// setup 会 spawn CLI 子进程，测试并行运行时可能耗时数秒。
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config.parse({})).toThrow('stateDir')
    const read = machineOf({ stateDir: '/srv/state' })
    // 限制值经 `Volatile` 读取，调用方在使用时取值。
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: '/srv/state', promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000,
        mcpEnabled: true, mcpPort: 3083, panelPort: 3082, host: '127.0.0.1' })
    expect(() => Config.parse(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config.parse(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(raw)).toThrow('dsh-superagent 的配置包含它不使用的键：repository（现在位于GitHub Source 上）、repositoryPath（现在位于Execution 设置的 prepare 命令中）、blockedCommands（现在位于Execution 设置中）、author（现在位于提示词文本中）、extra；docs/006-deployment.md 列出了这些键')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // 重命名后的仓库仍能按其旧名解析；通知中携带 GitHub 当前的 full_name。
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} 不是可执行文件` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh 必须是命令名或绝对路径' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), () => { throw new Error('not signed in') }) })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // 已登录，但该账号无法读取仓库，或者 CLI 未指明账号。
    const unreadable = program(join(dir, 'bin', 'gh-outsider'), args => {
      if (args.join(' ') === 'api user') return JSON.stringify({ login: 'Agent-Bot', id: 7 })
      throw new Error('HTTP 404')
    })
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), () => '{}') })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here 不是可执行文件（在 PATH 中）')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), () => { throw new Error('not configured') })
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
