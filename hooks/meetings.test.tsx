import { expect, test } from 'claude-code/testing'

const V = '/Users/andreacavagna/Documents/LLM-Wiki'
const TODO = `${V}/todo.md`
const SEED = '# To-do\n- [ ] [Send David the Michelin doc](https://tripadvisor.enterprise.slack.com/team/UMZ4WFWBT) · 17 Nov'

const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString()
const ME = { email: 'me@example.com', self: true, responseStatus: 'accepted' }
const ROOM = { email: 'room@resource.calendar.google.com', resource: true, displayName: 'Room' }

const EVENTS = {
  events: [
    {
      id: 'past1',
      summary: 'Earlier sync',
      start: { dateTime: at(-120) },
      end: { dateTime: at(-90) },
      attendees: [ME, { email: 'a@example.com' }, { email: 'b@example.com' }],
      organizer: { email: 'a@example.com' },
      eventType: 'DEFAULT',
    },
    {
      id: 'oneone',
      summary: '1:1 Andrea / Ale',
      start: { dateTime: at(60) },
      end: { dateTime: at(90) },
      attendees: [ME, ROOM, { email: 'ale@example.com', displayName: 'Ale' }],
      organizer: { email: 'ale@example.com' },
      htmlLink: 'https://www.google.com/calendar/event?eid=oneone',
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      recurringEventId: 'series1',
      eventType: 'DEFAULT',
    },
    {
      id: 'training',
      summary: 'Tags back office training',
      description: '<p>Agenda: what changed</p><p>Open https://backoffice.example.com</p>',
      start: { dateTime: at(120) },
      end: { dateTime: at(150) },
      attendees: [{ ...ME, organizer: true }, { email: 'x@example.com' }, { email: 'y@example.com' }],
      organizer: { email: 'me@example.com', self: true },
      htmlLink: 'https://www.google.com/calendar/event?eid=training',
      eventType: 'DEFAULT',
    },
    {
      id: 'declined',
      summary: 'JE Daily',
      start: { dateTime: at(180) },
      end: { dateTime: at(195) },
      attendees: [{ ...ME, responseStatus: 'declined' }, { email: 'z@example.com' }],
      eventType: 'DEFAULT',
    },
    {
      id: 'lunch',
      summary: 'Pausa pranzo',
      start: { dateTime: at(200) },
      end: { dateTime: at(260) },
      eventType: 'OUT_OF_OFFICE',
    },
  ],
}

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

function engine(on: any, files: Record<string, string>, prompts: any[], calls: any[], store: Record<string, unknown> = {}) {
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
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
  on('tool.list', () => ({ value: [{ name: 'mcp__cal__list_events', description: 'Returns events', mcp: true }] }))
  on('mcp.call', (_: any, e: any) => {
    calls.push(e)
    return { value: { content: [{ type: 'text', text: JSON.stringify(EVENTS) }], isError: false } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: any, e: any) => {
    prompts.push(e)
    return { text: e.text }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`to-dos open and meetings folded by default; both sections toggle (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    const prompts: any[] = []
    const calls: any[] = []
    engine(on, files, prompts, calls)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Send David/ }))?.text).toContain('Send David')
    expect(await ui.find({ type: 'Text', text: /1:1 Andrea/ })).toBeUndefined()
    // the folded header still counts what is left today: the 1:1 and the training
    expect((await ui.find({ type: 'Button', text: /MEETINGS TODAY · 2/ }))?.text).toContain('▸')

    await ui.press({ key: 'toggle-todos' })
    expect(await ui.find({ type: 'Text', text: /Send David/ })).toBeUndefined()

    await ui.press({ key: 'toggle-meetings' })
    expect((await ui.find({ type: 'Text', text: /1:1 Andrea/ }))?.text).toContain('Ale')
    expect((await ui.find({ type: 'Text', text: /Tags back office training/ }))?.text).toContain('training')
    expect(await ui.find({ type: 'Text', text: /JE Daily/ })).toBeUndefined() // declined
    expect(await ui.find({ type: 'Text', text: /Pausa pranzo/ })).toBeUndefined() // out of office
    expect(await ui.find({ type: 'Text', text: /Earlier sync/ })).toBeUndefined() // past, folded
    expect((await ui.find({ type: 'Text', text: /1:1 with Ale/ }))?.text).toContain('bring updates')
    expect((await ui.find({ type: 'Text', text: /You host/ }))?.text).toContain('agenda')
    expect(calls[0]?.server).toBe('cal')
    expect(calls[0]?.tool).toBe('list_events')

    await ui.press({ key: 'toggle-past-meetings' })
    expect((await ui.find({ type: 'Text', text: /Earlier sync/ }))?.text).toContain('Earlier')
    await ui.unmount()
  })

  test(`Prepare sends the meeting, its call to action and the prep note path; a note on disk shows Open prep (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [TODO]: SEED }
    const prompts: any[] = []
    const calls: any[] = []
    const store: Record<string, unknown> = {}
    engine(on, files, prompts, calls, store)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'toggle-meetings' })
    await ui.press({ key: 'mnext-training' })
    expect(prompts.length).toBe(1)
    const text: string = prompts[0].text
    expect(text).toContain('Meeting: Tags back office training')
    expect(text).toContain('my role: host')
    expect(text).toContain('Agenda: what changed')
    expect(text).toMatch(/meeting-prep\/\d{4}-\d{2}-\d{2}-tags-back-office-training\.md/)
    expect(text).toContain('Read-only on Notion, Jira, Slack and Gmail')

    // the prep note appears; at the end of the turn the card switches to Open prep
    const path = text.match(/meeting-prep\/[\w-]+\.md/)?.[0] ?? ''
    files[`${V}/${path}`] = '# prep'
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' })
    expect((await ui.find({ type: 'Button', key: 'prep-open-training' }))?.text).toContain('Prep')
    expect(calls.length).toBe(1) // the calendar is not re-read within 15 minutes

    // prep done, the same button now closes the meeting for XP; ✕ skips another; both can be undone
    expect((await ui.find({ type: 'Button', key: 'mnext-training' }))?.text).toContain('Done')
    await ui.press({ key: 'mnext-training' })
    expect(await ui.find({ type: 'Text', text: /Tags back office training/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', text: /MEETINGS TODAY · 1/ }))?.text).toContain('1')
    await ui.press({ key: 'mskip-oneone' })
    expect((await ui.find({ type: 'Button', text: /1 done · 1 skipped/ }))?.key).toBe('toggle-handled-meetings')
    const stored: any = store.meetingLog
    expect(Object.values(stored).map((x: any) => x.status).sort()).toEqual(['done', 'skipped'])
    await ui.press({ key: 'toggle-handled-meetings' })
    await ui.press({ key: 'unmark-oneone' })
    expect((await ui.find({ type: 'Text', text: /1:1 Andrea/ }))?.text).toContain('Ale')
    await ui.unmount()
  })
}
