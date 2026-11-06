/** 从源码树或编译后的 lib/ 产物中解析打包资源路径。 */
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
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent') return cached = directory }
      catch { /* 向上查找时遇到的其它 package.json 不属于本包。 */ }
    }
    directory = dirname(directory)
  }
  throw new Error('未找到 dsh-superagent 的包根目录')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
