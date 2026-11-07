/** 主 Session 与执行器 Session 共享的工具原语和 schema。 */
import { z } from 'zod'
import { IM_WORDS, wordCount } from '../../infra/text.ts'
import { resourceGrammar } from '../resources.ts'

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
export type RegisterTool = <S extends z.ZodType>(name: string, description: string, schema: S, execute: Tool<S>['execute']) => void
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/** 面向人的确认文本，无论发布到哪个渠道都限制在 `IM_WORDS` 之内。 */
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)
/**
 * 构建 `orchestrator_read` 工具，把允许的资源模式限定为主 Session 或
 * 执行器 Session（后者只能读取自己的工单和送达给它的消息）。
 */
export function readTool(description: string, executor: boolean,
  read: (resource: string, offset: number, limit: number | undefined, signal: AbortSignal) => Promise<unknown>): Tool {
  return tool({
    name: 'orchestrator_read',
    description,
    schema: z.object({
      resource: z.string().min(1).describe(`The resource, one of: ${resourceGrammar(executor)}.`),
      offset: z.number().int().min(0).default(0).describe('Copy next_offset from the previous page; it counts characters of a text and items of a list.'),
      limit: z.number().int().min(1).max(8000).optional()
        .describe('Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.'),
    }).strict(),
    execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal),
  })
}
