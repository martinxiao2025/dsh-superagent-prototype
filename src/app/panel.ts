/** 独立面板服务器：在回环地址上提供管理 API 与静态资源，替代 DSH 的 Web 服务器。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 面板服务器依赖：请求处理器与端口/日志选项。 */
export interface PanelServerOptions {
  /** 只允许回环地址。 */
  readonly host: '127.0.0.1' | 'localhost'
  /** 期望端口；0 表示自动选择。 */
  readonly port: number
  /** 处理 `/orchestrator/api/*` 的入口。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** 静态资源目录；缺省为构建产物旁边的 `panel` 目录。 */
  readonly root?: string
  readonly log?: (message: string, error?: unknown) => void
}

/** 单页面板的 HTML 外壳；客户端脚本为同目录的 `main.js`。 */
const SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-superagent</title>
<style>html,body,#root{height:100%;margin:0}</style>
</head>
<body>
<div id="root"></div>
<script src="/main.js"></script>
</body>
</html>`

/** 常见扩展名的响应类型。 */
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

/**
 * 在回环地址上提供面板与管理 API。API 路径保持 `/orchestrator/api/*`，与面板客户端一致；
 * 其余 GET 请求返回静态资源，未知路径回落到单页外壳。
 */
export class PanelServer {
  private server?: Server
  private actualPort = 0
  private readonly root: string
  /** 记录选项；静态目录默认取构建产物同目录下的 `panel/`（即 `lib/panel`）。 */
  constructor(private readonly options: PanelServerOptions) {
    this.root = options.root ?? join(dirname(fileURLToPath(import.meta.url)), 'panel')
  }
  /** 实际监听的端口；尚未启动时为 0。 */
  get port(): number { return this.actualPort }
  /** 开始监听；端口占用等失败以异常返回，由调用方写入健康条目。 */
  async start(): Promise<void> {
    const server = createServer((req, res) => { void this.route(req, res) })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error) }
      const ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', ready)
      server.listen(this.options.port, this.options.host)
    })
    const address = server.address()
    this.actualPort = typeof address === 'object' && address ? address.port : this.options.port
  }
  /** 停止监听；重复调用是安全的。 */
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  /** 分派一次请求：API 交给运行时，其余按静态文件处理。 */
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if ((req.url ?? '/').startsWith('/orchestrator/api/')) { await this.options.handle(req, res); return }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/' || path === '/index.html') { this.text(res, 200, 'text/html; charset=utf-8', SHELL, req.method === 'HEAD'); return }
      const file = normalize(join(this.root, decodeURIComponent(path)))
      // 拒绝越出静态目录的路径。
      if (!file.startsWith(this.root + sep)) { this.text(res, 404, 'text/plain; charset=utf-8', '未找到'); return }
      const body = await readFile(file).catch(() => undefined)
      if (!body) { this.text(res, 404, 'text/plain; charset=utf-8', '未找到'); return }
      const type = TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      this.options.log?.('面板请求失败', error)
      if (!res.headersSent) this.text(res, 500, 'text/plain; charset=utf-8', '面板内部错误')
      else res.end()
    }
  }
  /** 发送一段文本响应。 */
  private text(res: ServerResponse, status: number, type: string, body: string, head = false): void {
    res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' })
    res.end(head ? undefined : body)
  }
}
