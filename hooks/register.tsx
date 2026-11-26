import { atom, read, update } from 'claude-code'
import type { Register, ThemeSetArgs } from 'claude-code'

import type { MeetingItem, MeetingsSnapshot, Snapshot, TodoItem, TodoKind } from '../types'
import { makeColors } from './make-colors.js'
import { dayIn, fetchMeetings, isLive, isPast, prepDayPrompt, prepPrompt } from './meetings'

// "Ember quest": warm charcoal by night, warm paper by day, coral accent (matches the quest board tiles).
const { theme: emberColors, problems: lookProblems } = makeColors({
  label: 'Ember quest',
  roles: { accent: '#d97757', danger: '#c9483b', success: '#5f9a4a', warning: '#d39a2c', pro: '#9a6fc4' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#efe7dc',
        'surface-1': '#f5efe6',
        'surface-2': '#fbf7f1',
        'text-primary': '#2b2420',
        'text-secondary': '#57493f',
        'text-muted': '#6e6157',
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#161412',
        'surface-1': '#1c1a18',
        'surface-2': '#23201d',
        'surface-3': '#2a2623',
        'text-primary': '#f2efe9',
        'text-secondary': '#cdc6bc',
        'text-muted': '#a39b90',
      },
    },
  },
})
const LOOK: ThemeSetArgs = { colors: emberColors }

const PANE = 'wiki-sidebar'
const OPEN_ASK = /\b(open|show|reopen|apri|mostra|riapri)\b[^.?!\n]{0,40}\b(wiki[\s-]*)?side\s*bar\b/i
const TITLE = 'To-do quests'
// The local Obsidian vault is the source of truth; Obsidian Git keeps it in sync with GitHub.
const VAULT = '/Users/andreacavagna/Documents/LLM-Wiki'
const ROOTS = [VAULT, '.', '/home/user/llm-wiki']
const TODO_FILE = 'todo.md'

const snapshot = atom({ plugin: 'wiki-sidebar', key: 'snapshot' } as const, null, { shape: 'snapshot-4' })
const busy = atom({ plugin: 'wiki-sidebar', key: 'busy' } as const, false)
const showDone = atom({ plugin: 'wiki-sidebar', key: 'showDone' } as const, false)
const meetings = atom({ plugin: 'wiki-sidebar', key: 'meetings' } as const, null, { shape: 'meetings-1' })
const meetingsBusy = atom({ plugin: 'wiki-sidebar', key: 'meetingsBusy' } as const, false)
// To-dos open by default, meetings folded: both toggle from their section header.
const todosOpen = atom({ plugin: 'wiki-sidebar', key: 'todosOpen' } as const, true)
const meetingsOpen = atom({ plugin: 'wiki-sidebar', key: 'meetingsOpen' } as const, false)
const showPastMeetings = atom({ plugin: 'wiki-sidebar', key: 'showPastMeetings' } as const, false)
// Re-read the calendar at the end of a turn when the last read is older than this.
const MEETINGS_TTL_MS = 15 * 60 * 1000

// ---------- game rules ----------

const XP_PER_TODO = 10
const TITLES = ['Rookie', 'Closer', 'Finisher', 'Shipper', 'Operator', 'Machine', 'Legend']
// Level n starts at 50 * n * (n - 1) / 2 XP: 0, 50, 150, 300, 500, ...
const xpForLevel = (n: number) => (50 * n * (n - 1)) / 2
const levelOf = (xp: number) => Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * xp) / 50)) / 2))

const KIND: Record<TodoKind, { label: string; open: string; color: string }> = {
  slack: { label: 'SLACK', open: 'Open in Slack', color: '#C08BE0' },
  notion: { label: 'NOTION', open: 'Open in Notion', color: '#9DB4D8' },
  artifact: { label: 'ARTIFACT', open: 'Open artifact', color: '#D97757' },
  workday: { label: 'WORKDAY', open: 'Open in Workday', color: '#E8B04B' },
}

// ---------- helpers ----------

const hash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const today = () => isoDay(new Date())

const join = (root: string, rel: string) => (root === '.' ? rel : `${root}/${rel}`)

