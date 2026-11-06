import { expect, it } from 'vitest'
import { SKILL_NAME, defaultPrompts } from '../src/app/prompts.ts'
import { changedSections, lineDiff, partText, partWith, sectionText, skillNameFree, withOverride, withOverrides, withSection, withoutSkill }
  from '../src/client/prompt-config.ts'

it('reads and writes a configuration by section, and lists the sections two configurations differ in', () => {
  const config = withSection(defaultPrompts(), 'skill/testing', 'Run the tests.')
  expect(sectionText(config, 'skill/testing')).toBe('Run the tests.')
  expect([sectionText(config, 'runtime/shared'), sectionText(config, 'skill/github'), sectionText(config, 'skills')])
    .toEqual([undefined, undefined, undefined])
  expect(changedSections(withSection(config, 'scope', 'Mine'), withoutSkill(config, 'skill/testing'))).toEqual(['scope', 'skill/testing'])
  expect(['testing', 'github', 'Bad Name', 'ok-2'].map(name => skillNameFree(name, config, { skillName: SKILL_NAME.source,
    builtin: ['github'] }))).toEqual([false, false, false, true])
})

it('diffs two texts by line, folding a long unchanged run to its ends, and reads a team part with another text', () => {
  expect(lineDiff('a\nb\nc\nd\ne\nf\nold', 'a\nb\nc\nd\ne\nf\nnew')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'fold', count: 4 },
    { kind: 'same', text: 'f' }, { kind: 'ins', text: 'new' }, { kind: 'del', text: 'old' }])
  expect(lineDiff('a\nb', 'a\nx\nb')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'ins', text: 'x' }, { kind: 'same', text: 'b' }])
  expect(partWith({ name: 'scope', heading: '## Ticket scope' }, 'Theirs')).toBe('## Ticket scope\nTheirs')
  expect(partWith({ name: 'skill/testing' }, 'Theirs')).toBe('Theirs')
})

it('overrides a built-in part, keeping the built-in text it was edited from until re-based, and drops an override equal to the built-in text', () => {
  const part = { key: 'runtime/shared', roles: ['orchestrator', 'worker'] as ('orchestrator' | 'worker')[], text: 'Built in.', base: 'now' }
  const edited = withOverride(defaultPrompts(), part, 'Ours.')
  expect(edited.overrides).toEqual({ 'runtime/shared': { text: 'Ours.', base: 'now' } })
  expect([sectionText(edited, 'part/runtime/shared'), partText(edited, part), partText(defaultPrompts(), part)]).toEqual(['Ours.', 'Ours.', 'Built in.'])
  // 基于更早内置文本编辑的覆盖在编辑期间保留该 base，重新基线时改用当前的。
  const earlier = { ...defaultPrompts(), overrides: { 'runtime/shared': { text: 'Ours.', base: 'earlier' } } }
  expect(withOverride(earlier, part, 'Ours, edited.').overrides).toEqual({ 'runtime/shared': { text: 'Ours, edited.', base: 'earlier' } })
  const rebased = withOverride(earlier, part, 'Ours.', true)
  expect(rebased.overrides).toEqual({ 'runtime/shared': { text: 'Ours.', base: 'now' } })
  expect(changedSections(rebased, earlier)).toEqual(['part/runtime/shared'])
  // 编辑器以空 map 表示没有覆盖，宿主将其存为无覆盖。
  expect(withOverride(edited, part, 'Built in.')).toEqual(withOverrides(defaultPrompts()))
  expect(withOverride(edited, part, undefined)).toEqual({ ...defaultPrompts(), overrides: {} })
})
