# 008 手册

本手册演示如何扩展 dsh-superagent。它沿用 [001 领域模型](001-domain.md) 与 [002 授权](002-authorization.md) 中的术语，以及 [007 架构](007-architecture.md) 中的组件。

## 新增一个来源

本配方实现一个名为 `webhook` 的来源类型。它通过一个虚构的 CLI `hookq` 读取一个假想的消息队列，并把消息转换成触发。其余接口都属于 dsh-superagent。

实现包含四项职责：转换事件、定义接收与授权规则、提供回复与上下文、维护轮询循环。下列编号步骤按顺序构建这些部件。

示例假定如下 CLI 契约：

- `hookq pull --after <n> --json` 打印位置 `n` 之后的消息，最旧的在前：`{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`。一条条目含 `id`、`conversation`、`thread`（开启其线程的那条消息的 id，在该消息本身上不存在）、`sender`（含 `id` 与 `bot`）、`mentions_me`、`text`、`at` 与 `url`。
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` 在一条消息下回复，每个 key 只回一次。对于已被删除的对话，它在标准错误上以 `{"error": {"code": 410, "message": "…"}}` 失败。
- `hookq thread --conversation <id> --root <message id> --json`，配合 `--after <cursor>` 取后续分页，打印线程的一页，最旧的在前：`{"items": […], "next": "<cursor>"}`，最后一页不带 `next`。

把该类型及其插件入口放在 `src/sources/webhook.ts`，参照 `src/sources/github.ts`。如果来源继续增长，就像飞书来源那样，把转换、Channel 与轮询代码拆成独立模块。

### 1. 把事件映射到领域模型

写代码之前先选定稳定的映射。触发 id、线程 id 与 Channel 地址都会被持久化，因此之后改动它们可能使既有记录断连。

| 概念 | 对 webhook 队列而言 |
| --- | --- |
| 触发 | 一条消息 |
| 线程 | 一条消息及同一对话中对它的回复：`<conversation>:<id of the first message>` |
| 参与者 | 发送者在该队列上的 id，即允许名单中记载的那个 |
| Channel 地址 | 回复所落在的对话与消息 |
| 接收范围 | 一个对话，在准入表中占自己的一行 |

### 2. 配置：schema、字段、事实与健康

模块导入下列步骤所用的内容：

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
  // find, scope, channel, threadContext, policy and environment follow in the next steps.
}
```

- `kind` 是稳定的来源 id。它出现在触发的 `source`、线程键前缀、`source:webhook` 设置块以及来源策略中。
- `schema` 校验已存储的配置并提供默认值。在运维人员保存实例之前，注册表会依据这些默认值创建一个已启用的实例。让默认值什么都收不到；本示例默认为不含任何对话。
- `fields` 无需自定义面板代码即可生成来源设置表单。`rows` 字段用于编辑以第一列为键的条目；`advanced` 隐藏不常用的设置。如果来源能把 id 解析成显示名，就实现 `refreshLabels`。把这些名字保存在 `KV.sources.labels(kind)` 下。带 `choose` 与 `refresh` 的列随后就能提供它们。
- 可选的 `facts(deployment)` 展示由安装过程推导出的值，例如某个 CLI 背后的账号。安装目前只检查 `SETUP_FIELDS` 中列出的 GitHub 与飞书字段，因此本示例不提供事实。
- `health` 声明来源的健康条目，初始为 `starting`。注册过程会占用每个名字，并拒绝与 `runtime`、`reply`、`worker` 或各类 effect 条目冲突。使用该类型的名字，并把 `sync:<id>` 留给策略同步。`error` 会让状态脚本以 2 退出，并让每小时检查通知运维人员，因此只有在可能需要人工介入时才上报它。

### 3. 把一条消息转换成触发

转换之前先校验 CLI 响应：

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

