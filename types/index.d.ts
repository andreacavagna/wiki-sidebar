export type TodoKind = 'slack' | 'notion' | 'artifact'

export type TodoItem = {
  id: string
  text: string
  url: string
  kind: TodoKind
  context: string
  isDone: boolean
  /** YYYY-MM-DD from the line's ✅ mark, '' when unknown */
  doneDate: string
}

export type Snapshot = {
  root: string
  todos: TodoItem[]
  loadedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'wiki-sidebar': {
      snapshot: Shaped<Snapshot | null>
      busy: boolean
      showDone: boolean
    }
  }
}
