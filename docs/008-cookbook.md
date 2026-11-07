# 008 实例手册

本手册展示如何扩展 dsh-superagent-cn。它使用 [001 领域模型](001-domain.md) 与 [002 授权](002-authorization.md) 中的术语，以及 [007 架构](007-architecture.md) 中的组件。

## 添加一个 Source

本示例实现一个名为 `webhook` 的 Source kind。它通过一个虚构的 CLI `hookq` 读取一个假想的消息队列，把消息转换为触发。其余接口都是 dsh-superagent-cn 的一部分。

实现有四项职责：把事件翻译成领域对象、定义接收与授权规则、提供回复与上下文，以及维护轮询循环。下面的编号步骤按顺序构建这些部件。

示例假设 CLI 契约如下：

- `hookq pull --after <n> --json` 打印位置 `n` 之后的消息，最旧的在前：`{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`。一条消息有 `id`、`conversation`、`thread`（开启其线程的那条消息的 id，该消息本身没有）、带 `id` 与 `bot` 的 `sender`、`mentions_me`、`text`、`at` 和 `url`。
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` 在一条消息下回复，每个 key 只发一次。会话已删除时以 `{"error": {"code": 410, "message": "…"}}` 在标准错误上失败。
- `hookq thread --conversation <id> --root <message id> --json`，配 `--after <cursor>` 翻后续页，打印一个线程的一页，最旧的在前：`{"items": […], "next": "<cursor>"}`，最后一页没有 `next`。

把 kind 与其插件条目放进 `src/sources/webhook.ts`，参照 `src/sources/github.ts`。Source 变大后，像飞书 Source 那样把翻译、渠道与轮询代码拆成独立模块。

### 1. 把事件映射到领域

写代码之前先定下稳定的映射。触发 id、线程 id 与渠道地址都会持久化，事后更改会让既有记录失联。

| 概念 | 对 webhook 队列而言 |
| --- | --- |
| 触发 | 一条消息 |
| 线程 | 一个会话里的一条消息及其回复：`<conversation>:<id of the first message>` |
| 行为人 | 发送者在队列上的 id，即允许名单所记的名字 |
| 渠道地址 | 回复所属的会话与消息 |
| 接收范围 | 一个会话，在准入表中有自己的一行 |

### 2. 配置：schema、字段、事实与健康

模块导入后续步骤用到的内容：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find、scope、channel、threadContext、policy 与 environment 在后续步骤给出。
}
```

- `kind` 是稳定的 Source id。它出现在触发 `source`、线程键前缀、`source:webhook` 设置块和 Source 策略中。
- `schema` 校验已存储的配置并提供默认值。运维者保存实例之前，注册表会用这些默认值创建一个启用的实例。默认值必须什么都不收；本例默认没有会话。
- `fields` 无需自定义面板代码即可生成 Source 设置表单。`rows` 字段按其第一列的键编辑条目；`advanced` 隐藏不常用的设置。若 Source 能把 id 解析为显示名，实现 `refreshLabels`，把名字存在 `KV.sources.labels(kind)` 下；带 `choose` 与 `refresh` 的列随后就能选用它们。
- 可选的 `facts(deployment)` 展示由 setup 推导的值，例如某个 CLI 背后的账号。setup 目前只检查 `SETUP_FIELDS` 列出的 GitHub 与飞书字段，所以本例不提供 facts。
- `health` 声明 Source 的健康条目，初始为 `starting`。注册会认领每个名字，并拒绝与 `runtime`、`reply`、`worker` 或 effect kind 等条目冲突。用 kind 自己的名字，并把 `sync:<id>` 留给策略同步。`error` 会让 status 脚本退出 2、让每小时检查通知运维者，所以只在可能需要人处理时才上报。

### 3. 把一条消息翻译成触发

先校验 CLI 响应再做转换：

