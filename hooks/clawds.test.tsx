import { expect, test } from 'claude-code/testing'

const V = '/Users/andreacavagna/Documents/LLM-Wiki'
const TODO = `${V}/todo.md`
const done = (n: number) =>
  Array.from({ length: n }, (_, i) => `- [x] [Done item ${i}](https://claude.ai/artifact/done${i}) ✅ 2026-11-0${(i % 9) + 1}`)

const PANE = {
  plugin: 'wiki-sidebar',
  component: 'Pane',
  requestId: 'wiki-sidebar',
  props: { title: 'To-do quests', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

function engine(on: any, files: Record<string, string>, toasts: string[]) {
  on('command.register', () => ({ value: { command: 'wiki' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: any, e: any) => {
    toasts.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('theme.set', () => ({ value: { isDrawn: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
}

test('the Clawd ladder shows one Clawd per level reached (desktop)', async ($, on) => {
  const files = { [TODO]: ['# To-do', ...done(20)].join('\n') }
  engine(on, files, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /3 OF 7/ }))?.text).toBe('3 OF 7')
  const svgs = await ui.findAll({ type: 'Svg' })
  const ladder: any = svgs.find((s: any) => /Hopper unlocked/.test(s.props?.alt ?? ''))
  expect(ladder?.props?.alt).toContain('Courier locked until level 4')
  expect(ladder?.props?.isInteractive).toBeUndefined()
  await ui.unmount()
})

test('crossing a level toasts the new Clawd (terminal)', async ($, on) => {
  const files = {
    [TODO]: ['# To-do', '- [ ] [Ping Hamza](https://tripadvisor.enterprise.slack.com/team/U1)', ...done(4)].join('\n'),
  }
  const toasts: string[] = []
  engine(on, files, toasts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const key = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.key).startsWith('done-'))?.key ?? ''
  await ui.press({ key })
  expect(toasts.some(t => t.includes('Level 2! New Clawd unlocked: Waver'))).toBe(true)
  await ui.unmount()
})
