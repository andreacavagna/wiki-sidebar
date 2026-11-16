export type WikiStatus = {
  root: string
  lastCommit: string
  lastCommitAgo: string
  sync: string
  lastDaily: string
  lastWeekly: string
  entities: number
  concepts: number
  rawFiles: number
  loadedAt: number
  error?: string
}

export type OpenPoint = { id: string; page: string; text: string; kind: 'conflict' | 'todo' }

export type TodoItem = { id: string; date: string; text: string; source: string }

export type Snapshot = {
  status: WikiStatus
  openPoints: OpenPoint[]
  todos: TodoItem[]
}

declare module 'claude-code' {
  interface PluginState {
    'wiki-sidebar': {
      snapshot: Shaped<Snapshot | null>
      busy: boolean
    }
  }
}