function kindOf(url: string): TodoKind | null {
  if (/^https:\/\/[^/]*slack\.com\//.test(url) || url.startsWith('slack://')) return 'slack'
  if (/^https:\/\/([^/]*\.)?notion\.(so|com)\//.test(url) || url.startsWith('notion://')) return 'notion'
  if (/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(url)) return 'artifact'
  if (/^https:\/\/([^/]*\.)?myworkday\.com\//.test(url)) return 'workday'
  return null
}

const LINE = /^(\s*)- \[( |x|X|\/)\] \[([^\]]+)\]\((\S+?)\)(.*)$/

function parseLine(line: string): TodoItem | null {
  const m = LINE.exec(line)
  if (!m) return null
  const text = (m[3] ?? '').trim()
  const url = m[4] ?? ''
  const kind = kindOf(url)
  if (!kind) return null
  const rest = m[5] ?? ''
  const doneDate = /✅\s*(\d{4}-\d{2}-\d{2})/.exec(rest)?.[1] ?? ''
  const context = rest
    .replace(/✅\s*\d{4}-\d{2}-\d{2}/, '')
    .replace(/^\s*[·—–-]\s*/, '')
    .trim()
  return { id: hash(text + url), text, url, kind, context, isDone: m[2] === 'x' || m[2] === 'X', isStarted: m[2] === '/', doneDate }
}

async function findRoot($: any): Promise<string> {
  for (const root of ROOTS) {
    if (await $.fs.exists(join(root, TODO_FILE))) return root
  }
  throw new Error(`${TODO_FILE} not found (looked in ${ROOTS.join(', ')})`)
}

/** Consecutive days with a to-do ticked, counting back from today (or yesterday); weekends never break it. */
function streakFrom(dates: Set<string>): number {
  const d = new Date()
  if (!dates.has(isoDay(d))) d.setDate(d.getDate() - 1)
  let n = 0
  for (let i = 0; i < 365; i++) {
    const isWeekend = d.getDay() === 0 || d.getDay() === 6
    if (dates.has(isoDay(d))) n++
    else if (!isWeekend) break
    d.setDate(d.getDate() - 1)
  }
  return n
}

// ---------- loading ----------

async function loadSnapshot($: any): Promise<Snapshot> {
  try {
    const root = await findRoot($)
    const text: string = await $.fs.read(join(root, TODO_FILE))
    const todos = text
      .split('\n')
      .map(parseLine)
      .filter((t): t is TodoItem => t !== null)
    return { root, todos, loadedAt: Date.now() }
  } catch (err: any) {
    return { root: '', todos: [], loadedAt: Date.now(), error: String(err?.message ?? err) }
  }
}

async function refresh($: any) {
  await update($, busy, () => true)
  try {
    const snap = await loadSnapshot($)
    await update($, snapshot, () => snap)
  } finally {
    await update($, busy, () => false)
  }
}

// ---------- actions ----------

/** Tick or untick in todo.md itself, so Obsidian and the daily routine see it. */
async function toggleDone($: any, id: string) {
  const root = await findRoot($)
  const path = join(root, TODO_FILE)
  const text: string = await $.fs.read(path)
  const lines = text.split('\n')
  let isNowDone = false
  const at = lines.findIndex(l => parseLine(l)?.id === id)
  if (at < 0) {
    void $.ui.toast('That to-do changed in todo.md; refreshed the list')
    await refresh($)
    return
  }
  const doneCount = (ls: string[]) => ls.map(parseLine).filter(t => t?.isDone).length
  const levelBefore = levelOf(doneCount(lines) * XP_PER_TODO)
  const line = lines[at] ?? ''
  if (/^(\s*)- \[[ /]\]/.test(line)) {
    lines[at] = `${line.replace(/^(\s*)- \[[ /]\]/, '$1- [x]').trimEnd()} ✅ ${today()}`
    isNowDone = true
  } else {
    lines[at] = line.replace(/^(\s*)- \[[xX]\]/, '$1- [ ]').replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, '')
  }
  await $.fs.write(path, lines.join('\n'))
  await refresh($)
  if (!isNowDone) return
  const levelAfter = levelOf(doneCount(lines) * XP_PER_TODO)
  if (levelAfter > levelBefore && levelAfter <= CLAWDS.length) {
    void $.ui.toast(`Level ${levelAfter}! New Clawd unlocked: ${clawdFor(levelAfter).name}`)
  } else if (levelAfter > levelBefore) {
    void $.ui.toast(`Level ${levelAfter}! ${clawdFor(levelAfter).name} Clawd still reigns`)
  } else {
    void $.ui.toast(`Quest complete: +${XP_PER_TODO} XP`)
  }
}

/** Mark a to-do in progress (`- [/]`, the Obsidian Tasks convention) or back to not started (`- [ ]`). */
async function setStarted($: any, id: string, isStarted: boolean) {
  const root = await findRoot($)
  const path = join(root, TODO_FILE)
  const text: string = await $.fs.read(path)
  const lines = text.split('\n')
  const at = lines.findIndex(l => parseLine(l)?.id === id)
  if (at < 0) {
    void $.ui.toast('That to-do changed in todo.md; refreshed the list')
    await refresh($)
    return
  }
  const line = lines[at] ?? ''
  const from = isStarted ? /^(\s*)- \[ \]/ : /^(\s*)- \[\/\]/
  if (!from.test(line)) return refresh($)
  lines[at] = line.replace(from, isStarted ? '$1- [/]' : '$1- [ ]')
  await $.fs.write(path, lines.join('\n'))
  await refresh($)
}

async function openLink($: any, url: string) {
  const res = await $.process.run(['open', url], { timeoutMs: 10000 })
  if (res.exitCode !== 0) void $.ui.toast('Could not open the link')
}

async function openTodoFile($: any) {
  const root = await findRoot($).catch(() => VAULT)
  const abs = root.startsWith('/') ? `${root}/${TODO_FILE}` : `${VAULT}/${TODO_FILE}`
  await openLink($, `obsidian://open?path=${encodeURIComponent(abs)}`)
}

const askClaude = ($: any, text: string) => void $.prompt.submit({ text, asUser: true })

/** The prompt a to-do's Start button sends: the item, its link and its source line, under the vault rules. */
function startPrompt(t: TodoItem): string {
  return [
    `Start working on: ${t.text} (${t.url})${t.context ? ` · ${t.context}` : ''}`,
    '',
    'This is an open item from todo.md. Follow the vault rules in CLAUDE.md: read the linked source first; drafts only for anything outward-facing (Slack, Notion, Jira, email), so show me the draft and wait for my OK before sending or posting. Do not tick the item in todo.md; I do that from the sidebar.',
  ].join('\n')
}

function startTodo($: any, t: TodoItem) {
  askClaude($, startPrompt(t))
  if (!t.isStarted) void setStarted($, t.id, true)
  void $.ui.toast(`${t.isStarted ? 'Continuing' : 'Started'}: ${cut(t.text, 40)}`)
}

// ---------- meetings ----------

/** Mark which meetings already have a prep note in the vault. */
async function withPrepStatus($: any, ms: MeetingItem[]): Promise<MeetingItem[]> {
  const root = await findRoot($).catch(() => VAULT)
  return Promise.all(ms.map(async m => ({ ...m, hasPrep: Boolean(await $.fs.exists(join(root, m.prepPath)).catch(() => false)) })))
}

/** Re-read today's calendar (or, with `onlyPrep`, just re-check which prep notes exist). */
async function refreshMeetings($: any, opts: { onlyPrep?: boolean } = {}) {
  const day = dayIn()
  const prev = await read($, meetings)
  if (opts.onlyPrep && prev && !prev.error && prev.day === day) {
    const next = await withPrepStatus($, prev.meetings)
    await update($, meetings, () => ({ ...prev, meetings: next }))
    return
  }
  await update($, meetingsBusy, () => true)
  try {
    const ms = await withPrepStatus($, await fetchMeetings($, day))
    await update($, meetings, () => ({ day, meetings: ms, loadedAt: Date.now() }))
  } catch (err: any) {
    const error = String(err?.message ?? err)
    // keep the last good list if there is one for today
    await update($, meetings, () => (prev && prev.day === day && !prev.error ? { ...prev, error } : { day, meetings: [], loadedAt: Date.now(), error }))
  } finally {
    await update($, meetingsBusy, () => false)
  }
}

function prepMeeting($: any, m: MeetingItem, day: string) {
  askClaude($, prepPrompt(m, day))
  void $.ui.toast(`Preparing: ${cut(m.title, 40)}`)
}

async function openPrep($: any, m: MeetingItem) {
  const root = await findRoot($).catch(() => VAULT)
  const abs = root.startsWith('/') ? `${root}/${m.prepPath}` : `${VAULT}/${m.prepPath}`
  await openLink($, `obsidian://open?path=${encodeURIComponent(abs)}`)
}

const ROLE: Record<MeetingItem['role'], { label: string; color: string }> = {
  host: { label: 'YOU HOST', color: '#D97757' },
  'one-on-one': { label: '1:1', color: '#C08BE0' },
  daily: { label: 'DAILY', color: '#9DB4D8' },
  broadcast: { label: 'LISTEN-IN', color: '#8F8A82' },
  meeting: { label: 'MEETING', color: '#E8B04B' },
}

// ---------- derived game state ----------

function gameOf(snap: Snapshot) {
  // in-progress first, then the rest in file order
  const open = snap.todos.filter(t => !t.isDone).sort((a, b) => Number(b.isStarted) - Number(a.isStarted))
  const closed = snap.todos.filter(t => t.isDone)
  const xp = closed.length * XP_PER_TODO
  const level = levelOf(xp)
  const floor = xpForLevel(level)
  const ceil = xpForLevel(level + 1)
  const title = TITLES[Math.min(level - 1, TITLES.length - 1)] ?? 'Legend'
  const doneToday = closed.filter(t => t.doneDate === today()).length
  const streak = streakFrom(new Set(closed.map(t => t.doneDate).filter(Boolean)))
  const openBy = (k: TodoKind) => open.filter(t => t.kind === k).length
  const started = open.filter(t => t.isStarted).length
  return { xp, level, floor, ceil, title, open, closed, doneToday, streak, openBy, started }
}

// ---------- text fallback ----------

function meetingsReport(ms: MeetingsSnapshot | null): string {
  if (!ms) return 'MEETINGS TODAY · loading'
  if (ms.error && ms.meetings.length === 0) return `MEETINGS TODAY · ${ms.error}`
  const upcoming = ms.meetings.filter(m => !isPast(m))
  const lines = [`MEETINGS TODAY · ${upcoming.length} to go`]
  if (upcoming.length === 0) lines.push('  nothing left today')
  upcoming.forEach(m => lines.push(`  ${m.startLabel} ${m.title} · ${m.cta}${m.hasPrep ? ' · prep ready' : ''}`))
  return lines.join('\n')
}

function textReport(snap: Snapshot): string {
  if (snap.error) return `To-do: ${snap.error}`
  const g = gameOf(snap)
  const lines: string[] = []
  lines.push(`TO-DO · Lv ${g.level} ${g.title} · ${g.xp} XP · 🔥 ${g.streak}-day streak · ${g.doneToday} done today · Clawd: ${clawdFor(g.level).name}`)
  lines.push('')
  if (g.open.length === 0) lines.push('☐ nothing pending')
  g.open.forEach(t => lines.push(`${t.isStarted ? '◐' : '☐'} [${KIND[t.kind].label}]${t.isStarted ? ' IN PROGRESS' : ''} ${t.text}${t.context ? ` (${t.context})` : ''}\n   ${t.url}`))
  return lines.join('\n')
}

// ---------- design ----------

// Claude Code mod look: warm dark tiles, coral accent, mono labels.
const C = {
  tile: '#1C1A18',
  tileLine: '#34302C',
  ink: '#F2EFE9',
  muted: '#8F8A82',
  coral: '#D97757',
  coralSoft: '#3A2A23',
  gold: '#E8B04B',
  green: '#7FB069',
}
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"
const SANS = "system-ui, -apple-system, 'Inter', sans-serif"
// SVG tiles are drawn at a narrow design width and scale to the sidebar
const W = 320

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svgRoot = (h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">${body}</svg>`

/** The level card: level, XP, streak and today, the current Clawd animated beside it, and the Clawd ladder along the bottom. */
function heroSvg(g: ReturnType<typeof gameOf>) {
  const xpIn = g.xp - g.floor
  const xpSpan = g.ceil - g.floor
  const pct = Math.max(0, Math.min(1, xpSpan > 0 ? xpIn / xpSpan : 0))
  const H = 250
  const barW = W - 40
  const counts = (['slack', 'notion', 'artifact', 'workday'] as const)
    .map(k => `<tspan fill="${KIND[k].color}">${KIND[k].label}</tspan> <tspan fill="${C.ink}" font-weight="700">${g.openBy(k)}</tspan>`)
    .join('  ')
  const current = clawdFor(g.level)
  const big = 1.3
  const bigX = W - 20 - 14 * P * big
  const unlocked = Math.min(g.level, CLAWDS.length)
  const next = CLAWDS[g.level]
  // the ladder: one small Clawd per level along the bottom
  const cell = barW / CLAWDS.length
  const mini = 0.5
  const ladder = CLAWDS.map((c, i) => {
    const lv = i + 1
    const on = g.level >= lv
    const isCurrent = c === current
    const cx = 20 + cell * i + cell / 2
    const x = cx - (14 * P * mini) / 2
    const art = on ? miniArt(c) : clawdShape(C.tileLine, { eyes: '' })
    return `<g><title>${esc(on ? `${c.name}, level ${lv}` : `Unlocks at level ${lv}`)}</title>
    ${isCurrent ? `<rect x="${(cx - cell / 2 + 2).toFixed(1)}" y="196" width="${(cell - 4).toFixed(1)}" height="46" rx="8" fill="${C.coralSoft}" stroke="${C.coral}"/>` : ''}
    <g transform="translate(${x.toFixed(1)} 210) scale(${mini})" opacity="${on ? 1 : 0.6}">${art}</g>
    <text x="${cx.toFixed(1)}" y="236" text-anchor="middle" font-family="${MONO}" font-size="7.5" fill="${isCurrent ? C.coral : C.muted}">${on ? `LV ${lv}` : '?'}</text></g>`
  }).join('')
  return svgRoot(
    H,
    `<defs>
    <linearGradient id="bar" x1="0" x2="1"><stop offset="0" stop-color="${C.coral}"/><stop offset="1" stop-color="${C.gold}"/></linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.2" r="0.6"><stop offset="0" stop-color="${C.coral}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.coral}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${C.tile}" stroke="${C.tileLine}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="url(#glow)"/>
  <text x="20" y="30" font-family="${MONO}" font-size="10" letter-spacing="2" fill="${C.coral}">◆ TO-DO · ${g.open.length} OPEN · ${g.started} STARTED · ${g.doneToday} TODAY</text>
  <text x="20" y="66" font-family="${SANS}" font-size="28" font-weight="700" fill="${C.ink}">Level ${g.level}</text>
  <text x="20" y="96" font-family="${SANS}" font-size="24" font-weight="700" fill="${C.coral}">${esc(g.title)}.</text>
  <g transform="translate(${bigX.toFixed(1)} 50) scale(${big})"><g>${current.motion}${clawdArt(current)}</g></g>
  <text x="${(bigX + 7 * P * big).toFixed(1)}" y="104" text-anchor="middle" font-family="${MONO}" font-size="8" letter-spacing="1" fill="${C.muted}">${esc(current.name.toUpperCase())}</text>
  <text x="20" y="122" font-family="${MONO}" font-size="9" letter-spacing="1">${counts}</text>
  <rect x="20" y="134" width="${barW}" height="7" rx="3.5" fill="${C.tileLine}"/>
  <rect x="20" y="134" width="${Math.max(7, barW * pct).toFixed(1)}" height="7" rx="3.5" fill="url(#bar)"/>
  <text x="20" y="162" font-family="${MONO}" font-size="10" fill="${C.muted}"><tspan fill="${C.ink}" font-weight="700">${g.xp}</tspan> XP · ${xpSpan - xpIn} to Lv ${g.level + 1}</text>
  <text x="${W - 20}" y="162" text-anchor="end" font-family="${MONO}" font-size="10" fill="${g.streak > 0 ? C.gold : C.muted}">🔥 ${g.streak}-DAY STREAK</text>
  <line x1="20" x2="${W - 20}" y1="176" y2="176" stroke="${C.tileLine}"/>
  <text x="20" y="190" font-family="${MONO}" font-size="8.5" letter-spacing="1" fill="${C.muted}">CLAWDS <tspan fill="${C.ink}" font-weight="700">${unlocked} OF ${CLAWDS.length}</tspan></text>
  <text x="${W - 20}" y="190" text-anchor="end" font-family="${MONO}" font-size="8.5" letter-spacing="1" fill="${C.coral}">${next ? `NEXT: ${esc(next.name.toUpperCase())} AT LV ${g.level + 1}` : 'ALL UNLOCKED'}</text>
  ${ladder}`,
  )
}

// ---------- Clawds: one animated Clawd unlocked per level ----------

type Clawd = { name: string; body: string; extra: string; motion: string }

const P = 4 // one Clawd pixel in SVG units
const px = (x: number, y: number, w: number, h: number, fill: string, more = '') =>
  `<rect x="${x * P}" y="${y * P}" width="${w * P}" height="${h * P}" fill="${fill}" ${more}/>`
const loop = (attr: string, values: string, dur: string, extra = '') =>
  `<animate attributeName="${attr}" values="${values}" dur="${dur}" repeatCount="indefinite" ${extra}/>`
const move = (values: string, dur: string, extra = '') =>
  `<animateTransform attributeName="transform" type="translate" values="${values}" dur="${dur}" repeatCount="indefinite" ${extra}/>`

const EYE = '#2b2420'
const blinkEyes = (color = EYE) =>
  [4, 9]
    .map(
      x =>
        `<rect x="${x * P}" y="${2 * P}" width="${P}" height="${2 * P}" fill="${color}">${loop('height', `${2 * P};${2 * P};1;${2 * P}`, '3.2s', 'keyTimes="0;0.9;0.95;1"')}${loop('y', `${2 * P};${2 * P};${3.5 * P};${2 * P}`, '3.2s', 'keyTimes="0;0.9;0.95;1"')}</rect>`,
    )
    .join('')

/** Clawd's own shape: body, two arms, four legs. Arms and legs come as separate groups so they can move. */
function clawdShape(body: string, opts: { leftArm?: string; rightArm?: string; legsA?: string; legsB?: string; eyes?: string } = {}) {
  return [
    px(2, 0, 10, 6, body),
    `<g>${px(0, 2, 2, 2, body)}${opts.leftArm ?? ''}</g>`,
    `<g>${px(12, 2, 2, 2, body)}${opts.rightArm ?? ''}</g>`,
    `<g>${px(3, 6, 1, 2, body)}${px(8, 6, 1, 2, body)}${opts.legsA ?? ''}</g>`,
    `<g>${px(5, 6, 1, 2, body)}${px(10, 6, 1, 2, body)}${opts.legsB ?? ''}</g>`,
    opts.eyes ?? blinkEyes(),
  ].join('')
}

const CORAL = '#D97757'
const GOLDC = '#E8B04B'

const CLAWDS: Clawd[] = [
  // Lv 1: the plain one, breathing
  { name: 'Hatchling', body: CORAL, extra: '', motion: move('0 0;0 -2;0 0', '1.6s') },
  // Lv 2: waves hello
  { name: 'Waver', body: CORAL, extra: 'wave', motion: move('0 0;0 -1;0 0', '1.6s') },
  // Lv 3: headband, hops
  {
    name: 'Hopper',
    body: CORAL,
    extra: `${px(2, 0, 10, 1, '#c9483b')}${px(12, 0, 2, 1, '#c9483b')}${px(13, 1, 1, 1, '#c9483b')}`,
    motion: move('0 0;0 -10;0 0;0 0', '1s', 'keyTimes="0;0.3;0.6;1"'),
  },
  // Lv 4: carries a parcel and walks
  {
    name: 'Courier',
    body: CORAL,
    extra: `${px(4, -4, 6, 4, '#a9773f')}${px(6.5, -4, 1, 4, '#7d5528')}${px(4, -2.5, 6, 1, '#7d5528')}`,
    motion: move('-8 0;8 0;-8 0', '2.4s'),
  },
  // Lv 5: shades and headset
  {
    name: 'Operator',
    body: CORAL,
    extra: `${px(3, 2, 8, 1.4, '#111')}${px(1.5, -1.5, 11, 1, '#3a3632')}${px(1.5, -1.5, 1, 3, '#3a3632')}${px(11.5, -1.5, 1, 3, '#3a3632')}${px(11.5, 3.2, 2.5, 0.8, '#3a3632')}`,
    motion: move('0 0;0 -1;0 0', '0.5s'),
  },
  // Lv 6: antenna with a beacon, glowing eyes
  {
    name: 'Mecha',
    body: '#B5603F',
    extra: `${px(6.5, -3, 1, 3, '#8F8A82')}<rect x="${6 * P}" y="${-4.5 * P}" width="${2 * P}" height="${2 * P}" fill="#E8B04B">${loop('opacity', '1;0.2;1', '1s')}</rect>${px(2, 4.5, 10, 0.6, '#8F8A82')}`,
    motion: move('0 0;1 0;-1 0;0 0', '0.4s'),
  },
  // Lv 7+: gold, crowned, sparkling
  {
    name: 'Legend',
    body: GOLDC,
    extra: `${px(3, -2, 8, 2, '#f2c14e')}${px(3, -3.5, 1, 1.5, '#f2c14e')}${px(6.5, -3.5, 1, 1.5, '#f2c14e')}${px(10, -3.5, 1, 1.5, '#f2c14e')}${px(6.5, -1.5, 1, 1, '#c9483b')}${[
      [-2, -3, '0s'],
      [15, 0, '0.6s'],
      [-1.5, 6, '1.1s'],
      [15.5, 6.5, '0.3s'],
    ]
      .map(([x, y, d]) => `<rect x="${Number(x) * P}" y="${Number(y) * P}" width="${P}" height="${P}" fill="#fff6d8" opacity="0">${loop('opacity', '0;1;0', '1.4s', `begin="${d}"`)}</rect>`)
      .join('')}`,
    motion: move('0 0;0 -4;0 0', '2s'),
  },
]

function clawdArt(c: Clawd): string {
  const swing = (id: string, values: string, dur: string) => `<g>${move(values, dur)}${id}</g>`
  if (c.extra === 'wave') {
    // right arm lifts and waves
    return clawdShape(c.body).replace(px(12, 2, 2, 2, c.body), swing(px(12, 2, 2, 2, c.body), '0 0;0 -8;0 -4;0 -8;0 0', '1.2s'))
  }
  if (c.name === 'Courier') {
    const body = clawdShape(c.body)
      .replace(`${px(3, 6, 1, 2, c.body)}${px(8, 6, 1, 2, c.body)}`, swing(`${px(3, 6, 1, 2, c.body)}${px(8, 6, 1, 2, c.body)}`, '0 0;0 -3;0 0;0 0', '0.4s'))
      .replace(px(0, 2, 2, 2, c.body), px(0, -1, 2, 4, c.body))
      .replace(px(12, 2, 2, 2, c.body), px(12, -1, 2, 4, c.body))
    return body + c.extra
  }
  if (c.name === 'Operator') {
    const body = clawdShape(c.body)
      .replace(px(0, 2, 2, 2, c.body), swing(px(0, 2, 2, 2, c.body), '0 0;0 2;0 0', '0.25s'))
      .replace(px(12, 2, 2, 2, c.body), swing(px(12, 2, 2, 2, c.body), '0 2;0 0;0 2', '0.25s'))
    return body + c.extra
  }
  if (c.name === 'Mecha') {
    const glow = [4, 9]
      .map(x => `<rect x="${x * P}" y="${2 * P}" width="${P}" height="${2 * P}" fill="#7fe3ff">${loop('fill', '#7fe3ff;#ffffff;#7fe3ff', '1.2s')}</rect>`)
      .join('')
    return clawdShape(c.body, { eyes: glow }) + c.extra
  }
  return clawdShape(c.body) + c.extra
}

/** A still Clawd for the ladder: its look and accessories, no motion. */
function miniArt(c: Clawd): string {
  const eyes = [4, 9].map(x => px(x, 2, 1, 2, c.name === 'Mecha' ? '#7fe3ff' : EYE)).join('')
  return clawdShape(c.body, { eyes }) + (c.extra === 'wave' ? '' : c.extra)
}

const clawdFor = (level: number) => CLAWDS[Math.min(level, CLAWDS.length) - 1] ?? CLAWDS[0]!

// ---------- drawing ----------

/** A section header that folds its section: ▾ open, ▸ folded, the summary on the right. */
function SectionToggle(E: any, key: string, label: string, right: string, isOpen: boolean, onPress: () => void) {
  const { Box, Button, Text } = E
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
      <Button key={key} plain onPress={onPress}>
        {`${isOpen ? '▾' : '▸'} ${label}`}
      </Button>
      <Text mono size="caption" color={C.coral}>
        {right}
      </Text>
    </Box>
  )
}

function drawTodos($: any, E: any, snap: Snapshot | null, isShowingDone: boolean, textLen: number) {
  const { Box, Text, Button, Progress } = E
  const Svg = E.Svg
  if (!snap) return <Text dimColor>Loading your to-dos…</Text>
  if (snap.error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={C.coral}>{snap.error}</Text>
        <Button key="retry" onPress={() => void refresh($)}>
          Retry
        </Button>
      </Box>
    )
  }
  const g = gameOf(snap)
  const total = g.open.length + g.doneToday
  return (
    <Box flexDirection="column" gap={1}>
      {/* Hero */}
      {Svg ? (
        <Svg
          source={heroSvg(g)}
          alt={`Level ${g.level} ${g.title}, ${g.xp} XP, ${g.open.length} open, ${g.doneToday} done today, ${g.streak}-day streak. Clawds: ${CLAWDS.map((c, i) => (g.level >= i + 1 ? `${c.name} unlocked` : `${c.name} locked until level ${i + 1}`)).join(', ')}`}
        />
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor={C.coral} paddingX={1}>
          <Text bold>
            Level {g.level} <Text color={C.coral}>{g.title}.</Text> <Text color={C.gold}>🔥 {g.streak}</Text>
          </Text>
          <Text dimColor>
            👾 {clawdFor(g.level).name} · Clawds {Math.min(g.level, CLAWDS.length)} of {CLAWDS.length}
          </Text>
          <Progress label={`XP to level ${g.level + 1}`} value={g.xp - g.floor} max={g.ceil - g.floor} valueText={`${g.xp} XP`} color={C.coral} />
        </Box>
      )}
      {total > 0 && (
        <Progress label="Today" value={g.doneToday} max={total} valueText={`${g.doneToday} of ${total} done today`} color={C.green} />
      )}
      {g.open.length === 0 && <Text color={C.green}>Nothing pending. 🏆</Text>}
      {g.open.map(t => (
        <Box
          key={`q-${t.id}`}
          flexDirection="row"
          gap={1}
          alignItems="flex-start"
          borderStyle="round"
          borderColor={t.isStarted ? C.coral : C.tileLine}
          paddingX={1}
        >
          <Button key={`done-${t.id}`} plain onPress={() => void toggleDone($, t.id)}>
            {t.isStarted ? '◐' : '☐'}
          </Button>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" gap={1}>
              <Text mono size="caption" weight="bold" color={KIND[t.kind].color}>
                {KIND[t.kind].label}
              </Text>
              {t.isStarted ? (
                <Text mono size="caption" weight="bold" color={C.coral}>
                  · IN PROGRESS
                </Text>
              ) : null}
            </Box>
            <Text>{cut(t.text, textLen)}</Text>
            {t.context ? (
              <Text mono size="caption" color={C.muted}>
                {cut(t.context, 60)}
              </Text>
            ) : null}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key={`start-${t.id}`} variant="primary" onPress={() => startTodo($, t)}>
                {t.isStarted ? '▶ Continue' : '▶ Start'}
              </Button>
              <Button key={`progress-${t.id}`} plain dimColor onPress={() => void setStarted($, t.id, !t.isStarted)}>
                {t.isStarted ? '○ Not started' : '◐ In progress'}
              </Button>
              <Button key={`open-${t.id}`} plain onPress={() => void openLink($, t.url)}>
                ↗ {KIND[t.kind].open}
              </Button>
            </Box>
          </Box>
        </Box>
      ))}
      {g.closed.length > 0 && (
        <Button key="toggle-done" plain dimColor onPress={() => void update($, showDone, v => !v)}>
          {isShowingDone ? '▾' : '▸'} {g.closed.length} done
        </Button>
      )}
      {isShowingDone &&
        g.closed.map(t => (
          <Box key={`c-${t.id}`} flexDirection="row" gap={1} paddingX={1}>
            <Button key={`undo-${t.id}`} plain dimColor onPress={() => void toggleDone($, t.id)}>
              ☑
            </Button>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor strikethrough>
                {cut(t.text, textLen)}
              </Text>
            </Box>
          </Box>
        ))}
    </Box>
  )
}

