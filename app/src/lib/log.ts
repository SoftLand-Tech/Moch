import { atom } from 'nanostores'

// Typed here because scripts/ (tsconfig.scripts.json) compiles this module
// outside the React Native types that normally declare the global.
declare const __DEV__: boolean

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  tag: string
  msg: string
}

const MAX = 200

export const diagLog = atom<LogEntry[]>([])

export function log(level: LogEntry['level'], tag: string, msg: string) {
  const list = [...diagLog.get(), { ts: Date.now(), level, tag, msg: String(msg).slice(0, 500) }]
  diagLog.set(list.slice(-MAX))
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // Deliberately console.log for every level.
    //
    // In React Native, `console.warn` and `console.error` open a blocking
    // LogBox overlay that covers the app until dismissed. This app logs
    // routine, expected conditions (socket retrying, unencrypted ws on a LAN,
    // a benign resume fallback), so mirroring them to warn/error made the app
    // unusable in development — you could not tap anything without clearing a
    // red box first.
    //
    // The real diagnostics channel is the in-app buffer above, readable via
    // Settings -> "Copy diagnostics", which keeps the level for every entry.
    console.log(`[${level}] [${tag}] ${msg}`)
  }
}

export function logText(): string {
  return diagLog
    .get()
    .map((e) => `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.tag}: ${e.msg}`)
    .join('\n')
}
