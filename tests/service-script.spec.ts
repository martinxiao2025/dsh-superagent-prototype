/** 使用带空格的临时检出路径以及打桩的 ps、tmux 与 dsh 二进制来测试 scripts/dsh-superagent-cn。 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

/** 服务脚本依赖 POSIX 的 `ps`、`tmux`、`fcntl` 与信号语义；在 Windows 上整个测试套件跳过。 */
const posixOnly = process.platform !== 'win32'
let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const program = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
/** 启动一个占位进程，其 PID 可被假的 ps 二进制列出；ignoreInterrupt 模拟卡住的优雅停止。 */
function sleeper(ignoreInterrupt = false): number {
  const [program, args] = ignoreInterrupt ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const : ['sleep', ['60']] as const
  const child = spawn(program, [...args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
/** 为假的 ps 二进制写入活动进程行（`pid ucomm args`）。以 `after:<pid> ` 为前缀的条目只在该 PID 退出后才出现。 */
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-cn'), join(root, 'scripts', 'dsh-superagent-cn'))
  processes()
  program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  case "$line" in after:*) dep=\${line#after:}; dep=\${dep%% *}; kill -0 "$dep" 2>/dev/null && continue; line=\${line#after:$dep };; esac
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
  // 记录 tmux 调用，并通过输出 pane 的 PID 模拟会话创建。
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  program('dsh', 'exit 0')
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [join(root, 'scripts', 'dsh-superagent-cn'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** 启动一个 mock HTTP 服务器，在 tmux 启动服务之前返回 503（always 为 true 时除外）。 */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

it.skipIf(!posixOnly)('两个进程服务同一 profile 时在写入停止标记前拒绝停止', async () => {
  processes(service(sleeper()), `${sleeper()} node node /opt/dsh --profile=superagent`)
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('发现多个 dsh-superagent-cn 进程') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
})
it.skipIf(!posixOnly)('按 profile 各自保留停止状态', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('自动恢复保持暂停') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('存在有意停止标记') })
})
it.skipIf(!posixOnly)('不把 profile 的 `dsh plugin` 命令当作其服务进程', async () => {
  const service = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`,
    `${service} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
})
it.skipIf(!posixOnly)('启动时记录服务 PID，扫描发现的第二个实例仍会被拒绝', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
  // 含空格的检出路径是一个参数，其中的日志路径已为 shell 加了引号。
  const checkout = realpathSync(root)
  expect(tmux).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_pid}', '-c', checkout]))
  const log = new RegExp(`>> '${checkout}/\\.artifacts/dsh-superagent-cn-superagent-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
  expect(tmux.find(word => word.startsWith('umask 077; exec '))).toMatch(log)
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile superagent`)
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('发现多个 dsh-superagent-cn 进程') })
  expect(await status('superagent')).toMatchObject({ pids: [pid, second] })
}, 20_000)
it.skipIf(!posixOnly)('只等待它停止的那个进程', async () => {
  const pid = sleeper()
  // 被停止的进程结束后，另一个实例才会出现。
  processes(service(pid), `after:${pid} ${sleeper()} node node /opt/dsh --profile superagent`)
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent-cn 已停止') })
}, 20_000)
it.skipIf(!posixOnly)('只为该 profile 保留其写入的最新日志', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-cn-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-cn-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-cn-superagent-')).sort()
  expect(own).toHaveLength(20)
  // 最旧的被删除；新的保留，连同较早但较新的几份。其他 profile 的日志与更旧命名格式的日志保留。
  expect(own).not.toContain('dsh-superagent-cn-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-cn-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-cn-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-cn-20260901-000000-1.log')
}, 20_000)
it.skipIf(!posixOnly)('飞书机器人部署检查无法完成的服务仍报告为运行中，并容忍缺少键的应答', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
})
it.skipIf(!posixOnly)('来源等部分报告错误且重启无法修复时退出码为 2，并打印其报告内容', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github 报告错误，重启无法修复：bad token') })
}, 20_000)
it.skipIf(!posixOnly)('服务在等待部署检查时退出码为 3（status 与 start 均如此），重启无法修复', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('正在等待 setup：The GitHub Source names no repository.') })
}, 20_000)
it.skipIf(!posixOnly)('重启服务；优雅停止超时的重启不会让自动恢复保持关闭', async () => {
  const url = await answering()
  const old = sleeper(), pid = sleeper()
  processes(service(old))
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent-cn 已停止。') })
  expect(restarted.stdout).not.toContain('自动恢复保持暂停')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // 未及时停止的服务保持运行，下一次检查可能会重启它。
  rmSync(join(root, 'launched'))
  processes(service(sleeper(true)))
  expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('优雅停止超时') })
  expect(await status('superagent')).toMatchObject({ manually_stopped: false })
}, 20_000)
it.skipIf(!posixOnly)('一个控制操作持有 profile 的锁时拒绝第二个控制操作', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const held = join(root, 'held')
  const holder = spawn('python3', ['-c', `import fcntl, pathlib, time
lock = open(${JSON.stringify(join(control('superagent'), 'operation.lock'))}, 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)`], { stdio: 'ignore' })
  sleepers.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('另一个 dsh-superagent-cn 控制操作正在进行') })
}, 20_000)
it.skipIf(!posixOnly)('没有进程运行服务但其 URL 已有应答时拒绝启动', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('该 URL 已有一个 orchestrator 在应答') })
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[0])).toEqual(['has-session'])
}, 20_000)
it.skipIf(!posixOnly)('tmux 会话已存在时在其新窗口中启动服务', async () => {
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 0;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[0] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[0] === 'new-session')).toBe(false)
}, 20_000)
it.skipIf(!posixOnly)('启动的服务未及时应答时退出码为 1，且其进程保持运行', async () => {
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('启动健康检查超时') })
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 20_000)
it.skipIf(!posixOnly)('不向占用已记录服务 PID 的进程发信号，并保留已超时的停止状态', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // 未及时停止的服务保留停止状态，自动恢复因此不会再次启动它。
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(service(sleeper(true)))
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)
