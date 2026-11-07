// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Modal, SegmentedTabs } from '../src/client/controls.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('不导入 DSH client 的运行时包，只导入 React 与类型声明', () => {
  const dir = join(process.cwd(), 'src/client')
  for (const name of readdirSync(dir)) {
    const source = readFileSync(join(dir, name), 'utf8')
    for (const match of source.matchAll(/^import (type )?[^'"]*from '(@deepseek-ai\/[^']+)'/gm)) expect({ name, from: match[2], typeOnly: !!match[1] }).toMatchObject({ typeOnly: true })
    expect(source).not.toContain('dsh-client-ui-primitives\'')
  }
})

it('面板的每个模块只被不反向导入它的模块导入', () => {
  const dir = join(process.cwd(), 'src/client')
  const graph = new Map(readdirSync(dir).filter(name => /\.tsx?$/.test(name)).map(name => [name, [...readFileSync(join(dir, name), 'utf8')
    .matchAll(/^import [^'"]*from '\.\/([\w-]+\.tsx?)'/gm)].map(match => match[1]!)]))
  const done = new Set<string>(), cycles: string[] = []
  const visit = (name: string, path: string[]): void => {
    if (path.includes(name)) { cycles.push([...path.slice(path.indexOf(name)), name].join(' → ')); return }
    if (done.has(name)) return
    for (const next of graph.get(name) ?? []) visit(next, [...path, name])
    done.add(name)
  }
  for (const name of graph.keys()) visit(name, [])
  expect(cycles).toEqual([])
})

it('在面板可打包的模块中描述管理 API，该模块只导入类型', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api.ts'), 'utf8')
  expect([...source.matchAll(/^import (type )?/gm)].every(match => match[1])).toBe(true)
})

it('按 Escape 关闭对话框并把焦点还给打开者', async () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return <><button type="button" onClick={() => setOpen(true)}>open</button><Modal open={open} onClose={() => setOpen(false)} title="Title" closeLabel="Close">body</Modal></>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  const opener = container.querySelector('button')!
  opener.focus()
  await act(async () => { opener.click() })
  expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
  act(() => { root.unmount() })
})

it('父组件重新渲染时焦点保持在对话框内，Tab 与 Shift+Tab 在其中循环', async () => {
  let rerender = () => {}
  function Harness() {
    const [, setCount] = useState(0)
    rerender = () => setCount(count => count + 1)
    // 每次渲染传入一个新的内联 onClose（轮询的父组件正是如此），以验证 effect 不会重置焦点。
    return <Modal open onClose={() => {}} title="Title" closeLabel="Close" footer={<button type="button">last</button>}><input aria-label="first field" /></Modal>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  const field = document.querySelector<HTMLInputElement>('[aria-label="first field"]')!
  field.focus()
  await act(async () => { rerender() })
  expect(document.activeElement).toBe(field)
  const [close, , last] = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] input')]
  const tab = (shiftKey = false) => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true })) })
  last!.focus(); await tab()
  expect(document.activeElement).toBe(close)
  await tab(true)
  expect(document.activeElement).toBe(last)
  act(() => { root.unmount() })
})

it('用方向键移动标签选择，并在两端循环', async () => {
  const seen: string[] = []
  function Harness() {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
    return <SegmentedTabs label="pages" value={value} onChange={next => { seen.push(next); setValue(next) }} items={(['a', 'b', 'c'] as const).map(item => ({ value: item, label: item, id: `t-${item}`, panelId: 'p' }))} />
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  const list = container.querySelector('[role="tablist"]')!
  await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
  expect(seen).toEqual(['c', 'a'])
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('a')
  act(() => { root.unmount() })
})
