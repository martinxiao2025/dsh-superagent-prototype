/**
 * 工作区工具的单元测试：文件读写改、目录与搜索、命令执行、输出上限，
 * 以及最关键的路径越界拒绝。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceTools, type WorkerTool } from '../src/executor/workspace-tools.ts'

/** 每个用例创建的临时工单目录。 */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Windows 上被终止的命令可能短暂占用目录，重试几次即可删除。
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
})

/** 建一个临时工单目录并放两个文件。 */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tools-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/app.ts'), 'export const a = 1\nconst b = 2\n', 'utf8')
  await writeFile(join(root, 'README.md'), '# 说明\n', 'utf8')
  const tools = workspaceTools({ directory: root, maxChars: 200 })
  const byName = (name: string): WorkerTool => {
    const tool = tools.find(item => item.name === name)
    if (!tool) throw new Error(`缺少工具 ${name}`)
    return tool
  }
  return { root, byName }
}

describe('workspaceTools', () => {
  it('exposes JSON Schema for every tool and rejects bad arguments', async () => {
    const { byName } = await workspace()
    const read = byName('read_file')
    expect(read.inputSchema).toMatchObject({ type: 'object', required: ['path'] })
    expect(read.inputSchema).not.toHaveProperty('$schema')
    await expect(read.execute({}, new AbortController().signal)).rejects.toThrow()
  })

  it('reads with line numbers, writes, and edits a unique fragment', async () => {
    const { byName } = await workspace()
    const signal = new AbortController().signal
    expect(await byName('read_file').execute({ path: 'src/app.ts', limit: 1 }, signal)).toBe('1\texport const a = 1')
    expect(await byName('write_file').execute({ path: 'src/new.ts', content: 'x' }, signal)).toEqual({ path: 'src/new.ts', bytes: 1 })
    expect(await byName('edit_file').execute({ path: 'src/app.ts', old_text: 'const b = 2', new_text: 'const b = 3' }, signal))
      .toEqual({ path: 'src/app.ts', replacements: 1 })
    expect(await byName('read_file').execute({ path: 'src/app.ts', offset: 2, limit: 1 }, signal)).toBe('2\tconst b = 3')
  })

  it('refuses an ambiguous edit and a missing fragment', async () => {
    const { byName } = await workspace()
    const signal = new AbortController().signal
    await writeFile(join(roots[0]!, 'dup.txt'), 'a\na\n', 'utf8')
    await expect(byName('edit_file').execute({ path: 'dup.txt', old_text: 'a', new_text: 'b' }, signal)).rejects.toThrow('出现 2 次')
    expect(await byName('edit_file').execute({ path: 'dup.txt', old_text: 'a', new_text: 'b', replace_all: true }, signal))
      .toEqual({ path: 'dup.txt', replacements: 2 })
    await expect(byName('edit_file').execute({ path: 'dup.txt', old_text: 'zzz', new_text: 'b' }, signal)).rejects.toThrow('找不到')
  })

  it('keeps every path inside the worktree', async () => {
    const { byName } = await workspace()
    const signal = new AbortController().signal
    for (const path of ['../outside.txt', join(roots[0]!, '..', 'x.txt'), 'C:\\Windows\\win.ini']) {
      await expect(byName('read_file').execute({ path }, signal)).rejects.toThrow('越界')
    }
  })

  it('lists files, skips dependency directories, and searches content', async () => {
    const { root, byName } = await workspace()
    const signal = new AbortController().signal
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'const a = 1\n', 'utf8')
    const listing = String(await byName('list_files').execute({}, signal))
    expect(listing).toContain('src/app.ts')
    expect(listing).not.toContain('node_modules')
    expect(String(await byName('search').execute({ pattern: 'const b' }, signal))).toContain('src/app.ts:2:')
    expect(String(await byName('search').execute({ pattern: '没有这个' }, signal))).toBe('没有命中')
  })

  it('runs a command in the worktree and reports its exit code', async () => {
    const { byName } = await workspace()
    const signal = new AbortController().signal
    const ok = await byName('run_command').execute({ command: 'node -e "console.log(process.cwd())"' }, signal)
    expect(ok).toMatchObject({ exit_code: 0 })
    expect(String((ok as { stdout: string }).stdout)).toContain('dsh-tools-')
    const failed = await byName('run_command').execute({ command: 'node -e "process.exit(3)"' }, signal)
    expect(failed).toMatchObject({ exit_code: 3 })
  })

  it('caps oversized output with a note', async () => {
    const { byName } = await workspace()
    const signal = new AbortController().signal
    const text = String(await byName('read_file').execute({ path: 'README.md' }, signal))
    expect(text).not.toContain('已截断')
    await writeFile(join(roots[0]!, 'big.txt'), `${'y'.repeat(500)}\n`, 'utf8')
    expect(String(await byName('read_file').execute({ path: 'big.txt' }, signal))).toContain('已截断')
  })

  it('kills a command that exceeds its timeout', async () => {
    const { byName } = await workspace()
    const started = Date.now()
    await expect(byName('run_command').execute({ command: 'node -e "setTimeout(()=>{}, 60000)"', timeout_ms: 1000 },
      new AbortController().signal)).rejects.toThrow('仍未结束')
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)
})
