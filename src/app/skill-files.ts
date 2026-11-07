/** 从磁盘加载打包的内置技能定义与提示词模板。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { packageRoot } from '../infra/paths.ts'
/**
 * 读取打包的文本文件，行尾统一为 Unix 换行符。
 * @throws 当文件缺失或仅有空白时抛出并在消息中指明文件名，因为没有它 `dsh-superagent-cn` 无法加载。
 * 后续部分若为绝对路径（提示词覆盖可能这样写）会替换包根目录，因此按原样读取。
 */
function packaged(...parts: string[]): { path: string; text: string } {
  const path = resolve(packageRoot(), ...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
function load(name: string) {
  const { path, text } = packaged('skills', `dsh-superagent-cn-${name}`, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
export const bundledSkills = { feishu: load('feishu'), github: load('github') }
/**
 * 加载内置提示词文件（`prompts/<name>.md`）。Source 的 `.md` 文件每行写一句话以便 diff 易读；
 * `promptFile` 将每个段落内的行用空格连接，同时保留空行形成的段落分隔。
 */
export function promptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
