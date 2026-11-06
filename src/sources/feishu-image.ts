/** 在评估期间下载飞书消息图片，并提交为模型可见的附件。 */
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { FeishuRef } from './feishu-read.ts'

/** 从消息文本中提取飞书图片键，使其与来源消息保持配对；不接受任意远端 ID。 */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}

export interface AdmissionImage {
  source_message_id: string
  image_key: string
  image: ImageAttachmentRef
}

export async function readAdmissionImage(agent: Agent, commands: Commands, ref: FeishuRef, text: string, imageKey: string, stateDir: string, signal: AbortSignal): Promise<AdmissionImage> {
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('请从这条来源消息中选择一个图片键')
  const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId)
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('无法读取图片：没有挂载附件服务')
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('无法读取图片：当前模型路由尚未解析')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`模型 ${model} 不支持图片输入；该图片未被检视`)
  signal.throwIfAborted()
  const directory = await mkdtemp(join(stateDir, 'admission-image-'))
  try {
    const result = z.object({ saved_path: z.string() }).parse(await commands.withSignal(signal).lark([
      'im', '+messages-resources-download', '--message-id', messageId, '--file-key', imageKey, '--type', 'image', '--output', './image',
    ], directory))
    const path = await realpath(result.saved_path)
    if (dirname(path) !== await realpath(directory)) throw new Error('图片下载返回了临时目录之外的路径')
    const mediaTypes: Record<string, ImageMediaType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    const mediaType = mediaTypes[extname(path).toLowerCase()]
    if (!mediaType) throw new Error('下载的资源不是受支持的 PNG/JPEG/WebP/GIF 图片')
    const file = await stat(path)
    if (!file.isFile() || file.size > Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)) throw new Error('图片超过部署的字节上限，或不是普通文件')
    const data = await readFile(path, { signal })
    signal.throwIfAborted()
    const image = await attachments.saveImage({ data, mediaType, name: `${imageKey}${extname(path)}` })
    signal.throwIfAborted()
    return { source_message_id: messageId, image_key: imageKey, image }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
