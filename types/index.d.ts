export type TodoKind = 'slack' | 'notion' | 'artifact' | 'workday'

export type TodoItem = {
  id: string
  text: string
  url: string
  kind: TodoKind
  context: string
  isDone: boolean
  /** `- [/]`: started, not done yet */
  isStarted: boolean
  /** YYYY-MM-DD from the line's ✅ mark, '' when unknown */
  doneDate: string
}

export type Snapshot = {
  root: string
  todos: TodoItem[]
  loadedAt: number
  error?: string
}

/** What kind of meeting it is for Andrea, which sets the call to action. */
export type MeetingRole = 'host' | 'one-on-one' | 'daily' | 'broadcast' | 'meeting'

export type MeetingItem = {
  id: string
  title: string
  /** ISO start and end with offset, as the calendar returns them */
  start: string
  end: string
  /** HH:MM in Europe/Rome */
  startLabel: string
  endLabel: string
  role: MeetingRole
  /** One line: what to prepare */
  cta: string
  organizer: string
  isOrganizer: boolean
  /** Other people invited (rooms and Andrea left out), display name or email */
  attendees: string[]
  description: string
  isRecurring: boolean
  /** Google Calendar event page */
  link: string
  /** Meet or Teams link, '' when none */
  callUrl: string
  /** Vault-relative path of the prep note: meeting-prep/YYYY-MM-DD-slug.md */
  prepPath: string
  hasPrep: boolean
}

export type MeetingsSnapshot = {
  /** YYYY-MM-DD in Europe/Rome */
  day: string
  meetings: MeetingItem[]
  loadedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'wiki-sidebar': {
      snapshot: Shaped<Snapshot | null>
      busy: boolean
      showDone: boolean
      meetings: Shaped<MeetingsSnapshot | null>
      meetingsBusy: boolean
      todosOpen: boolean
      meetingsOpen: boolean
      showPastMeetings: boolean
    }
  }
}
