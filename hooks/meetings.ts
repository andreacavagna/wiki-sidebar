// Today's meetings from Google Calendar: fetch, filter, classify, and the prep prompt.
import type { MeetingItem, MeetingRole } from '../types'

export const TZ = 'Europe/Rome'
export const PREP_DIR = 'meeting-prep'
// The claude.ai Google Calendar connector in Andrea's account; used when the tool list doesn't name one.
const FALLBACK_SERVER = 'a6216c81-faaf-4e99-8ad2-d0310fad30e1'

/** YYYY-MM-DD of `d` in Europe/Rome. */
export function dayIn(d = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/** HH:MM of an ISO timestamp in Europe/Rome. */
export function hhmm(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
  } catch {
    return iso.slice(11, 16)
  }
}

export function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '') || 'meeting'
}

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|ul|ol|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/_{5,}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

const nameOf = (a: any): string => (a?.displayName as string) || String(a?.email ?? '').split('@')[0] || '?'

function roleOf(ev: any, people: any[], isOrganizer: boolean): MeetingRole {
  const title = String(ev.summary ?? '')
  if (people.length === 1 || /\b1:1\b|one[- ]on[- ]one/i.test(title)) return 'one-on-one'
  if (isOrganizer && people.length >= 2) return 'host'
  if (/\bdaily\b|stand-?up/i.test(title)) return 'daily'
  if (people.length >= 15 || ev.guestPermissions?.guestsCanSeeGuests === false || /webinar|office hours|all[- ]hands|town ?hall/i.test(title)) {
    return 'broadcast'
  }
  return 'meeting'
}

function ctaOf(role: MeetingRole, people: any[]): string {
  switch (role) {
    case 'host':
      return 'You host: agenda, demo and links ready'
    case 'one-on-one':
      return `1:1 with ${people[0] ? nameOf(people[0]) : 'them'}: bring updates, asks, feedback`
    case 'daily':
      return 'Daily: one-line status and blockers'
    case 'broadcast':
      return 'Listen-in: skim the agenda, note your questions'
    default:
      return 'Set your goal; check last notes and open points'
  }
}

