/** 飞书出站 channel：在话题中发布机器人回复，并构造群聊深链。 */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** 打开群聊的飞书或 Lark AppLink；在事件未携带消息自身链接时使用。 */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * 当飞书因目标消息被撤回、标记为 withdrawn 或未找到而永久拒绝回复时为 true。
 * 只有带有上述错误码的飞书响应才表示目标消息已不存在；超时或崩溃则不表示。
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** 在目标消息所在话题中回复；飞书按幂等键（出站消息的 `message.id`）至多保留一条回复。 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('缺少飞书回复目标')
  const text = checkedImText(message.text)
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', message.id]
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** 回退的群聊链接，使用机器人所属品牌；可用时优先使用 Trigger 上消息自身的深链。 */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
