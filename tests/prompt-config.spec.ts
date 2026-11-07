import { expect, it } from 'vitest'
import { SKILL_NAME, defaultPrompts } from '../src/app/prompts.ts'
import { changedSections, lineDiff, partText, partWith, sectionText, skillNameFree, withOverride, withOverrides, withSection, withoutSkill }
  from '../src/client/prompt-config.ts'

it('按小节读写配置，并列出两个配置有差异的小节', () => {
  const config = withSection(defaultPrompts(), 'skill/testing', 'Run the tests.')
  expect(sectionText(config, 'skill/testing')).toBe('Run the tests.')
  expect([sectionText(config, 'runtime/shared'), sectionText(config, 'skill/github'), sectionText(config, 'skills')])
    .toEqual([undefined, undefined, undefined])
  expect(changedSections(withSection(config, 'scope', 'Mine'), withoutSkill(config, 'skill/testing'))).toEqual(['scope', 'skill/testing'])
  expect(['testing', 'github', 'Bad Name', 'ok-2'].map(name => skillNameFree(name, config, { skillName: SKILL_NAME.source,
    builtin: ['github'] }))).toEqual([false, false, false, true])
})

it('按行对两段文本做 diff，把长段未变更区间折叠到两端，并用另一段文本读取团队部件', () => {
  expect(lineDiff('a\nb\nc\nd\ne\nf\nold', 'a\nb\nc\nd\ne\nf\nnew')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'fold', count: 4 },
    { kind: 'same', text: 'f' }, { kind: 'ins', text: 'new' }, { kind: 'del', text: 'old' }])
  expect(lineDiff('a\nb', 'a\nx\nb')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'ins', text: 'x' }, { kind: 'same', text: 'b' }])
  expect(partWith({ name: 'scope', heading: '## Ticket scope' }, 'Theirs')).toBe('## Ticket scope\nTheirs')
  expect(partWith({ name: 'skill/testing' }, 'Theirs')).toBe('Theirs')
})

it('覆盖内置部件，在重新基于前保留其编辑时依据的内置文本，并丢弃与内置文本相同的覆盖', () => {
  const part = { key: 'runtime/shared', roles: ['orchestrator', 'worker'] as ('orchestrator' | 'worker')[], text: 'Built in.', base: 'now' }
  const edited = withOverride(defaultPrompts(), part, 'Ours.')
  expect(edited.overrides).toEqual({ 'runtime/shared': { text: 'Ours.', base: 'now' } })
  expect([sectionText(edited, 'part/runtime/shared'), partText(edited, part), partText(defaultPrompts(), part)]).toEqual(['Ours.', 'Ours.', 'Built in.'])
  // 从较早内置文本编辑而来的覆盖，在编辑期间保留那个 base，重新基于后则采用当前文本。
  const earlier = { ...defaultPrompts(), overrides: { 'runtime/shared': { text: 'Ours.', base: 'earlier' } } }
  expect(withOverride(earlier, part, 'Ours, edited.').overrides).toEqual({ 'runtime/shared': { text: 'Ours, edited.', base: 'earlier' } })
  const rebased = withOverride(earlier, part, 'Ours.', true)
  expect(rebased.overrides).toEqual({ 'runtime/shared': { text: 'Ours.', base: 'now' } })
  expect(changedSections(rebased, earlier)).toEqual(['part/runtime/shared'])
  // 编辑器把「无覆盖」表示为空 map，宿主据此将其存为无覆盖。
  expect(withOverride(edited, part, 'Built in.')).toEqual(withOverrides(defaultPrompts()))
  expect(withOverride(edited, part, undefined)).toEqual({ ...defaultPrompts(), overrides: {} })
})
