/** 为准入评估加载的有界 thread 消息窗口。 */
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, TriggerContext } from './kind.ts'

/** 选取 thread 的前五条消息，以及 `sourceId` 两侧各五条消息，并记录被省略的间隔数量。 */
export function threadWindow(messages: ContextMessage[], sourceId: string) {
  const trigger = messages.findIndex(message => message.id === sourceId)
  const selected = messages.map((message, index) => ({ message, index }))
    .filter(({ index }) => index < 5 || (trigger >= 0 && Math.abs(index - trigger) <= 5))
  let previous = -1
  const entries = selected.map(({ message, index }) => {
    const omitted_before = index - previous - 1
    previous = index
    return { message, position: index + 1, omitted_before }
  })
  return { entries, source_found: trigger >= 0, loaded_messages: messages.length, omitted_after: messages.length - previous - 1 }
}
/**
 * 最多读取 trigger 所在 thread 的 `maxPages` 页，并围绕该 trigger 构建有界消息窗口；计数只描述
 * 本次加载的快照（绝不是未读历史），`status` 报告 `chat_neighbours` 等回退模式。
 */
export async function admissionContext(context: TriggerContext, commands: Commands, maxPages: number) {
  const messages: ContextMessage[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let next: string | undefined
  let status: string | undefined
  let more = true
  for (let page = 0; more && page < maxPages; page++) {
    const result = await context.read(commands, 'thread', next)
    for (const message of result.messages) if (!seen.has(message.id)) {
      seen.add(message.id); messages.push(message)
    }
    status ??= result.status
    next = result.next
    more = next !== undefined
    if (next !== undefined && cursors.has(next)) throw new Error('Thread pagination repeated a cursor; context is incomplete')
    if (next !== undefined) cursors.add(next)
  }
  return { messages, window: threadWindow(messages, context.messageId), complete: !more, next: more ? next ?? null : null,
    ...status ? { status } : {} }
}