- **稳定的 id。** 通过 `key` 从队列 id 推导触发 id。`Engine.receive` 对已存储的 id 返回 `duplicate`，而重复的接受只会创建一张工单。因此重读消息是安全的。若要把编辑视为新事件，就像 GitHub 用评论的 `updated_at` 那样，在 id 里加入编辑版本。
- **线程。** 第一个线程是主线程，拥有评估。额外的线程增加关联上下文。id 由来源选定；其完整键是 `webhook:<id>`。
- **发送者。** 在 `actor` 中使用来源原生的 id。对机器人与 CI 设置 `human: false`。名单内的机器人只能成为推断候选。空的 actor id（如 CI 的情形）会使用准入表中针对未列入名单、未被 @ 的发送者的单元格。只有当消息确实指向智能体时，才把 `addressed` 设为 `mention` 或 `direct`；这会给名单内人员的消息显式强度。绝不要为智能体自己的消息生成触发。
- **回复目标与元数据。** `channel` 指明回复发往何处；`url` 链接到来源消息。`channel.thread` 把消息分组以便有序投递：一张工单的后续消息会排在它较早的消息之后等待，直到较早的消息失败三次。其他工单不等待。把来源特有的字段放进 `meta`，例如接收对话与线程根。`meta` 与 `text` 都是不可信数据，不是授权。

智能体可以通过 `orchestrator_read trigger/<id>` 与 `thread/<key>` 读取新类型。这些入口暴露消息文本、处置结果以及相邻触发。新类型不会自动获得内置技能、原始服务记录的资源或 pull request 绑定。

文本搜索无需额外代码即可工作。当人们使用来源特有的引用（如消息 id、URL 或 `#12`）时，实现 `find(query)`。返回这些引用所指向的线程键与搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

此处的查询里的队列消息 id（如 `m42`）会用它搜索触发。

### 4. 来源接收什么：范围

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

引擎通过 `SourceRegistry` 为每个进入的触发调用 `scope`。超出范围的消息会连原因一起作为已过滤存储，并且不创建线程。把消息传给 `receive`，而不是在轮询循环里静默丢弃，这样面板才能解释过滤。

`observed: true` 表示来源在该范围内接收未被 @ 的消息，从而允许对它们做准入表决策。`row` 标识对应的准入行。

复验时会用 Mandate 存储的元数据调用 `scope`。让它只依赖 `meta` 与配置。恢复需要的是 `listened`，不是 `observed`。没有 `scope` 时，一个类型会接收它产生的每个触发，但一个都不观察。

### 5. 回复：Channel

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

- **幂等发送。** Outbox 调用 `SourceRegistry.send`，后者调用 `channel.send`。来源插件卸载期间消息会等待。发送可能在远端服务已经收到之后才失败，因此重试不得重复消息。用 `message.id` 作为幂等键：`hookq` 支持 `--key`；GitHub 会存一个隐藏的评论标记；飞书接受幂等键。
- **永久失败与可重试失败。** 成功时返回 `sent`，只有当投递永久不可能时才返回 `gone`，如示例中的 410。gone 消息会作为已丢弃保留，永不再次入队；它会出现在 `GET sources` 与来源页面上。其他失败则抛出，让 Outbox 在 5 秒后重试，并逐次翻倍至 300 秒。`CliError.code` 是 CLI 输出所报告的 code。
- **允许的目标。** `allowed(address, config)` 只检查已保存的地址与当前配置。把每个必需的事实放进地址；例如飞书会记录会话是否为直聊。不再被监听的目会被丢弃，而禁用的来源会让消息一直等待。没有 `allowed` 时，只要来源启用，所有地址都被允许。
- **链接。** `link(address, links)` 返回面板通过 `SourceRegistry.link` 显示的 URL 与标签。

### 6. 供评估使用的线程上下文

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

主动评估需要触发周围的对话。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 展开分页、根或父消息。实现可选的 `threadContext` 接口以提供这些读取：

- `read(commands, trigger, part, cursor, config)` 返回一个 `ContextPart`。其 `messages` 使用 `ContextMessage`：`{id, from, at, text}` 加上适用的 `bot`、`deleted`、`reply_to`、`url`、`path` 与 `line` 字段。最后一页省略 `next`。`body` 是展示给评估会话的内容，此处即同样的消息。可选的 `status` 可以描述特殊结果，如飞书的 `chat_neighbours`。`part` 为 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 在它们之中找出触发自己的那条消息。
- `images(text)` 与 `image(…)` 用于消息带图片的类型，如飞书的那样；本示例略去它们。

