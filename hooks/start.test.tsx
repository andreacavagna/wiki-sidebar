import { expect, test } from 'claude-code/testing'

const V = '/Users/andreacavagna/Documents/LLM-Wiki'
const TODO = `${V}/todo.md`

const SEED = [
  '# To-do',
  '- [ ] [Send David the Michelin doc](https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT) · Andrea x David, 17 Nov',
  '- [x] [Old artifact](https://claude.ai/artifact/abc) ✅ 2026-11-18',
].join('\n')

const PANE = {
  plugin: 'wiki-sidebar',
  component: 'Pane',
  requestId: 'wiki-sidebar',
  props: {
    title: 'To-do quests',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Start on an open to-do sends its text, link and source to the chat; done ones have none (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    const prompts: any[] = []
    on('command.register', () => ({ value: { command: 'wiki' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }))
    on('theme.set', () => ({ value: { isDrawn: true } }))
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
    on('fs.read', (_: any, e: any) => ({ value: files[e.path] ?? '' }))
    on('fs.write', (_: any, e: any) => {
      files[e.path] = e.text
      return { value: undefined }
    })
    on('prompt.submit', (_: any, e: any) => {
      prompts.push(e)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'toggle-done' })
    const starts = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key).startsWith('start-'))
    expect(starts.length).toBe(1)

    await ui.press({ key: starts[0]?.key ?? '' })
    expect(prompts.length).toBe(1)
    expect(prompts[0].text).toContain(
      'Start working on: Send David the Michelin doc (https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT) · Andrea x David, 17 Nov',
    )
    expect(prompts[0].text).toContain('drafts only')
    expect(files[TODO]).toBe(SEED.replace('- [ ] [Send David', '- [/] [Send David')) // Start marks it in progress, never done
    await ui.unmount()
  })
}
