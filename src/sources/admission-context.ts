/** 为准入研判加载的有界线程消息窗口。 */
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, TriggerContext } from './kind.ts'

/** 选取前五条线程消息，加上 `sourceId` 前后各五条消息，并记录被省略的间隔数量。 */
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
 * 读取触发（Trigger）线程中至多 `maxPages` 页，并围绕该触发构建有界消息窗口；各计数仅描述
 * 本次已加载的快照（绝不包含未读历史），`status` 则报告诸如 `chat_neighbours` 的回退模式。
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
