import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { OpenPoint, Snapshot, TodoItem, WikiStatus } from '../types'

const PANE = 'wiki-sidebar'
const TITLE = 'LLM Wiki'
const TODO_WINDOW_DAYS = 14
const DONE_KEY = 'done-todos'

const snapshot = atom({ plugin: 'wiki-sidebar', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const busy = atom({ plugin: 'wiki-sidebar', key: 'busy' } as const, false)


// ---------- helpers ----------

const hash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const clean = (s: string): string =>
  s
    .replace(/\[\[[^\]|]*\\?\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\(\s*src\s*(,\s*src\s*)*\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/^>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const isoDaysAgo = (days: number): string => {
  const d = new Date(Date.now() - days * 86400000)
  return d.toISOString().slice(0, 10)
}

async function findRoot($: any): Promise<string> {
  for (const candidate of ['.', '/home/user/llm-wiki']) {
    const base = candidate === '.' ? '' : `${candidate}/`
    if ((await $.fs.exists(`${base}wiki/index.md`)) && (await $.fs.exists(`${base}log.md`))) {
      return candidate
    }
  }
  throw new Error('LLM Wiki repo not found (looked in the working directory and /home/user/llm-wiki)')
}

const join = (root: string, rel: string) => (root === '.' ? rel : `${root}/${rel}`)

async function listMd($: any, dir: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(dir)
    return entries.filter((x: any) => x.kind === 'file' && x.name.endsWith('.md')).map((x: any) => `${dir}/${x.name}`)
  } catch {
    return []
  }
}

async function walk($: any, dir: string, depth = 4): Promise<string[]> {
  if (depth < 0) return []
  let entries: any[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const x of entries) {
    if (x.name.startsWith('.')) continue
    const p = `${dir}/${x.name}`
    if (x.kind === 'dir') out.push(...(await walk($, p, depth - 1)))
    else if (x.kind === 'file' && x.name.endsWith('.md')) out.push(p)
  }
  return out
}

async function git($: any, root: string, args: string[], timeoutMs = 30000) {
  const init = root === '.' ? { timeoutMs } : { cwd: root, timeoutMs }
  return $.process.run(['git', ...args], init)
}

// ---------- loading ----------

async function loadSnapshot($: any, opts: { fetch?: boolean } = {}): Promise<Snapshot> {
  let root = '.'
  const status: WikiStatus = {
    root: '',
    lastCommit: '—',
    lastCommitAgo: '',
    sync: '—',
    lastDaily: 'none',
    lastWeekly: 'none',
    entities: 0,
    concepts: 0,
    rawFiles: 0,
    loadedAt: Date.now(),
  }
  try {
    root = await findRoot($)
    status.root = root === '.' ? 'working directory' : root

    if (opts.fetch) await git($, root, ['fetch', '-q', '--depth=50', 'origin', 'main'], 60000).catch(() => undefined)
    const log1 = await git($, root, ['log', '-1', '--format=%h|%cr|%s'])
    if (log1.exitCode === 0) {
      const [h, ago, ...subj] = log1.stdout.trim().split('|')
      status.lastCommit = `${h} ${subj.join('|')}`
      status.lastCommitAgo = ago
    }
    const sb = await git($, root, ['status', '-sb', '--porcelain'])
    if (sb.exitCode === 0) {
      const lines = sb.stdout.split('\n').filter(Boolean)
      const head = lines[0] ?? ''
      const ahead = /ahead (\d+)/.exec(head)?.[1]
      const behind = /behind (\d+)/.exec(head)?.[1]
      const dirty = lines.length - 1
      const parts: string[] = []
      if (behind) parts.push(`${behind} behind`)
      if (ahead) parts.push(`${ahead} to push`)
      if (dirty > 0) parts.push(`${dirty} uncommitted`)
      status.sync = parts.length ? parts.join(', ') : 'in sync with main'
    }

    const log = await $.fs.read(join(root, 'log.md'))
    for (const m of log.matchAll(/^## (\d{4}-\d{2}-\d{2}) daily/gm)) status.lastDaily = m[1]
    for (const m of log.matchAll(/^## (\d{4}-\d{2}-\d{2}) weekly/gm)) status.lastWeekly = m[1]

    const entities = await listMd($, join(root, 'wiki/entities'))
    const concepts = await listMd($, join(root, 'wiki/concepts'))
    status.entities = entities.length
    status.concepts = concepts.length
    status.rawFiles = (await walk($, join(root, 'raw'))).length

    // open points: unresolved conflicts and red to-dos on wiki pages
    const openPoints: OpenPoint[] = []
    const todos: TodoItem[] = []
    for (const file of [...entities, ...concepts]) {
      const page = file.split('/').pop()!.replace(/\.md$/, '')
      let text = ''
      try {
        text = await $.fs.read(file)
      } catch {
        continue
      }
      let section = ''
      for (const line of text.split('\n')) {
        if (/^##\s/.test(line)) section = line
        if (line.includes('✅')) continue
        const inOpenQuestions = /open questions/i.test(section)
        if (/^>\s*⚠️\s*\*?\*?Conflict/.test(line)) {
          const t = clean(line)
          openPoints.push({ id: hash(page + t), page, text: t, kind: 'conflict' })
        } else if (/🔴\s*\*\*To do/.test(line) || (inOpenQuestions && /^-\s*🔴/.test(line))) {
          const t = clean(line.replace(/^-\s*/, ''))
          openPoints.push({ id: hash(page + t), page, text: t, kind: 'todo' })
        } else if (/Action for Andrea/.test(line)) {
          const t = clean(line.replace(/^-\s*/, '').replace(/🟡\s*/, '').replace(/Action for Andrea:\s*/, ''))
          todos.push({ id: hash(page + t), date: '', text: t, source: page })
        }
      }
    }

    // today's TODOs: Andrea's open action items from recent meeting notes
    const since = isoDaysAgo(TODO_WINDOW_DAYS)
    for (const file of await walk($, join(root, 'raw/meetings'))) {
      const name = file.split('/').pop()!
      const fileDate = /^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1] ?? ''
      let text = ''
      try {
        text = await $.fs.read(file)
      } catch {
        continue
      }
      const title = /^title:\s*"?([^"\n]+)"?/m.exec(text)?.[1] ?? name.replace(/\.md$/, '')
      let date = fileDate
      for (const line of text.split('\n')) {
        const h = /^###\s+(\d{4}-\d{2}-\d{2})/.exec(line)
        if (h && !fileDate) date = h[1] ?? date
        const m = /^- \[ \] Andrea Cavagna\s*[—–-]\s*(.+)$/.exec(line)
        if (m && date && date >= since) {
          const t = clean(m[1] ?? "")
          todos.push({ id: hash(title + date + t), date, text: t, source: title })
        }
      }
    }
    todos.sort((a, b) => (b.date || '9999').localeCompare(a.date || '9999'))

    return { status, openPoints, todos }
  } catch (err: any) {
    status.error = String(err?.message ?? err)
    return { status, openPoints: [], todos: [] }
  }
}

async function refresh($: any, opts: { fetch?: boolean } = {}) {
  await update($, busy, () => true)
  try {
    const snap = await loadSnapshot($, opts)
    await update($, snapshot, () => snap)
  } finally {
    await update($, busy, () => false)
  }
}

async function toggleDone($: any, id: string) {
  const done = ((await $.store.get(DONE_KEY)) as string[] | undefined) ?? []
  const next = done.includes(id) ? done.filter(x => x !== id) : [...done, id]
  await $.store.set(DONE_KEY, next.slice(-500))
}

const ask = ($: any, text: string) => {
  const q = text.trim()
  if (!q) return
  void $.prompt.submit({ text: `ask ${q}`, asUser: true })
}

// ---------- hooks ----------

function textReport(snap: Snapshot, done: string[]): string {
  const s = snap.status
  if (s.error) return `LLM Wiki: ${s.error}`
  const todos = snap.todos.filter(t => !done.includes(t.id))
  const lines: string[] = []
  lines.push('LLM WIKI')
  lines.push(`Status: ${s.sync} · last commit ${cut(s.lastCommit, 70)} (${s.lastCommitAgo})`)
  lines.push(`Last daily ${s.lastDaily} · weekly ${s.lastWeekly} · ${s.entities} entities, ${s.concepts} concepts, ${s.rawFiles} raw sources`)
  lines.push('')
  lines.push(`OPEN POINTS (${snap.openPoints.length})`)
  if (snap.openPoints.length === 0) lines.push('  none')
  snap.openPoints.slice(0, 10).forEach((p, i) =>
    lines.push(`  ${i + 1}. ${p.kind === 'conflict' ? '⚠️' : '🔴'} ${cut(p.text.replace(/^(⚠️|🔴)\s*/, ''), 160)} [${p.page}]`),
  )
  lines.push('')
  lines.push(`TODO (${todos.length}, last ${TODO_WINDOW_DAYS} days)`)
  if (todos.length === 0) lines.push('  ☐ nothing pending')
  todos.slice(0, 12).forEach(t =>
    lines.push(`  ☐ ${cut(t.text, 150)} (${t.date ? t.date.slice(5) + ', ' : ''}${cut(t.source, 50)})`),
  )
  lines.push('')
  lines.push('Ask: /wiki <question>  ·  or just type: ask <question>')
  return lines.join('\n')
}

// ---------- drawing ----------

async function drawPanel($: any, e: any) {
  const { Box, Text, Button, Input } = $.ui.resolve(e) as any
  const snap = await read($, snapshot)
  const isBusy = await read($, busy)
  const done = (((await $.store.get(DONE_KEY)) as string[] | undefined) ?? []) as string[]
  const width = Math.max(24, (e.props as any)?.bodyColumns ?? e.viewport?.columns ?? 60)
  const isWidget = (e.props as any)?.placement === 'widget'
  const maxItems = isWidget ? 3 : 8
  const textLen = Math.max(40, width * 2 - 8)

  if (!snap) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading the wiki…</Text>
      </Box>
    )
  }

  const s = snap.status
  const openTodos = snap.todos.filter(t => !done.includes(t.id))
  const doneTodos = snap.todos.filter(t => done.includes(t.id))
  const conflicts = snap.openPoints.filter(p => p.kind === 'conflict').length

  if (isWidget) {
    return (
      <Box flexDirection="column">
        <Text bold>LLM Wiki</Text>
        <Text dimColor>{s.error ? s.error : `${s.sync} · daily ${s.lastDaily}`}</Text>
        <Text>
          {snap.openPoints.length} open points · {openTodos.length} TODOs
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Status */}
      <Box flexDirection="column">
        <Text bold>Status{isBusy ? ' (refreshing…)' : ''}</Text>
        {s.error ? (
          <Text color="error">{s.error}</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>Last commit </Text>
              {cut(s.lastCommit, textLen)} <Text dimColor>({s.lastCommitAgo})</Text>
            </Text>
            <Text>
              <Text dimColor>Sync </Text>
              {s.sync}
            </Text>
            <Text>
              <Text dimColor>Last daily </Text>
              {s.lastDaily}
              <Text dimColor> · weekly </Text>
              {s.lastWeekly}
            </Text>
            <Text>
              <Text dimColor>Pages </Text>
              {s.entities} entities, {s.concepts} concepts <Text dimColor>· {s.rawFiles} raw sources</Text>
            </Text>
            <Text>
              <Text dimColor>Open </Text>
              {conflicts} conflicts, {snap.openPoints.length - conflicts} red to-dos, {openTodos.length} TODOs
            </Text>
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" onPress={() => void refresh($, { fetch: true })}>
            Refresh
          </Button>
          <Button
            key="daily"
            onPress={() =>
              void $.prompt.submit({
                text: 'Run the daily routine from CLAUDE.md now (pull first, then Gmail meetings, Notion, Jira CM, Slack, light lint, commit and push).',
                asUser: true,
              })
            }
          >
            Run daily
          </Button>
          <Button key="lint" onPress={() => void $.prompt.submit({ text: 'lint', asUser: true })}>
            Lint
          </Button>
        </Box>
      </Box>

      {/* Ask */}
      <Box flexDirection="column">
        <Text bold>Ask the wiki</Text>
        <Input
          key="ask"
          placeholder="e.g. what is still blocking Cuisine GA?"
          submitLabel="ask"
          value=""
          onSubmit={(value: string) => ask($, value)}
        />
      </Box>

      {/* Open points */}
      <Box flexDirection="column">
        <Text bold>Open points ({snap.openPoints.length})</Text>
        {snap.openPoints.length === 0 && <Text dimColor>None. 🎉</Text>}
        {snap.openPoints.slice(0, maxItems).map(p => (
          <Button
            key={`op-${p.id}`}
            plain
            onPress={() =>
              void $.prompt.submit({
                text: `Help me resolve this open point from wiki page "${p.page}": ${p.text}`,
                asUser: true,
              })
            }
          >
            {p.kind === 'conflict' ? '⚠️ ' : '🔴 '}
            {cut(p.text.replace(/^⚠️\s*/, '').replace(/^🔴\s*/, ''), textLen)} <Text dimColor>· {p.page}</Text>
          </Button>
        ))}
        {snap.openPoints.length > maxItems && (
          <Text dimColor>+{snap.openPoints.length - maxItems} more</Text>
        )}
      </Box>

      {/* TODO */}
      <Box flexDirection="column">
        <Text bold>TODO ({openTodos.length})</Text>
        <Text dimColor>Your action items from the last {TODO_WINDOW_DAYS} days of meetings and wiki pages. Press to tick.</Text>
        {openTodos.length === 0 && <Text dimColor>☐ nothing pending</Text>}
        {openTodos.slice(0, maxItems).map(t => (
          <Button key={`todo-${t.id}`} plain onPress={() => void toggleDone($, t.id)}>
            ☐ {cut(t.text, textLen)}{' '}
            <Text dimColor>
              · {t.date ? `${t.date.slice(5)} ` : ''}
              {cut(t.source, 40)}
            </Text>
          </Button>
        ))}
        {openTodos.length > maxItems && <Text dimColor>+{openTodos.length - maxItems} more</Text>}
        {doneTodos.slice(0, 3).map(t => (
          <Button key={`done-${t.id}`} plain dimColor onPress={() => void toggleDone($, t.id)}>
            ☑ {cut(t.text, textLen)}
          </Button>
        ))}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wiki',
      description: 'LLM Wiki: status, open points and TODOs; /wiki <question> asks the wiki',
      argumentHint: '[question]',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'wiki' }, async ($, e) => {
    const question = (e.args ?? '').trim()
    if (question) {
      ask($, question)
      return { text: `Asking the wiki: ${question}` }
    }
    await refresh($)
    const opened: any = await $.ui.open({ id: PANE, title: TITLE })
    const snap = await read($, snapshot)
    const done = (((await $.store.get(DONE_KEY)) as string[] | undefined) ?? []) as string[]
    const report = snap ? textReport(snap, done) : 'LLM Wiki: still loading, run /wiki again.'
    const where = opened?.isPlaced ? '\n\n(Sidebar opened beside the chat.)' : ''
    return { text: report + where }
  })

  // files change during a turn (ingests, commits): reload when it ends
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPanel($, e))

  // fallback for apps that don't seat side panes: draw the panel inline under /wiki
  on('ui.render', { component: 'CommandOutput', props: { command: 'wiki' } }, async ($, e) => drawPanel($, e))

}