没有 `threadContext` 的类型给评估提供不了线程上下文；触发自身的文本仍可读。

如果消息会回复更早的消息，加上 `repliesTo(trigger)`。它返回对应的触发 id，使后续通知与 worker 输入在已存储时能显示被回复的消息。例如，如果 `hookq` 提供 `reply_to`，且转换把它存为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁能发起：策略中属于来源的那部分

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

- `schema` 校验来源策略，包括 `allowed` 发送者 id。id 比较不区分大小写。准入表单独校验，并在各类型间共享。这部分策略保存在 `policy.sources.webhook`，并计入策略版本。
- `fields` 在 **Eval → On each Source** 下生成表单，以 `allowed` 开头。`explicit` 说明如何指向智能体。可选的 `unnamed: {person, bot}` 为不透明 id（如飞书的 `ou_…`）提供显示标签；本示例省略它，因为队列 id 本身就是可读的名字。
- `rows(config)` 列出准入范围及其可用单元格。每个行 id 必须与 `scope` 返回的 `row` 一致。只有当来源观察未 @ 消息时，未 @ 消息的单元格才可用。没有 `rows` 的类型使用默认单元格。
- 可选的 `bots` 列出有资格成为推断候选的机器人，条目形状与 `allowed` 相同。没有它时，任何机器人都不会被准入。
- 可选的 `sync: {label, ready(part), run(host, part, signal)}` 在启动时以及 **Sync now** 时刷新成员资格。飞书使用会话成员。失败会出现在 `sync:<id>` 下，并在 1 分钟后重试，逐次翻倍至 1 小时，直到成功。

### 8. 供执行器使用的变量

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

即使来源被禁用，执行设置也会在准备命令旁显示声明的 `variables`。启用时，`values` 用部署信息、配置与来源触发提供工单特有的值。

准备命令读取环境变量；worker 在其说明中读取这些变量的值。使用 `DSH_SUPERAGENT_<KIND>_…` 前缀，对来自其他来源的工单返回空值，绝不包含凭证。

### 9. 插件入口及其循环

```ts
export const name = 'dsh-superagent-webhook'
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

插件注入 `orchestrator`。它的第一个 effect 注册类型，并在销毁时注销。第二个用 `SourceContext` 运行轮询循环。销毁会中止循环并等待其完成，包括在应用停止或重启期间。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
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

- **安装与开关。** 等待 `ctx.ready`，当 `ctx.configured()` 为 false 时不读取任何东西。每轮都读 `ctx.config(kind)`：来源关闭时它是 undefined。
- **游标。** 用 `KV`（`src/kv.ts`）中的类型化条目把读取位置存进 `ctx.state`，如 `webhook: {cursor: record<number>('webhook-cursor')}`。`tests/store.spec.ts` 要求键字面量只出现在该注册表中。外部包可以用导出的 `record` 与 `family` 定义键。把值设为 `undefined` 会移除记录；`ctx.atomic` 把写入分组到一个事务中。

  只有在覆盖范围内的所有触发都已存储之后才推进游标。中断的一轮会保持游标不变；稳定的 id 使重放安全。对时间戳游标，`src/sources/poll.ts` 的 `cursorAt(started)` 会减去五秒，以容忍远端写入延迟。
- **线程元数据。** 接收到触发后，调用 `ctx.threads.describe(key, {label, url, facts})` 填充其显示信息。`ctx.threads.patch(key, meta)` 委托给 `threads.patchMeta`，设置来源拥有的键，或在值为 `undefined` 时移除它们。两者都会忽略不存在的线程，包括被过滤触发的线程。
- **逐条错误。** 统计格式错误的条目并继续，而不是让整批失败。`src/infra/commands.ts` 中的 `validItems(item, list, tally)` 支持这种模式。对独立轮询的线程，使用 `src/sources/poll.ts` 的 `pollThreads`；它把每次失败记录为 `pollError`。其 `polled` 谓词保留活跃订阅，以及最后一个触发与工单结束两者中较晚者之后的两周窗口。
- **健康。** 只通过 `ctx.report` 写已声明的条目。`health(state, code, values)` 提供固定消息，如 `setupPending`、`sourceOff` 与 `pollFailures`。在上报 `error` 之前先统计连续失败次数。
- **中止。** 把 signal 传给 `ctx.commands.withSignal(signal)` 与 `delay`，并在条目之间检查它，这样停止或重启会立刻结束循环。

本示例不发送来源发起的通知。需要它们的来源调用 `ctx.notify`；Outbox 会像其他回复那样投递。

它也不把线程绑定到工单完成。只有当来源的线程生命周期决定工作是否完成（如 GitHub 的 pull request 那样）时，才使用 `ctx.tickets.bindThread` 与 `threadClosed`。工单何时结束仍由引擎决定。

### 10. 注册插件

在 `tsdown.config.ts` 中把该模块构建为独立入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

然后通过把 `"./webhook-watch": "./lib/webhook-watch.js"` 加到 `exports`，在 `package.json` 中导出构建产物，并把插件加进 bundle 的 `cordis.patch.yml` 的 `insert` 列表，处于禁用状态，就像飞书那样：

```yaml
    - id: dsh-superagent-webhook
      name: dsh-superagent/webhook-watch
      disabled: true
