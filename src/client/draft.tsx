/**
 * 设置草稿的乐观状态管理，带 sessionStorage 持久化，以及针对并发保存的三方重新定基（rebase）。
 */
import { useEffect, useLayoutEffect, useReducer, useRef, type FormEvent } from 'react'
import { ApiError } from './api.ts'
import { usePanel } from './provider.tsx'
import { errorText, type T } from './text.ts'
import { Button } from './controls.tsx'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const LIST_KEYS = ['id', 'chatId']
const named = (list: unknown[], field: string) =>
  list.every(item => isRecord(item) && typeof item[field] === 'string') && new Set(list.map(item => (item as Record<string,
    unknown>)[field])).size === list.length
/**
 * 在 `base`、本地 `mine` 与远端 `theirs` 之间做三方合并。
 * 对象按键合并，带键的记录数组（`id` 或 `chatId`）按元素合并：一方删除的键或元素，若另一方未改动则随之删除；
 * 删除与修改相抵时保留 `mine`，并记入 `conflicts`。
 */
export function merge3(base: unknown, mine: unknown, theirs: unknown, conflicts: string[][] = [], path: string[] = []): unknown {
  if (same(mine, base) || same(mine, theirs)) return theirs
  if (same(theirs, base)) return mine
  if (Array.isArray(mine) && Array.isArray(theirs) && (base === undefined || Array.isArray(base))) {
    const lists = [base ?? [], mine, theirs]
    const field = LIST_KEYS.find(name => lists.every(list => named(list, name)))
    if (field) return mergeList(lists, field, conflicts, path)
  }
  if (!isRecord(base) || !isRecord(mine) || !isRecord(theirs)) { conflicts.push(path); return mine }
  const merged: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const value = merge3(base[key], mine[key], theirs[key], conflicts, [...path, key])
    if (value !== undefined) merged[key] = value
  }
  return merged
}
function mergeList([base, mine, theirs]: unknown[][], field: string, conflicts: string[][], path: string[]): unknown[] {
  const name = (item: unknown) => String((item as Record<string, unknown>)[field])
  const [before, ours, others] = [base!, mine!, theirs!].map(list => new Map(list.map(item => [name(item), item])))
  const order = theirs!.map(name)
  mine!.forEach((item, index) => {
    if (order.includes(name(item))) return
    const previous = mine!.slice(0, index).map(name).reverse().find(key => order.includes(key))
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, name(item))
  })
  return order.flatMap(key => {
    const value = merge3(before!.get(key), ours!.get(key), others!.get(key), conflicts, [...path, key])
    return value === undefined ? [] : [value]
  })
}

interface Stored<V, M> { base: V; value: V; revision: number; meta?: M }
function read<V, M>(key: string | undefined): Stored<V, M> | undefined {
  if (!key) return undefined
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Stored<V, M>> | null
    // 丢弃没有 `base` 的草稿（由旧版本写入），因为它们无法参与三方合并。
    return stored && 'base' in stored && 'value' in stored && Number.isInteger(stored.revision) ? stored as Stored<V, M> : undefined
  } catch (error) { void error /* 不可读的草稿直接丢弃；已保存的值仍是权威数据。 */; return undefined }
}

export type DraftNotice = { kind: 'restored' | 'rebasing' } | { kind: 'merged'; revision: number }
  | { kind: 'conflict'; revision: number; paths: string[][] } | { kind: 'invalid'; fields: string[] }
  | { kind: 'failed' | 'unstored'; error: string }
const FAILURES: ReadonlySet<DraftNotice['kind']> = new Set(['conflict', 'invalid', 'failed', 'unstored'])
export interface DraftState<V, M> {
  phase: 'clean' | 'editing' | 'saving' | 'awaitingRevision'
  draft?: Stored<V, M> | undefined
  sent?: { value: V; revision: number; restarting: boolean } | undefined
  seen?: number | undefined
  notice?: DraftNotice | undefined
}
export type DraftAction<V, M> = { type: 'edit'; value: V; meta: M | undefined; saved: V; revision: number | undefined }
  | { type: 'discard' | 'submit' } | { type: 'saved'; revision: number; restarting: boolean } | { type: 'refused'; notice: DraftNotice }
  | { type: 'revisionArrived'; saved: V; revision: number }