```ts
/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** The Trigger of one queue message; the agent's own messages produce none. */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **稳定 id。** 通过 `key` 从队列 id 推导触发 id。`Engine.receive` 对已存储的 id 返回 `duplicate`，重复的接受也只创建一个工单，因此重复读取消息是安全的。要把编辑当作新事件，就把编辑版本加进 id，就像 GitHub 用评论的 `updated_at` 那样。
- **线程。** 第一个线程是主线程，持有评估。额外的线程添加关联上下文。id 由 Source 选定；其完整键是 `webhook:<id>`。
- **发送者。** `actor` 使用 Source 原生 id。机器人和 CI 设 `human: false`。名单上的机器人只能成为推断候选。空的行为人 id（例如 CI）按准入表"不在名单、未面向"的单元格处理。只有消息确实面向智能体时才把 `addressed` 设为 `mention` 或 `direct`；这让允许名单上的人的消息获得显式强度。绝不要为智能体自己的消息产生触发。
- **回复目的地与元数据。** `channel` 标识回复发往何处；`url` 链到来源消息。`channel.thread` 把消息分组以按序投递：同一工单的后发消息在先发消息之前等待，直到先发的那条连续失败三次。其他工单不用等。Source 专属字段放在 `meta` 里，例如接收会话与线程根。`meta` 和 `text` 都是不可信数据，不是授权。

智能体可以通过 `orchestrator_read trigger/<id>` 和 `thread/<key>` 读取新 kind。它们暴露消息文本、处置与相邻触发。新 kind 不会自动获得内置技能、原始服务记录的资源或拉取请求绑定。

文本搜索无需额外代码。当人们使用 Source 专属引用（例如消息 id、URL 或 `#12`）时，实现 `find(query)`，返回这些引用所识别的线程键与搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

这里查询里的队列消息 id（例如 `m42`）会检索对应的触发。

### 4. Source 接收什么：scope

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

引擎经 `SourceRegistry` 对每个到来的触发调用 `scope`。范围外的消息按其原因存储为 filtered，不创建线程。要把消息传给 `receive`，而不是在轮询循环里悄悄丢弃，这样面板才能解释过滤。

`observed: true` 表示该范围内 Source 接收未面向智能体的消息，从而可以对它们做准入表决策。`row` 标识对应的准入行。

重新校验会用授权存储的元数据再次调用 `scope`。让它只依赖 `meta` 与配置。恢复需要 `listened`，不需要 `observed`。没有 `scope` 的 kind 会接收它产生的一切触发，但不观察任何范围。

### 5. 回复：渠道

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **幂等发送。** 发件箱调用 `SourceRegistry.send`，后者调用 `channel.send`。Source 插件卸载期间消息等待。发送可能在远端服务已收到之后失败，因此重试不得重复消息。用 `message.id` 作幂等键：`hookq` 支持 `--key`；GitHub 存一条隐藏的评论标记；飞书接受幂等键。
- **永久失败与可重试失败。** 成功返回 `sent`；只有投递永久不可能时才返回 `gone`，例如示例的 410。gone 的消息保留为 dropped，绝不再排队；它出现在 `GET sources` 和 Source 页面上。其他失败一律 throw，让发件箱在 5 秒后重试并加倍到 300 秒。`CliError.code` 是 CLI 输出报告的代码。
- **允许的目的地。** `allowed(address, config)` 只检查已存地址与当前配置。把每个必需的事实放进地址；例如飞书记录聊天是否为私聊。不再被监听的目的地会被丢弃，而被禁用的 Source 让消息等待。没有 `allowed` 时，Source 启用期间所有地址都被允许。
- **链接。** `link(address, links)` 返回面板经 `SourceRegistry.link` 展示的 URL 与标签。

### 6. 供研判用的线程上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动研判需要触发周围的会话内容。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 翻页、读根消息或父消息。实现可选的 `threadContext` 接口来提供这些读取：

- `read(commands, trigger, part, cursor, config)` 返回一个 `ContextPart`。其 `messages` 使用 `ContextMessage`：`{id, from, at, text}`，外加适用的 `bot`、`deleted`、`reply_to`、`url`、`path` 与 `line` 字段。最后一页省略 `next`。`body` 是展示给研判 Session 的内容，这里是同样的消息。可选的 `status` 可以描述特殊结果，例如飞书的 `chat_neighbours`。`part` 是 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 在其中找到触发自己的消息。
- `images(text)` 与 `image(…)` 用于消息带图片的 kind（如飞书）；示例不实现它们。

