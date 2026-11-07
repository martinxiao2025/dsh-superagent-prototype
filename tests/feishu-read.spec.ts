import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { feishuRead, readFeishu, feishuReferences, readFeishuLink } from '../src/sources/feishu-read.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const event: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const source = { message_id: 'om_source', chat_id: 'oc_chat', parent_id: 'om_parent', root_id: 'om_root', thread_id: 'omt_thread' }
const message = { message_id: 'om_root', chat_id: 'oc_chat', msg_type: 'merge_forward', content: '<forwarded_messages>Earlier discussion ![Image](img_one)</forwarded_messages>', sender: { id: 'ou_user', name: 'User', sender_type: 'user' }, create_time: '2026-09-11 12:00' }
afterEach(() => vi.restoreAllMocks())
it('解析旧版来源元数据并读取合并转发，不嵌入自动展开的线程', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ messages: [{ ...message, thread_replies: [{ content: 'Automatic expansion omitted' }] }] })
  const result = await readFeishu(commands, event, 'feishu/source/root', 20)
  expect(result).toMatchObject({ status: 'available', message: { content: message.content } })
  // 读取响应自身不陈述任何限制；skill 只陈述一次。
  expect(result).not.toHaveProperty('limitations')
  expect(JSON.stringify(result)).not.toContain('Automatic expansion omitted')
  expect(lark.mock.calls[1]![0]).toEqual(['im', '+messages-mget', '--message-ids', 'om_root', '--no-reactions'])
})
it('用不透明游标对来源线程消息分页，并保留作者与编辑时间戳', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: true, page_token: 'a/b+next=', messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', updated: true, update_time: '2026-09-11 12:01' }] })
  const first = await readFeishu(commands, event, 'feishu/source/thread', 2)
  expect(first).toMatchObject({ next_resource: 'feishu/source/thread/a%2Fb%2Bnext%3D', messages: [{ sender: message.sender, updated: true }] })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false, messages: [] })
  await readFeishu(commands, event, 'feishu/source/thread/a%2Fb%2Bnext%3D', 2)
  expect(lark.mock.lastCall![0]).toContain('a/b+next=')
})
it('跳过并计数无法读取的话题消息，读取其余消息', async () => {
  vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false,
    messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread' }, { ...message, message_id: 'om_odd',
      sender: { sender_type: 'app' } }] })
  const page = await readFeishu(commands, event, 'feishu/source/thread', 20)
  expect(page).toMatchObject({ skipped: 1, messages: [{ message_id: 'om_reply' }] })
})
it('拒绝无关路径、缺失来源、跨会话结果与未推进的分页', async () => {
  const lark = vi.spyOn(commands, 'lark')
  await expect(readFeishu(commands, event, 'feishu/other/thread', 20)).rejects.toThrow('source trigger')
  await expect(readFeishu(commands, event, 'feishu/source/root/cursor', 20)).rejects.toThrow('Use feishu')
  expect(lark).not.toHaveBeenCalled()
  lark.mockResolvedValueOnce({ items: [] })
  await expect(readFeishu(commands, event, 'feishu/source/message', 20)).rejects.toThrow('unavailable')
  lark.mockResolvedValueOnce({ items: [{ ...source, chat_id: 'oc_elsewhere' }] })
  await expect(readFeishu(commands, event, 'feishu/source/root', 20)).rejects.toThrow('chat does not match')
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: true, messages: [] })
  await expect(readFeishu(commands, event, 'feishu/source/thread', 20)).rejects.toThrow('did not advance')
})
it('明确报告缺失的父消息/线程与已删除内容', async () => {
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ items: [{ message_id: 'om_source', chat_id: 'oc_chat' }] })
  expect(await readFeishu(commands, event, 'feishu/source/thread', 20)).toMatchObject({ status: 'no_thread', next_resource: null })
  expect(await readFeishu(commands, event, 'feishu/source/parent', 20)).toMatchObject({ status: 'no_parent', message: null })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ messages: [{ ...message, deleted: true }] })
  expect(await readFeishu(commands, event, 'feishu/source/root', 20)).toMatchObject({ status: 'deleted' })
})

