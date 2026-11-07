/** bundle 的补丁，用 DSH 读取 bundle 补丁的条目列表方言读取，以及它定义的 agent preset。 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ROUTER_PRESET, WORKER_PRESET } from '../src/app/sessions.ts'

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }
/** DSH 读取补丁的方式：Cordis 的 include 插件解析 `!!js` 标量，并把插入应用到条目列表。 */
async function patched(): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const rows = applyEntryPatches([], patches, message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}
/** preset 的每个插件行，包括组内的。 */
const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

/** 补丁定义的一个 preset，按其 id 查找。 */
const presetOf = (rows: readonly Row[], id: string) => rows.map(row => row.config as { id?: string; order?: number; plugins: Row[] })
  .find(config => config?.id === id)!

it('定义 Executor Session 所用的 worker preset，其 shell 会把长命令移到后台', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['dsh-superagent-cn', 'dsh-superagent-cn-github', 'dsh-superagent-cn-feishu', 'dsh-superagent-cn-worker-preset',
    'dsh-superagent-cn-router-preset'])
  const preset = presetOf(rows, WORKER_PRESET)
  expect(preset.id).toBe(WORKER_PRESET)
  const plugins = flat(preset.plugins)
  const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  expect(named('@deepseek-ai/dsh-bash-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-pwsh-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-jobs')).toEqual([{ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-web')).toEqual([expect.objectContaining({ fetch: false })])
  // spawn 出的子 agent 运行在 standard 之下，其 shell 只在 60 秒后才把命令移到后台；本应运行在本 preset 之下的
  // fork 出的子 agent 未包含在内。
  expect(named('@deepseek-ai/dsh-tool-subagent')).toEqual([expect.objectContaining({ provider: 'spawn', agentPreset: 'standard' })])
  // 只含 worker 所需的工具，不含任何询问人、展示、规划、修改 profile、调度、设定目标或运行工作流的工具。
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-agent-instructions']) expect(named(name).length).toBeGreaterThan(0)
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-plugin-manager/tools',
    '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names).not.toContain(name)
})

it('定义主 Session 所用的 router preset：worker 的 5 秒 shell 与 job 等待，以及它用到的工具', async () => {
  const rows = await patched()
  const router = presetOf(rows, ROUTER_PRESET), worker = presetOf(rows, WORKER_PRESET)
  expect(router.order).toBe(91)
  const plugins = flat(router.plugins)
  const named = (preset: Row[], name: string) => preset.filter(row => row.name === name).map(row => row.config)
  for (const name of ['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-jobs']) {
    expect(named(plugins, name), name).toEqual(named(flat(worker.plugins), name))
  }
  // 其允许列表保留的工具：skill、bash、read、read_image 与 job 工具；文件工具只读。
  for (const name of ['@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner']) expect(named(plugins, name).length, name).toBeGreaterThan(0)
  expect(named(plugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names, name).not.toContain(name)
})