/**
 * 设置草稿的状态机。
 * 提交后的值停留在 `awaitingRevision`，直到轮询到的版本追上来；活跃编辑通过 `merge3` 重新定基到更新的远端版本上。
 */
export function draftReducer<V, M>(state: DraftState<V, M>, action: DraftAction<V, M>): DraftState<V, M> {
  const { phase, draft, seen } = state
  switch (action.type) {
    case 'edit': {
      if (phase === 'saving' || phase === 'awaitingRevision') return state
      if (same(action.value, action.saved)) return { phase: 'clean', seen }
      const notice = state.notice && FAILURES.has(state.notice.kind) ? state.notice : undefined
      return { phase: 'editing', seen, notice, draft: { base: draft?.base ?? action.saved, value: action.value,
        revision: draft?.revision ?? action.revision ?? 0, ...action.meta === undefined ? {} : { meta: action.meta } } }
    }
    case 'discard': return phase === 'saving' || phase === 'awaitingRevision' ? state : { phase: 'clean', seen }
    case 'submit': return phase === 'editing' ? { ...state, phase: 'saving' } : state
    case 'saved': return phase === 'saving' && draft ? { phase: 'awaitingRevision', seen,
      sent: { value: draft.value, revision: action.revision, restarting: action.restarting } } : state
    case 'refused': return { ...state, phase: phase === 'saving' ? 'editing' : phase, notice: action.notice }
    case 'revisionArrived': {
      // 保存进行中时推迟重新定基；保存完成时要么前进到 `awaitingRevision`，要么重载并合并。
      if (phase === 'saving') return state
      const { revision, saved } = action
      if (state.sent) return revision >= state.sent.revision ? { phase: 'clean', seen: revision } : { ...state, seen: revision }
      if (!draft || draft.revision === revision) return { ...state, seen: revision }
      const paths: string[][] = []
      const value = merge3(draft.base, draft.value, saved, paths) as V
      if (same(value, saved)) return { phase: 'clean', seen: revision }
      return { phase: 'editing', seen: revision, draft: { ...draft, base: saved, value, revision },
        notice: paths.length ? { kind: 'conflict', revision, paths } : { kind: 'merged', revision } }
    }
  }
}
export interface DraftWords {
  merged?: (revision: number) => string
  conflict?: (revision: number, paths: string[][]) => string
  editing?: string
}
export function saveBarText(t: T, { phase, sent, notice }: DraftState<unknown, unknown>,
  words: DraftWords = {}): { error?: string; status: string } {
  switch (notice?.kind) {
    case 'conflict': return { error: words.conflict?.(notice.revision, notice.paths) ?? t('saveConflict'), status: '' }
    case 'invalid': return { error: t('invalidSettings', { fields: notice.fields.join(t('listSeparator')) }), status: '' }
    case 'failed': return { error: notice.error, status: '' }
    case 'unstored': return { error: t('draftFailed', { error: notice.error }), status: '' }
    case 'merged': return { status: words.merged?.(notice.revision) ?? t('saveMerged') }
    case 'rebasing': return { status: t('saveRebasing') }
  }
  if (phase === 'awaitingRevision') return { status: t(sent?.restarting ? 'savedRestarting' : 'saved') }
  return { status: phase === 'clean' ? t('saved') : words.editing ?? t(notice?.kind === 'restored' ? 'draftRestored' : 'draftKept') }
}