```

在某个 profile 的 `cordis.patch.yml` 中用 `id: dsh-superagent-webhook` 与 `disabled: false` 启用该插件。构建并重启。新来源会出现在来源设置中，以及 **Eval → On each Source** 下。

把它的模块与 spec 加入 [007 架构](007-architecture.md) 的模块表与测试表。`tests/docs.spec.ts` 会检查两张索引是否完整。

### 11. 测试

参照 `tests/sources.spec.ts` 的模式创建 `tests/webhook.spec.ts`：临时目录中的真实 Store、带 `HealthBoard` 的 `SourceRegistry`、使用替身端口的引擎，以及来自 `sourceContextOf` 的 `SourceContext`。

通过监视 `Commands.run` 来 mock CLI 调用。同时也要监视 `withSignal`，因为它通常会返回一个新的 `Commands` 实例。

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

`message(id, fields)` 构造一个队列条目。至少覆盖：

- 转换：稳定的 id、线程、actor、`human` 与 `addressed`，以及智能体自己的消息不产生触发；
- 一轮：触发只存一次，一个超出范围的为 `filtered`，游标在其后推进，名单内发送者的 @ 被评估为 `explicit`；
- 被中断的一轮，其游标保持不变；
- `send`：`sent`，仅 410 时 `gone`，其他失败抛出，CLI 错误由 `commandError` 构造；
- 线程上下文：一页的消息与下一页的游标，正如 `tests/registry.spec.ts` 通过 `SourceRegistry.threadContext` 读取某个类型的线程那样；
- 插件：`apply` 注册类型，并在安装等待期间上报 `setupPending`，其销毁函数注销该类型，逃出循环的失败会变成来源的健康条目而不是未处理的 rejection；
- 来源在策略中的部分及其准入行，正如 `tests/registry.spec.ts` 与 `tests/policy.spec.ts` 检查飞书来源的那样。

### 检查清单

1. 映射触发、线程、actor、Channel 地址与接收范围。
2. 编写类型：`schema`、`fields`、`health`，以及若安装会推导出值时再加上 `facts`。
3. 把事件转换成带稳定 id 的触发，并丢弃智能体自己的消息。
4. 在 `scope` 里仅依据 `meta` 决定来源接收什么。
5. 给它一个 Channel，其 `send` 每条消息只投递一次，且仅在对话永远无法收到时返回 `gone`。
6. 如果来源能读取线程，就为评估提供其线程上下文。
7. 用 `allowed` 与准入行给它策略的一部分。
8. 注册其执行环境变量。
9. 编写插件入口与循环：等待安装、跟随开关、在 `receive` 之后推进游标、按条目保存错误、上报健康并在中止时停止；在 `KV` 中命名游标。
10. 添加构建入口、导出与 `cordis.patch.yml` 的 insert，并在 007 的两个表中列出该模块及其 spec。
11. 参照 `tests/sources.spec.ts` 测试其他来源的方式来测试它。
