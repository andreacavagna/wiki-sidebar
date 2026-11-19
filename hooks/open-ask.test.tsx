import { expect, test } from 'claude-code/testing'

test('"open the wiki sidebar" in plain words opens the pane; other prompts do not', async ($, on) => {
  const opens: string[] = []
  const seen: { text: string; context?: readonly string[] }[] = []
  on('command.register', () => ({ value: { command: 'wiki' } }))
  on('ui.open', (_: any, e: any) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('theme.set', () => ({ value: { isDrawn: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('prompt.submit', (_: any, e: any) => {
    seen.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const afterStart = opens.length

  await $.prompt.submit({ text: 'open the wiki sidebar', asUser: true })
  expect(opens.length).toBe(afterStart + 1)
  expect(seen.at(-1)?.context?.join(' ')).toContain('opened the to-do quests pane')

  await $.prompt.submit({ text: 'apri la sidebar per favore', asUser: true })
  expect(opens.length).toBe(afterStart + 2)

  await $.prompt.submit({ text: 'rework the ranked publication PRD argument', asUser: true })
  expect(opens.length).toBe(afterStart + 2)
  expect(seen.at(-1)?.context).toBeUndefined()
})
