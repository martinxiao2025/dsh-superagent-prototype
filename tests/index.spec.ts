/** 进程入口：配置文件读取、校验失败的可读错误，以及配置变更后的进程内重启。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Machine } from '../src/deployment.ts'

// 用替身 Runtime 捕获解析后的 Machine 与重启回调，避免真的监听端口或探测 CLI。
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; stopped: boolean }[])
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  panelPort = 3082
  constructor(readonly host: { machine: Machine; restart: () => void }) {
    const entry = { machine: host.machine, restart: host.restart, stopped: false }
    runtimes.push(entry)
    host.restart = () => { entry.restart() }
  }
  configured() { return false }
  get setupProblem() { return { code: 'repositoryUnset', place: 'github', detail: '尚未配置仓库', values: {} } }
  async stop() { runtimes.at(-1)!.stopped = true }
} }))
const { configFile, loadConfig, main } = await import('../src/index.ts')

let dir: string | undefined
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; runtimes.length = 0; vi.restoreAllMocks() })
const config = (contents: unknown): string => {
  dir = mkdtempSync(join(tmpdir(), 'index-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return path
}

it('reads the config path from --config and falls back to the home directory', () => {
  expect(configFile([])).toMatch(/\.dsh-superagent[\\/]config\.json$/)
  expect(configFile(['--config', 'C:\\cfg\\dsh.json'])).toBe('C:\\cfg\\dsh.json')
  expect(() => configFile(['--config'])).toThrow('--config 需要一个文件路径')
})

it('names the file when it is missing, is not JSON, or fails validation', () => {
  const missing = join(tmpdir(), 'does-not-exist-dsh-superagent.json')
  expect(() => loadConfig(['--config', missing])).toThrow(`无法读取配置文件 ${missing}`)
  const malformed = config('{not json')
  expect(() => loadConfig(['--config', malformed])).toThrow(`配置文件 ${malformed} 不是合法 JSON`)
  const invalid = config({ stateDir: '' })
  expect(() => loadConfig(['--config', invalid])).toThrow(`配置文件 ${invalid} 无效`)
  expect(() => loadConfig(['--config', config({ stateDir: '/srv/state', unexpected: true })]))
    .toThrow('dsh-superagent 的配置包含它不使用的键：unexpected')
})

it('starts the orchestrator with the parsed machine and reports a failed start as exit code 1', async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const code = await main({ config: { stateDir: '/srv/state', promptMaxChars: 5000, admissionContextMaxPages: 3,
    admissionContextTimeoutMs: 1000, mcpEnabled: false, mcpPort: 3083, panelPort: 3082, host: '127.0.0.1', model: '' }, logger })
  expect(code).toBe(0)
  const runtime = runtimes.at(-1)!
  expect(runtime.machine).toMatchObject({ stateDir: '/srv/state', mcpEnabled: false, mcpPort: 3083, panelPort: 3082, host: '127.0.0.1' })
  expect(runtime.machine.promptMaxChars.get()).toBe(5000)
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('正在等待 setup'))
  // 面板提供的重启回调会停掉当前编排器再启动一个。
  runtime.restart()
  await vi.waitFor(() => { expect(runtimes).toHaveLength(2) })
  expect(runtime.stopped).toBe(true)
})

it('exits with 1 and logs the reason when the configuration cannot be read', async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const code = await main({ argv: ['--config', join(tmpdir(), 'absent-dsh-superagent.json')], logger })
  expect(code).toBe(1)
  expect(logger.error).toHaveBeenCalledWith('dsh-superagent 无法启动：%s', expect.stringContaining('无法读取配置文件'))
  expect(runtimes).toHaveLength(0)
})
