/** 由内容派生的稳定标识符；相同输入总是产生相同的 id。 */
import { createHash } from 'node:crypto'
export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}
