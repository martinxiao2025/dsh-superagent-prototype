/** 从磁盘加载打包的内置技能定义与提示词模板。 */
import { readFileSync } from 'node:fs'
import { packagePath } from '../infra/paths.ts'
/**
 * 读取打包的文本文件，并将换行统一为 Unix 风格。
 * @throws 文件缺失或只含空白字符时抛出错误并指明该文件，因为 `dsh-superagent` 缺少它就无法加载。
 */
function packaged(...parts: string[]): { path: string; text: string } {
  const path = packagePath(...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`缺少打包文件：${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`打包文件为空：${path}`)
  return { path, text }
}
function load(name: string) {
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`打包的 skill 无效：${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
export const bundledSkills = { feishu: load('feishu'), github: load('github') }
/**
 * 加载内置提示词文件（`prompts/<name>.md`）。源 `.md` 文件每行一句，便于 diff 阅读；
 * `promptFile` 用空格拼接同一段落内的各行，同时保留空行形成的段落分隔。
 */
export function promptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