/** The calendar's events JSON → the meetings worth showing (no declined, all-day, out-of-office or focus blocks). */
export function parseEvents(json: any, day: string): MeetingItem[] {
  const events: any[] = Array.isArray(json?.events) ? json.events : []
  const out: MeetingItem[] = []
  for (const ev of events) {
    if (ev?.status === 'cancelled') continue
    if (ev?.eventType && ev.eventType !== 'DEFAULT' && ev.eventType !== 'FROM_GMAIL') continue
    const start = ev?.start?.dateTime
    const end = ev?.end?.dateTime
    if (!start || !end) continue // all-day
    const attendees: any[] = Array.isArray(ev.attendees) ? ev.attendees : []
    const me = attendees.find(a => a?.self)
    if (me?.responseStatus === 'declined') continue
    const people = attendees.filter(a => !a?.self && !a?.resource && a?.responseStatus !== 'declined')
    const isOrganizer = Boolean(ev.organizer?.self)
    const role = roleOf(ev, people, isOrganizer)
    const title = String(ev.summary ?? '(no title)').trim()
    out.push({
      id: String(ev.id ?? `${start}-${title}`),
      title,
      start,
      end,
      startLabel: hhmm(start),
      endLabel: hhmm(end),
      role,
      cta: ctaOf(role, people),
      organizer: isOrganizer ? 'you' : nameOf(ev.organizer),
      isOrganizer,
      attendees: people.map(nameOf),
      description: stripHtml(String(ev.description ?? '')).slice(0, 1500),
      isRecurring: Boolean(ev.recurringEventId),
      link: String(ev.htmlLink ?? ''),
      callUrl: String(ev.conferenceUrl ?? ev.hangoutLink ?? ''),
      prepPath: `${PREP_DIR}/${day}-${slugify(title)}.md`,
      hasPrep: false,
    })
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
}

let server: string | null = null

/** The Google Calendar MCP server: the one whose tools include `list_events`. */
async function calendarServer($: any): Promise<string> {
  if (server) return server
  try {
    const tools: any[] = (await $.tool.list()) ?? []
    for (const t of tools) {
      const m = /^mcp__(.+)__list_events$/.exec(String(t?.name ?? ''))
      if (m?.[1]) {
        server = m[1]
        return server
      }
    }
  } catch {
    // fall through to the known connector
  }
  return FALLBACK_SERVER
}

/** Today's meetings from Google Calendar, ordered by start. Throws with a readable reason. */
export async function fetchMeetings($: any, day: string): Promise<MeetingItem[]> {
  const srv = await calendarServer($)
  const res: any = await $.mcp.call(srv, 'list_events', {
    startTime: `${day}T00:00:00`,
    endTime: `${nextDay(day)}T00:00:00`,
    orderBy: 'startTime',
    pageSize: 100,
  })
  const text = (res?.content ?? []).map((b: any) => (b?.type === 'text' ? b.text : '')).join('')
  if (res?.isError) throw new Error(`Calendar: ${text.slice(0, 160) || 'the call failed'}`)
  const json = res?.structuredContent ?? (text ? JSON.parse(text) : {})
  return parseEvents(json, day)
}

export const isPast = (m: MeetingItem, now = Date.now()) => Date.parse(m.end) <= now
export const isLive = (m: MeetingItem, now = Date.now()) => Date.parse(m.start) <= now && now < Date.parse(m.end)

/** The prompt a meeting's Prepare button sends: retrieve the context, then write the prep note. */
export function prepPrompt(m: MeetingItem, day: string): string {
  const who = m.attendees.length > 12 ? `${m.attendees.slice(0, 12).join(', ')} and ${m.attendees.length - 12} more` : m.attendees.join(', ')
  return [
    `Prepare me for this meeting today (${day}):`,
    `- Meeting: ${m.title} · ${m.startLabel}–${m.endLabel} · ${m.isRecurring ? 'recurring' : 'one-off'}`,
    `- Organizer: ${m.organizer} · my role: ${m.role}${who ? ` · with: ${who}` : ''}`,
    `- Calendar: ${m.link}`,
    m.description ? `- Description:\n${m.description}` : '- Description: none',
    '',
    `Call to action: ${m.cta}.`,
    '',
    'Retrieve the content first: earlier notes of this meeting or its series (raw/meetings/meetings-index.md, the series page), related wiki pages (wiki/index.md), the Notion, Jira or Slack links in the description, recent Slack threads or Notion pages on the topic, and open items in todo.md involving these people.',
    `Then write the prep material to ${m.prepPath} in the vault (front matter: meeting, date, start, event link). Sections: Goal and my role · What changed since last time (cited) · My talking points and asks · Decisions or questions to raise · Links to have open. One-line bullets. If it needs no real prep (social, listen-only), say so in two lines and still write the file.`,
    'Read-only on Notion, Jira, Slack and Gmail: drafts only, nothing sent or posted. Finish with a 5-line summary here.',
  ].join('\n')
}

/** One prompt for every upcoming meeting still without a prep note. */
export function prepDayPrompt(ms: MeetingItem[], day: string): string {
  return [
    `Prepare me for my remaining meetings today (${day}). One prep note per meeting, same rules as a single prep: retrieve the content first (raw/meetings, wiki, links in the description, Slack/Notion on the topic, todo.md), then write the note to its path. Read-only on Notion, Jira, Slack and Gmail. Light touch for listen-in or social meetings.`,
    '',
    ...ms.map(m => `- ${m.startLabel} ${m.title} · ${m.role} · ${m.cta} · ${m.link} → ${m.prepPath}`),
    '',
    'Finish with a 2-line summary per meeting here.',
  ].join('\n')
}