没有 `threadContext` 的 kind 不给研判提供线程上下文；触发自身的文本仍可读。

如果消息回复更早的消息，加上 `repliesTo(trigger)`。它返回对应的触发 id，让后续通知与执行器输入在已存储时显示被回复的消息。例如 `hookq` 提供 `reply_to`，而翻译把它存为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁可以请求：策略的 Source 部分

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` 校验 Source 策略，包括 `allowed` 发送者 id。id 比较不区分大小写。准入表单独校验并在 kind 之间共享。这一策略部分保存在 `policy.sources.webhook`，并参与策略版本的计算。
- `fields` 生成 **Eval → On each Source** 下的表单，以 `allowed` 开头。`explicit` 说明如何面向智能体。可选的 `unnamed: {person, bot}` 为不透明 id（例如飞书的 `ou_…`）提供显示标签；本例省略它，因为队列 id 本身可读。
- `rows(config)` 列出准入范围及其可用单元格。每行的 id 必须与 `scope` 返回的 `row` 一致。未面向消息的单元格只在 Source 观察这些消息的范围可用。没有 `rows` 的 kind 使用默认单元格。
- 可选的 `bots` 列出可成为推断候选的机器人，条目形状与 `allowed` 相同。没有它，任何机器人都不被接纳。
- 可选的 `sync: {label, ready(part), run(host, part, signal)}` 在启动时与点击 **Sync now** 时刷新成员。飞书使用聊天成员。失败出现在 `sync:<id>` 下，一分钟后重试并加倍到一小时，直到成功。

### 8. 给执行器的变量

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

即使 Source 被停用，执行设置也会在 prepare 命令旁显示已声明的 `variables`。启用期间，`values` 使用部署、配置与来源触发提供工单专属的值。

prepare 命令从环境变量读取；执行器在其指令中读到值与描述。使用 `DSH_SUPERAGENT_<KIND>_…` 前缀，对来自其他 Source 的工单返回空值，且绝不含凭据。

### 9. 插件条目与其循环

```ts
export const name = 'dsh-superagent-cn-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

插件注入 `orchestrator`。第一个 effect 注册 kind，并在释放时注销。第二个用 `SourceContext` 运行轮询循环。释放时中止循环并等待其完成，包括应用停止或重启期间。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent-cn once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```

- **setup 与开关。** 等待 `ctx.ready`；`ctx.configured()` 为假期间什么也不读。每轮都读 `ctx.config(kind)`：Source 关闭时它是 undefined。
- **游标。** 用 `KV`（`src/kv.ts`）里的类型化条目把读取位置存在 `ctx.state`，例如 `webhook: {cursor: record<number>('webhook-cursor')}`。`tests/store.spec.ts` 要求键字面量只出现在该注册表中。外部包可用导出的 `record` 与 `family` 定义键。设 `undefined` 会删除记录；`ctx.atomic` 把写入分组进事务。

  只有每个覆盖到的触发都已存储后才前进游标。被打断的一轮保持游标不变；稳定 id 使重放安全。时间戳游标可用 `src/sources/poll.ts` 的 `cursorAt(started)`，它会减去五秒以容忍远端晚到的写入。
- **线程元数据。** 收到触发后调用 `ctx.threads.describe(key, {label, url, facts})` 填充其展示信息。`ctx.threads.patch(key, meta)` 委托给 `threads.patchMeta`，设置 Source 持有的键，值为 `undefined` 时移除。两者都忽略不存在的线程，包括被过滤触发的线程。
- **逐条错误。** 统计格式错误的条目并继续，而不是让整批失败。`src/infra/commands.ts` 的 `validItems(item, list, tally)` 支持这一模式。对独立轮询的线程，用 `src/sources/poll.ts` 的 `pollThreads`；它把每次失败记为 `pollError`。其 `polled` 谓词保留存活订阅，以及自最后一个触发与工单结束两者中较晚者起两周的窗口。
- **健康。** 只通过 `ctx.report` 写已声明的条目。`health(state, code, values)` 提供固定消息，如 `setupPending`、`sourceOff` 与 `pollFailures`。上报 `error` 前先统计连续失败次数。
- **中止。** 把信号传给 `ctx.commands.withSignal(signal)` 与 `delay`，并在条目之间检查它，让停止或重启立即结束循环。

本例不发送 Source 主动发起的通知。需要它们的 Source 调用 `ctx.notify`；发件箱像投递其他回复一样投递它们。

它也不把线程绑定到工单完成。只有当 Source 的线程生命周期决定工作是否完成时（如 GitHub 拉取请求那样），才使用 `ctx.tickets.bindThread` 与 `threadClosed`。工单何时结束仍由引擎决定。

### 10. 注册插件

在 `tsdown.config.ts` 中把该模块构建为独立入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

然后在 `package.json` 的 `exports` 中加入 `"./webhook-watch": "./lib/webhook-watch.js"` 导出构建产物，并把插件加进 bundle 的 `cordis.patch.yml` 的 `insert` 列表，默认停用，与飞书一样：

```yaml
    - id: dsh-superagent-cn-webhook
      name: dsh-superagent-cn/webhook-watch
      disabled: true
