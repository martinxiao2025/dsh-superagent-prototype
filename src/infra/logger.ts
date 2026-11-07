/** 从 DSH 日志服务抽出的最小日志接口，供独立进程与 Runtime 使用。 */

/** Runtime 只依赖这三个级别；消息用 `%s` 占位，参数按 `console` 语义格式化。 */
export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 写入标准输出的日志；`error` 走标准错误，便于守护脚本分离两类输出。 */
export const consoleLogger: Logger = {
  info: (message, ...args) => { console.log(message, ...args) },
  warn: (message, ...args) => { console.warn(message, ...args) },
  error: (message, ...args) => { console.error(message, ...args) },
}

/** 去掉日志里可能出现的凭据：`token=…`、`Bearer …` 与常见 CLI 令牌前缀。 */
export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b((?:token|secret|password|app_secret|appSecret)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted>')
}

/** 保证日志不泄漏凭据的包装：先脱敏再交给底层 logger。 */
export function redactingLogger(inner: Logger): Logger {
  const write = (method: keyof Logger) => (message: string, ...args: unknown[]): void => {
    const text = redact(message)
    const values = args.map(value => typeof value === 'string' ? redact(value) : value)
    inner[method](text, ...values)
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}
