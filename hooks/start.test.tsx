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

function engine(on: any, files: Record<string, string>, prompts: any[], calls: any[], copies: any[], toasts: string[], answer: (e: any) => any) {
  on('command.register', () => ({ value: { command: 'wiki' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_: any, e: any) => {
    copies.push(e)
    return { value: { isCopied: true } }
  })
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
  on('tool.call', (_: any, e: any) => {
    calls.push(e)
    return answer(e)
  })
}

async function pressStart($: any, surface: 'terminal' | 'desktop') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'toggle-done' })
  const starts = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key).startsWith('next-'))
  expect(starts.length).toBe(1) // done items have no Start
  await ui.press({ key: starts[0]?.key ?? '' })
  return ui
}

const PROMPT_HEAD =
  'Start working on: Send David the Michelin doc (https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT) · Andrea x David, 17 Nov'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Start opens a new chat with the to-do's prompt; this chat gets nothing (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    const prompts: any[] = [], calls: any[] = [], copies: any[] = [], toasts: string[] = []
    engine(on, files, prompts, calls, copies, toasts, () => ({ result: 'started', text: 'Session started' }))
    const ui = await pressStart($, surface)

    expect(prompts.length).toBe(0)
    expect(calls.length).toBe(1)
    expect(calls[0].tool).toBe('mcp__ccd_session__start_session')
    expect(calls[0].initiation).toBe('user_asked')
    expect(calls[0].context).toBe('fresh')
    expect(calls[0].use_worktree).toBe(false)
    expect(calls[0].prompt).toContain(PROMPT_HEAD)
    expect(calls[0].prompt).toContain('drafts only')
    expect(calls[0].background.length).toBeGreaterThan(80)
    expect(copies.length).toBe(0)
    expect(toasts.some(t => t.includes('new chat'))).toBe(true)
    expect(files[TODO]).toBe(SEED.replace('- [ ] [Send David', '- [/] [Send David')) // marked in progress, never done
    await ui.unmount()
  })

  test(`Start falls back to the clipboard when the app refuses a new chat, never to this chat (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    const prompts: any[] = [], calls: any[] = [], copies: any[] = [], toasts: string[] = []
    engine(on, files, prompts, calls, copies, toasts, () => ({ deny: 'refused' }))
    const ui = await pressStart($, surface)

    expect(prompts.length).toBe(0)
    expect(copies.length).toBe(1)
    expect(copies[0].text).toContain(PROMPT_HEAD)
    expect(toasts.some(t => t.includes('prompt copied'))).toBe(true)
    expect(files[TODO]).toBe(SEED.replace('- [ ] [Send David', '- [/] [Send David'))
    await ui.unmount()
  })
}
