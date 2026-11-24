import { expect, test } from 'claude-code/testing'

const V = '/Users/andreacavagna/Documents/LLM-Wiki'
const TODO = `${V}/todo.md`
const SEED = [
  '# To-do',
  '- [ ] [Send David the Michelin doc](https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT) · 17 Nov',
  '- [ ] [Performance review: give feedback for a teammate](https://www.myworkday.com/tripadvisor/x) · Workday',
].join('\n')

const PANE = {
  plugin: 'wiki-sidebar',
  component: 'Pane',
  requestId: 'wiki-sidebar',
  props: { title: 'To-do quests', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Start marks a to-do in progress, it moves first, and ticking it closes it (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    on('command.register', () => ({ value: { command: 'wiki' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }))
    on('theme.set', () => ({ value: { isDrawn: true } }))
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
    on('fs.read', (_: any, e: any) => ({ value: files[e.path] ?? '' }))
    on('fs.write', (_: any, e: any) => {
      files[e.path] = e.text
      return { value: undefined }
    })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    const starts = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key).startsWith('start-'))
    await ui.press({ key: starts[1]!.key })
    await new Promise(r => setTimeout(r, 20))
    expect(files[TODO]).toContain('- [/] [Performance review')
    expect(await ui.find({ type: 'Text', text: /IN PROGRESS/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', text: /Continue/ }))?.text).toContain('Continue')
    const first = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.key).startsWith('start-'))
    const workdayId = String(first?.key).slice('start-'.length)

    await ui.press({ key: `progress-${workdayId}` })
    expect(files[TODO]).toContain('- [ ] [Performance review')
    await ui.press({ key: `progress-${workdayId}` })
    expect(files[TODO]).toContain('- [/] [Performance review')

    await ui.press({ key: `done-${workdayId}` })
    expect(files[TODO]).toMatch(/- \[x\] \[Performance review.*✅ \d{4}-\d{2}-\d{2}/)
    await ui.unmount()
  })
}
