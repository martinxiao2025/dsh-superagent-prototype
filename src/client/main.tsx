/** 独立面板入口：挂载 React 面板到回环服务器返回的 HTML 外壳。 */
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'
import { en, zh, type DshSuperagentKey } from './locales.ts'
import type { T } from './text.ts'
import { fill } from '../infra/text.ts'

/** 记住用户选择的界面语言；默认跟随浏览器。 */
const LANGUAGE_KEY = 'dsh-superagent-language'
const stored = globalThis.localStorage?.getItem(LANGUAGE_KEY)
const language: 'zh' | 'en' = stored === 'en' || stored === 'zh' ? stored
  : globalThis.navigator?.language?.startsWith('zh') === false ? 'en' : 'zh'
const dictionary = language === 'en' ? en : zh

/** 面板翻译函数：`lang` 返回当前语言，其余键填充占位符。 */
const t: T = (key, values) => key === 'lang' ? language
  : fill((dictionary as Record<string, string>)[key as DshSuperagentKey] ?? key, (values ?? {}) as Record<string, string>)

/** 独立版本没有 DSH 会话可打开；明确告知用户去哪里交互，而不是静默失败。 */
const openSession = async (): Promise<void> => { throw new Error(t('sessionUnavailable')) }

const root = document.getElementById('root')
if (!root) throw new Error('面板缺少 #root 挂载点')
createRoot(root).render(<App t={t} openSession={openSession} />)