```

在某个 profile 的 `cordis.patch.yml` 中以 `id: dsh-superagent-cn-webhook`、`disabled: false` 启用插件。构建并重启。新 Source 会出现在 Source 设置与 **Eval → On each Source** 下。

把它的模块与测试加进 [007 架构](007-architecture.md) 的模块与测试表。`tests/docs.spec.ts` 会检查两份索引是否完整。

### 11. 测试

参照 `tests/sources.spec.ts` 的模式创建 `tests/webhook.spec.ts`：临时目录里的真实 Store、带 `HealthBoard` 的 `SourceRegistry`、用替身端口的引擎，以及来自 `sourceContextOf` 的 `SourceContext`。

用监视 `Commands.run` 来模拟 CLI 调用。也要监视 `withSignal`，因为它通常返回一个新的 `Commands` 实例。

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // The registry claims the kind's health entries on the board, where the test reads them.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notices go to the outbox, which keeps their receipts and sends nothing here.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** The queue as `hookq` answers it. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // An allowed sender who mentions the agent makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构造一条队列消息。至少覆盖：

- 翻译：稳定 id、线程、行为人、`human` 与 `addressed`，以及不为智能体自己的消息产生触发；
- 一轮轮询：触发只存储一次、范围外的一条为 `filtered`、游标随后前进、允许发送者的提及被研判为 `explicit`；
- 被打断的一轮保留其游标；
- `send`：`sent`、仅 410 时 `gone`、其他失败 throw，CLI 错误由 `commandError` 构造；
- 线程上下文：一页的消息与下一页游标，如 `tests/registry.spec.ts` 经 `SourceRegistry.threadContext` 读取一个 kind 的线程；
- 插件：`apply` 注册 kind、setup 等待期间上报 `setupPending`、其 disposer 注销 kind、逃出循环的失败成为 Source 的健康而不是未处理的拒绝；
- 策略的 Source 部分与准入行，如 `tests/registry.spec.ts` 与 `tests/policy.spec.ts` 检查飞书 Source 那样。

### 检查清单

1. 映射触发、线程、行为人、渠道地址与接收范围。
2. 写 kind：`schema`、`fields`、`health`，以及 setup 能推导时的 `facts`。
3. 用稳定 id 把事件翻译成触发，丢弃智能体自己的。
4. 在 `scope` 中只依据 `meta` 决定 Source 接收什么。
5. 给它一个渠道，其 `send` 每条消息只发一次，且只在会话永远无法接收时才答 `gone`。
6. 若它能读线程，给研判提供线程上下文。
7. 给它策略的一部分：`allowed` 与准入行。
8. 注册其执行环境变量。
9. 写插件条目与一个循环：等待 setup、跟随开关、在 `receive` 之后移动游标、逐条保留错误、上报健康、中止时停止；游标在 `KV` 中命名。
10. 加构建入口、导出与 `cordis.patch.yml` 的 insert，并把模块与其测试列进 007 的表格。
11. 像 `tests/sources.spec.ts` 测试其他 Source 那样测试它。
