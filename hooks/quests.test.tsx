import { expect, test } from 'claude-code/testing'

const V = '/Users/andreacavagna/Documents/LLM-Wiki'
const TODO = `${V}/todo.md`

const SEED = [
  '# To-do',
  '- [ ] [Send David the Michelin doc](https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT) · Andrea x David, 17 Nov',
  '- [ ] [Finish the ranked publication PRD](https://app.notion.com/p/41a1237c10bf815bb20fcaab8f7457be) · 16 Nov',
  '- [ ] [Complete the publication gate](https://claude.ai/artifact/SoUyU5K75pAPVrU12sFLAF)',
  '- [ ] [Performance review: give feedback for a teammate](https://www.myworkday.com/tripadvisor/email-universal/inst/779$1/rel-task/2997$4086.htmld) · Workday',
  '- [ ] [Test the Streamlit page](https://example.com/streamlit) · not a Slack, Notion or artifact link',
  '- [ ] Plain line with no link',
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

function engine(on: any, files: Record<string, string>, opened: string[]) {
  on('command.register', () => ({ value: { command: 'wiki' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('theme.set', () => ({ value: { isDrawn: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv ?? []
    if (argv[0] === 'open') opened.push(argv[1] ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`only Slack, Notion, artifact and Workday to-dos show, open their link and tick in todo.md (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    const opened: string[] = []
    engine(on, files, opened)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Send David/ }))?.text).toContain('Send David')
    expect((await ui.find({ type: 'Text', text: /ranked publication PRD/ }))?.text).toContain('PRD')
    expect((await ui.find({ type: 'Text', text: /publication gate/ }))?.text).toContain('gate')
    expect((await ui.find({ type: 'Text', text: /Performance review/ }))?.text).toContain('teammate')
    expect(await ui.find({ type: 'Text', text: /Streamlit/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Plain line/ })).toBeUndefined()

    // the title links to where the to-do gets done
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map((l: any) => l.props?.href ?? l.href)).toContain('https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT')

    // one button moves it along: Start, then Done
    const firstNext = () => ui.findAll({ type: 'Button' }).then((bs: any[]) => bs.find(b => String(b.key).startsWith('next-'))?.key ?? '')
    const key = await firstNext()
    await ui.press({ key })
    expect(files[TODO]).toContain('- [/] [Send David the Michelin doc]')
    await ui.press({ key })
    expect(files[TODO]).toMatch(/- \[x\] \[Send David the Michelin doc\].*✅ \d{4}-\d{2}-\d{2}/)
    expect((await ui.find({ type: 'Button', text: /1 done/ }))?.text).toContain('1 done')
    await ui.unmount()
  })
}