function MeetingCard($: any, E: any, m: MeetingItem, day: string, textLen: number, now: number) {
  const { Box, Text, Button } = E
  const live = isLive(m, now)
  const past = isPast(m, now)
  const role = ROLE[m.role]
  return (
    <Box
      key={`m-${m.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={live ? C.coral : m.hasPrep ? C.green : C.tileLine}
      paddingX={1}
    >
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text mono size="caption" weight="bold" color={past ? C.muted : C.ink}>
          {m.startLabel}–{m.endLabel}
        </Text>
        <Text mono size="caption" weight="bold" color={role.color}>
          {role.label}
        </Text>
        {live ? (
          <Text mono size="caption" weight="bold" color={C.coral}>
            · NOW
          </Text>
        ) : null}
        {m.hasPrep ? (
          <Text mono size="caption" weight="bold" color={C.green}>
            · PREP READY
          </Text>
        ) : null}
      </Box>
      <Text dimColor={past}>{cut(m.title, textLen)}</Text>
      {!past ? (
        <Text mono size="caption" color={C.muted}>
          → {cut(m.cta, 70)}
        </Text>
      ) : null}
      {!past ? (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {m.hasPrep ? (
            <Button key={`prep-open-${m.id}`} variant="primary" onPress={() => void openPrep($, m)}>
              ↗ Open prep
            </Button>
          ) : (
            <Button
              key={`prep-${m.id}`}
              variant={m.role === 'broadcast' ? 'secondary' : 'primary'}
              onPress={() => prepMeeting($, m, day)}
            >
              ▶ Prepare
            </Button>
          )}
          {m.hasPrep ? (
            <Button key={`prep-redo-${m.id}`} plain dimColor onPress={() => prepMeeting($, m, day)}>
              ↻ Redo prep
            </Button>
          ) : null}
          {m.callUrl ? (
            <Button key={`join-${m.id}`} plain onPress={() => void openLink($, m.callUrl)}>
              ↗ Join
            </Button>
          ) : null}
          {m.link ? (
            <Button key={`cal-${m.id}`} plain dimColor onPress={() => void openLink($, m.link)}>
              ↗ Event
            </Button>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

function drawMeetings($: any, E: any, ms: MeetingsSnapshot | null, isShowingPast: boolean, isBusy: boolean, textLen: number) {
  const { Box, Text, Button } = E
  if (!ms) return <Text dimColor>{isBusy ? 'Reading your calendar…' : 'No calendar read yet.'}</Text>
  const now = Date.now()
  const past = ms.meetings.filter(m => isPast(m, now))
  const upcoming = ms.meetings.filter(m => !isPast(m, now))
  const unprepared = upcoming.filter(m => !m.hasPrep && m.role !== 'broadcast')
  return (
    <Box flexDirection="column" gap={1}>
      {ms.error ? (
        <Box flexDirection="column">
          <Text color={C.coral}>{cut(ms.error, 160)}</Text>
          <Button key="meetings-retry" plain onPress={() => void refreshMeetings($)}>
            Retry
          </Button>
        </Box>
      ) : null}
      {!ms.error && upcoming.length === 0 ? <Text color={C.green}>No more meetings today.</Text> : null}
      {upcoming.map(m => MeetingCard($, E, m, ms.day, textLen, now))}
      {past.length > 0 && (
        <Button key="toggle-past-meetings" plain dimColor onPress={() => void update($, showPastMeetings, v => !v)}>
          {isShowingPast ? '▾' : '▸'} {past.length} earlier today
        </Button>
      )}
      {isShowingPast && past.map(m => MeetingCard($, E, m, ms.day, textLen, now))}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {unprepared.length > 1 ? (
          <Button key="prep-day" variant="primary" onPress={() => askClaude($, prepDayPrompt(unprepared, ms.day))}>
            ▶ Prep my day ({unprepared.length})
          </Button>
        ) : null}
        <Button key="meetings-refresh" variant="secondary" onPress={() => void refreshMeetings($)}>
          {isBusy ? 'Reading calendar…' : 'Refresh calendar'}
        </Button>
      </Box>
    </Box>
  )
}

async function drawPanel($: any, e: any) {
  const E = $.ui.resolve(e) as any
  const { Box, Text, Button } = E
  const snap = await read($, snapshot)
  const isBusy = await read($, busy)
  const isShowingDone = await read($, showDone)
  const ms = await read($, meetings)
  const isMeetingsBusy = await read($, meetingsBusy)
  const isTodosOpen = await read($, todosOpen)
  const isMeetingsOpen = await read($, meetingsOpen)
  const isShowingPast = await read($, showPastMeetings)
  const cols = Math.max(24, (e.props as any)?.bodyColumns ?? e.viewport?.columns ?? 60)
  const isWidget = (e.props as any)?.placement === 'widget'
  const textLen = Math.max(40, cols * 2 - 12)
  const now = Date.now()
  const nextMeeting = ms?.meetings.find(m => !isPast(m, now))
  const meetingsLeft = ms ? ms.meetings.filter(m => !isPast(m, now)).length : 0

  if (isWidget) {
    const g = snap && !snap.error ? gameOf(snap) : null
    return (
      <Box flexDirection="column">
        {g ? (
          <Text bold>
            Lv {g.level} <Text color={C.coral}>{g.title}</Text> · 🔥 {g.streak}
          </Text>
        ) : null}
        <Text dimColor>
          {g ? `${g.open.length} to do · ${g.doneToday} done today` : 'To-dos loading'}
          {nextMeeting ? ` · next ${nextMeeting.startLabel} ${cut(nextMeeting.title, 24)}` : ''}
        </Text>
      </Box>
    )
  }

  const g = snap && !snap.error ? gameOf(snap) : null
  const todoRight = g ? (isTodosOpen ? `+${XP_PER_TODO} XP EACH` : `LV ${g.level} · ${g.doneToday} TODAY`) : ''
  const meetRight = ms?.error && !ms.meetings.length
    ? 'CALENDAR ERROR'
    : nextMeeting
      ? `NEXT ${nextMeeting.startLabel}${isMeetingsOpen ? '' : ` · ${cut(nextMeeting.title, 18).toUpperCase()}`}`
      : ms
        ? 'DONE FOR TODAY'
        : ''

  return (
    <Box flexDirection="column" gap={1}>
      {/* To do: open by default */}
      {SectionToggle(E, 'toggle-todos', `TO DO · ${g ? g.open.length : '…'}`, todoRight, isTodosOpen, () => void update($, todosOpen, v => !v))}
      {isTodosOpen && drawTodos($, E, snap, isShowingDone, textLen)}

      {/* Today's meetings: folded by default */}
      {SectionToggle(
        E,
        'toggle-meetings',
        `MEETINGS TODAY · ${ms ? meetingsLeft : '…'}`,
        meetRight,
        isMeetingsOpen,
        () => void update($, meetingsOpen, v => !v),
      )}
      {isMeetingsOpen && drawMeetings($, E, ms, isShowingPast, isMeetingsBusy, textLen)}

      {/* Footer */}
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        <Button
          key="refresh"
          variant="secondary"
          onPress={() => {
            void refresh($)
            void refreshMeetings($)
          }}
        >
          {isBusy || isMeetingsBusy ? 'Refreshing…' : 'Refresh'}
        </Button>
        <Button key="edit" variant="secondary" onPress={() => void openTodoFile($)}>
          Edit list
        </Button>
        <Button
          key="daily"
          variant="primary"
          onPress={() =>
            askClaude(
              $,
              'Run the daily routine from CLAUDE.md now (pull first, then Gmail meetings, Notion, Jira CM, Slack, light lint, update todo.md, commit and push).',
            )
          }
        >
          Run daily
        </Button>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wiki',
      description: "To-do quests: your to-dos from todo.md and today's meetings with what to prepare",
    })
    const unpainted = lookProblems.find(line => line.startsWith("Desktop won't paint"))
    if (unpainted !== undefined) void $.ui.toast(unpainted)
    void $.theme.set(LOOK)
    void $.ui.open({ id: PANE, title: TITLE })
    // to-dos first (local file), then the calendar (a network call)
    void refresh($).then(() => refreshMeetings($))
    return next(e)
  })

  on('command.run', { command: 'wiki' }, async $ => {
    await Promise.all([refresh($), refreshMeetings($)])
    const opened: any = await $.ui.open({ id: PANE, title: TITLE })
    const snap = await read($, snapshot)
    const report = `${snap ? textReport(snap) : 'To-do: still loading, run /wiki again.'}\n\n${meetingsReport(await read($, meetings))}`
    return { text: report + (opened?.isPlaced ? '\n\n(To-do quests opened beside the chat.)' : '') }
  })

  // "open the (wiki) sidebar" in plain words (EN/IT) opens the pane, like /wiki
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !OPEN_ASK.test(e.text)) return next(e)
    await refresh($)
    const opened: any = await $.ui.open({ id: PANE, title: TITLE })
    const note = opened?.isPlaced
      ? 'The wiki-sidebar mod has just opened the to-do quests pane beside the chat. Confirm in one line; do not explain how to open it.'
      : 'The wiki-sidebar mod tried to open its pane, but no surface placed it. Say so in one line and suggest /wiki.'
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // todo.md and prep notes change during a turn (the daily run, a prep): reload when it ends;
  // the calendar itself only when the last read is stale or from another day
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    const ms = await read($, meetings)
    const isStale = !ms || ms.day !== dayIn() || Date.now() - ms.loadedAt > MEETINGS_TTL_MS
    void refreshMeetings($, { onlyPrep: !isStale })
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPanel($, e))
  on('ui.render', { component: 'CommandOutput', props: { command: 'wiki' } }, async ($, e) => drawPanel($, e))
}
