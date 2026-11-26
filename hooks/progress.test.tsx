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
  test(`Start puts a to-do in progress and first, Done closes it, ✕ skips one and ↺ brings it back (${surface})`, async ($, on) => {
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

    const nexts = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key).startsWith('next-'))
    expect(nexts.length).toBe(2)
    const workdayKey = String(nexts[1]!.key)
    const workdayId = workdayKey.slice('next-'.length)
    await ui.press({ key: workdayKey })
    expect(files[TODO]).toContain('- [/] [Performance review')
    expect(await ui.find({ type: 'Text', text: /IN PROGRESS/ })).toBeDefined()
    // in progress moves first and its button now says Done
    const first = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.key).startsWith('next-'))
    expect(first?.key).toBe(workdayKey)
    expect(first?.text).toContain('Done')

    await ui.press({ key: workdayKey })
    expect(files[TODO]).toMatch(/- \[x\] \[Performance review.*✅ \d{4}-\d{2}-\d{2}/)

    const davidKey = String(nexts[0]!.key).slice('next-'.length)
    await ui.press({ key: `skip-${davidKey}` })
    expect(files[TODO]).toContain('- [-] [Send David')
    expect(await ui.find({ type: 'Button', key: `next-${davidKey}` })).toBeUndefined()
    expect((await ui.find({ type: 'Button', text: /1 done · 1 skipped/ }))?.key).toBe('toggle-done')
    await ui.press({ key: 'toggle-done' })
    await ui.press({ key: `unskip-${davidKey}` })
    expect(files[TODO]).toContain('- [ ] [Send David')
    expect(workdayId.length).toBeGreaterThan(0)
    await ui.unmount()
  })
}