it('只读取来源消息链接，拒绝缺失、已删除或跨会话的结果', async () => {
  const linked = { message_id: 'om_source', chat_id: 'oc_chat', message_app_link: 'https://applink.feishu.cn/client/message/link/open?token=source' }
  const lark = vi.spyOn(commands, 'lark').mockResolvedValue({ messages: [{ ...linked, message_id: 'om_other', message_app_link: 'https://example.com/other' }, linked] })
  await expect(readFeishuLink(commands, event)).resolves.toBe(linked.message_app_link)
  expect(lark).toHaveBeenCalledWith(['im', '+messages-mget', '--message-ids', 'om_source', '--no-reactions'])
  for (const row of [{ ...linked, deleted: true }, { ...linked, chat_id: 'oc_elsewhere' }, { ...linked, message_app_link: undefined }, { ...linked, message_id: 'om_other' }]) {
    lark.mockResolvedValueOnce({ messages: [row] })
    await expect(readFeishuLink(commands, event)).rejects.toThrow('unavailable')
  }
})
it('把话题页读成模型可读的消息：id、作者、ISO 时间、文本与每条所回复的消息', async () => {
  vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ thread_id: 'omt_thread', has_more: false,
    messages: [{ ...message, message_id: 'om_reply', thread_id: 'omt_thread', parent_id: 'om_root', message_app_link: 'https://applink.feishu.cn/x' },
      { ...message, message_id: 'om_bot', sender: { id: 'cli_bot', name: 'Bot', sender_type: 'app' } }] })
  expect(await feishuRead(commands, event, 'feishu/source/thread', 20)).toEqual({ status: 'available', thread_id: 'omt_thread', next_resource: null,
    messages: [{ id: 'om_reply', from: 'User', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, reply_to: 'om_root',
      url: 'https://applink.feishu.cn/x' }, { id: 'om_bot', from: 'Bot', at: new Date('2026-09-11 12:00').toISOString(), text: message.content, bot: true }] })
})
it('按时间读取消息周围的会话：之前五条、该消息与之后五条，然后是更早的页', async () => {
  const at = Date.parse('2026-09-11T12:00:00Z')
  const item = (n: number) => ({ message_id: `om_${n}`, chat_id: 'oc_chat', create_time: String(at + n * 1000), sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `message ${n}` }) } })
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [source] })
    .mockResolvedValueOnce({ items: [0, -1, -2, -3, -4, -5].map(item), has_more: true, page_token: 'older' })
    .mockResolvedValueOnce({ items: [0, 1, 2].map(item), has_more: false })
  const ref = { ...event, at: new Date(at).toISOString() }
  const around = await feishuRead(commands, ref, 'feishu/source/around', 20)
  expect(around).toMatchObject({ status: 'available', next_resource: 'feishu/source/around/older' })
  expect('messages' in around && around.messages.map(message => [message.id, message.text]))
    .toEqual([-5, -4, -3, -2, -1, 0, 1, 2].map(n => [`om_${n}`, `message ${n}`]))
  const params = (call: number) => JSON.parse(lark.mock.calls[call]![0].at(-1)!) as Record<string, unknown>
  expect(params(1)).toMatchObject({ container_id: 'oc_chat', sort_type: 'ByCreateTimeDesc', end_time: String(at / 1000), page_size: 6 })
  expect(params(2)).toMatchObject({ sort_type: 'ByCreateTimeAsc', start_time: String(at / 1000), page_size: 6 })
  lark.mockResolvedValueOnce({ items: [source] }).mockResolvedValueOnce({ items: [-6, -7].map(item), has_more: false })
  const earlier = await feishuRead(commands, ref, 'feishu/source/around/older', 20)
  expect('messages' in earlier && earlier.messages.map(message => message.id)).toEqual(['om_-7', 'om_-6'])
  expect(params(4)).toMatchObject({ page_token: 'older', page_size: 10 })
})
