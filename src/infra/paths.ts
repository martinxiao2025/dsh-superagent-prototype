/** 从源码树或编译后的 lib/ 输出中解析打包资源的路径。 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent-cn') return cached = directory }
      catch { /* 向上路径上外来的 package.json 不是本包。 */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent-cn package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
