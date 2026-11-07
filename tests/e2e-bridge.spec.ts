/**
 * 真实端到端：真实的 Runtime、Store、Engine 与工具面，模型回合经 VS Code 语言模型桥执行。
 * 本机没有正在运行的桥（找不到发现文件）时整组跳过，不算通过也不算失败。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeFilePath, readBridgeInfo } from '../src/executor/bridge.ts'
import { VsCodeLmHost } from '../src/executor/vscode-lm.ts'
import { latestReport } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const info = await readBridgeInfo(bridgeFilePath())

describe.skipIf(!info)('真实模型经 VS Code 语言模型桥跑完一条工单', () => {
  it('从受理到真实回合、可验证的产出、ready 汇报与结果交付', { timeout: 600_000 }, async () => {
    const h = await startRuntime(undefined, { host: new VsCodeLmHost({ discoverMs: 10_000 }) })
    try {
      const trigger = feishu('11', '@bot README 里有个错别字 teh，改成 the。')
      h.runtime.receive(trigger)
      await h.runtime.idle()
      const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: '修正 README 错别字', worktree_name: 'fix-typo',
        acknowledgement: '收到，我来改。', note: '把 README.md 里的 teh 改成 the，然后汇报 ready；不需要 PR。' })
      const ticketId = (result.ticket as { ticket_id: string }).ticket_id
      // 真实工作目录在 prepare 之后才建好；回合由 launch 副作用启动，此刻还来得及放一份原始仓库。
      const directory = h.runtime.store.tickets.get(ticketId)!.execution!.directory
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'README.md'), '# widgets\n\nThis is teh widget factory.\n', 'utf8')
      // 回合由真实模型承担，drain 会一直等到它收尾。
      await h.drain()
      const ticket = h.runtime.store.tickets.get(ticketId)!
      const transcript = h.runtime.store.get(KV.transcript(ticket.id)) ?? []
      const said = transcript.flatMap(item => (item as { message?: { content?: { text?: string }[] } }).message?.content ?? [])
        .map(part => String(part.text ?? '')).join('\n')
      // 真实模型确实产出了文本，并把工单推进到 ready。
      expect(transcript.length).toBeGreaterThan(1)
      expect(said.trim().length).toBeGreaterThan(10)
      expect(latestReport(ticket)?.state, said).toBe('ready')
      // 产出是真实的：工作目录里的错别字已被改掉。
      expect(readFileSync(join(directory, 'README.md'), 'utf8')).toContain('the widget factory')
      // ready 之后审核门才允许以结果交付。
      const reply = await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result',
        text: 'README 的错别字已修正。' })
      // 交付进入发件箱，来源关闭时也不会被伪装成已送达。
      expect(reply).toEqual({ status: 'sent' })
    } finally {
      await h.stop()
    }
  })
})
