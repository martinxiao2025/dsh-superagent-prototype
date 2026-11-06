import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// 测试套件并行运行时，git 与 shell 子进程可能超过 5 秒的默认超时。
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
/** DSH 剥离凭据形态变量之后的 worker shell 环境。 */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// 产品把 worker shim 写成 POSIX shell 脚本（`#!/bin/sh` + `exec`），因此运行它们需要 POSIX shell；
// 下面的检查在各平台都保持启用，其中三个执行 shim 的检查在 sh 不存在处做了标记。
const posix = process.platform !== 'win32'

describe('worker shims', () => {
  it.skipIf(!posix)('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(delimiter)
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(delimiter) })
  })
  it.skipIf(!posix)('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
  })
  it.skipIf(!posix)('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    expect(readdirSync(bin)).not.toContain('git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // 仅仅在后续行包含标记的文件、指向 shim 的符号链接以及外来的 gitconfig 都会被拒绝。
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    // 文件符号链接在 Windows 上需要 SeCreateSymbolicLinkPrivilege，因此该写法只在 POSIX 上检查。
    if (posix) {
      symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
      await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
      rmSync(join(workerBin(dir), 'link'))
    }
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // 将 HTTPS 改写为 SSH、启用提交签名并设置 credential helper 的操作者配置。
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // 操作者的身份变量以及 git 从操作系统用户名回退得到的身份，都不得用于 worker 的提交。
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    // git 会转义 origin 中的反斜杠，还可能给它加引号；比较路径前要同时还原两者。
    const [source, ...helper] = (await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).split('\t')
    const origin = source!.replace(/^file:/, '').replace(/^"(.*)"$/, '$1').replaceAll('\\\\', '\\')
    expect(`file:${origin}`).toBe(`file:${workerGitConfig(dir)}`)
    expect(helper.join('\t')).toBe(credentialHelper('/opt/agent tools/gh'))
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  // junction 是 Windows 允许的、无需提权的目录符号链接。
  symlinkSync(join(dir, 'state'), join(dir, 'link'), posix ? 'dir' : 'junction')
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), join(dir, 'other'), 'node_modules/.bin'].join(delimiter), bin))
    .toBe([join(dir, 'other'), 'node_modules/.bin'].join(delimiter))
})

/** 由 child_process.spawn 支撑、使用隔离的全局 git config 的最小 SubprocessRuntime。 */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // 当没有任何配置键匹配时，git config --get-regexp 以状态 1 退出。
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    // 用 Node 代替 `sh -c`，因此该检查在没有 POSIX shell 的地方也能运行。
    const failing = [process.execPath, '-e', 'console.error("nope"); process.exit(3)']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // 用一个临时仓库代表被测仓库，`git rebase --exec` 会在 GIT_DIR 与 GIT_WORK_TREE 中指明它。
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // 操作者对 git 查找仓库的范围限制不指明任何仓库，因此保留。
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // 与测试所做的相同：使用它们自己的仓库，并作为 ticket 目录检查。
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // worker 环境（worker 的 shell 和宿主自身的命令都会拿到）不指明任何仓库。
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