export interface DraftOptions<V> {
  key?: string
  saved: V
  revision: number | undefined
  save: (value: V, revision: number, base: V) => Promise<{ revision: number; restarting?: boolean }>
  reload: () => Promise<unknown>
}
/** 管理一份设置草稿：未保存的编辑持久化在 `sessionStorage`，更新的服务器版本到达时对其重新定基。 */
export function useDraft<V, M = undefined>({ key, saved, revision, save, reload }: DraftOptions<V>) {
  const { restart } = usePanel()
  const [state, dispatch] = useReducer(draftReducer<V, M>, undefined, () => {
    const stored = read<V, M>(key)
    const initial: DraftState<V, M> = stored ? { phase: 'editing', draft: stored, notice: { kind: 'restored' } } : { phase: 'clean' }
    return revision === undefined ? initial : draftReducer(initial, { type: 'revisionArrived', saved, revision })
  })
  if (state.phase !== 'saving' && revision !== undefined && revision !== state.seen) dispatch({ type: 'revisionArrived', saved, revision })
  useEffect(() => {
    if (!key) return
    try { if (state.draft) sessionStorage.setItem(key, JSON.stringify(state.draft)); else sessionStorage.removeItem(key) }
    catch (failure) { dispatch({ type: 'refused', notice: { kind: 'unstored', error: errorText(failure) } }) }
  }, [key, state.draft])
  const failed = (failure: unknown) => dispatch({ type: 'refused', notice: { kind: 'failed', error: errorText(failure) } })
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const { draft } = state
    if (state.phase !== 'editing' || !draft) return
    dispatch({ type: 'submit' })
    let result: { revision: number; restarting?: boolean }
    try {
      result = await save(draft.value, draft.revision, draft.base)
    } catch (failure) {
      const fields = failure instanceof ApiError ? failure.issues.map(issue => issue.path) : []
      if (failure instanceof ApiError && failure.status === 409) {
        await reload().then(() => dispatch({ type: 'refused', notice: { kind: 'rebasing' } }), failed)
      } else dispatch({ type: 'refused', notice: fields.length ? { kind: 'invalid', fields } : { kind: 'failed',
        error: errorText(failure) } })
      return
    }
    dispatch({ type: 'saved', revision: result.revision, restarting: !!result.restarting })
    if (result.restarting) restart(); else await reload().catch(failed)
  }
  return { state, value: state.sent?.value ?? state.draft?.value ?? saved, meta: state.draft?.meta,
    revision: state.draft?.revision ?? revision ?? 0, dirty: state.draft !== undefined,
    busy: state.phase === 'saving' || state.phase === 'awaitingRevision', submit,
    edit: (value: V, meta?: M) => dispatch({ type: 'edit', value, meta, saved, revision }), discard: () => dispatch({ type: 'discard' }) }
}

/** 设置块的吸顶保存/放弃操作条；隐藏时把焦点交还给父块，避免键盘导航被重置。 */
export function SaveBar({ state, dirty, busy, words, status, onDiscard, onSave }: {
  state: DraftState<unknown, unknown>; dirty: boolean; busy: boolean; words?: DraftWords; status?: string | undefined
  onDiscard: () => void; onSave?: () => void
}) {
  const { t } = usePanel()
  const line = saveBarText(t, state, words)
  const shown = dirty || busy || !!line.error
  const bar = useRef<HTMLDivElement>(null)
  const block = useRef<HTMLElement | null>(null)
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (shown) { block.current = bar.current?.parentElement ?? null; return }
    const lost = !document.activeElement || document.activeElement === document.body
    if (focused.current && block.current && lost) { block.current.tabIndex = -1; block.current.focus({ preventScroll: true }) }
    focused.current = false
  }, [shown])
  if (!shown) return null
  const leave = (next: Element | null) => { if (next && !bar.current?.contains(next)) focused.current = false }
  return <div ref={bar} className="dt-savebar" onFocus={() => { focused.current = true }}
    onBlur={event => leave(event.relatedTarget as Element | null)}>
    {line.error ? <p className="dt-error dt-clamp" role="alert">{line.error}</p>
      : <p className="dt-hint" aria-live="polite">{status ?? line.status}</p>}
    <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={onDiscard}>{t('discard')}</Button>
    <Button variant="primary" size="sm" disabled={!dirty || busy} {...onSave ? { onClick: onSave } : { type: 'submit' as const }}>
      {t('save')}
    </Button>
  </div>
}
