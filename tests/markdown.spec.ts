import { expect, it } from 'vitest'
import { inlines, linkify, markdownBlocks } from '../src/client/markdown.ts'

it('读取标题、段落与列表，列表在空行或另一类别的条目处结束', () => {
  expect(markdownBlocks('# Plan\nFirst line\n- a\n- b\n\n- c\n1. d\n\n')).toEqual([{ kind: 'heading', text: 'Plan' },
    { kind: 'paragraph', text: 'First line' }, { kind: 'list', ordered: false, items: ['a', 'b'] }, { kind: 'list', ordered: false,
      items: ['c'] }, { kind: 'list', ordered: true, items: ['d'] }])
})

it('读取粗体、行内代码与链接，裸地址按其主机与短路径展示', () => {
  const log = 'https://ci.example.com/runs/123456789012345678901234/log'
  expect(inlines(`**Done**: \`npm test\` in [the PR](https://github.com/acme/widgets/pull/42), log at ${log}`))
    .toEqual([{ kind: 'bold', text: 'Done' }, { kind: 'text', text: ': ' }, { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' in ' }, { kind: 'link', text: 'the PR', url: 'https://github.com/acme/widgets/pull/42' },
      { kind: 'text', text: ', log at ' },
      { kind: 'link', text: 'ci.example.com/runs/123456789012345678…', url: log }])
  expect(linkify('<b>**not bold**</b>')).toEqual([{ kind: 'text', text: '<b>**not bold**</b>' }])
})

it('指向非网址的链接保持为文本，裸地址后的标点不并入链接', () => {
  for (const text of ['[x](javascript:alert(1))', '[x](data:text/html,<b>hi</b>)']) {
    expect(inlines(text).every(part => part.kind === 'text')).toBe(true)
    expect(inlines(text).map(part => part.text).join('')).toBe(text)
  }
  expect(linkify('See https://example.com/a. Then (https://example.com/b) and https://example.com/c?')).toEqual([
    { kind: 'text', text: 'See ' }, { kind: 'link', text: 'example.com/a', url: 'https://example.com/a' }, { kind: 'text', text: '. Then (' },
    { kind: 'link', text: 'example.com/b', url: 'https://example.com/b' }, { kind: 'text', text: ') and ' },
    { kind: 'link', text: 'example.com/c', url: 'https://example.com/c' }, { kind: 'text', text: '?' }])
})
