// Ring buffer of playback events, kept in localStorage so a locked-phone session can be inspected afterwards.
import { emit } from './state.ts';

export interface LogEntry {
  t: number;
  kind: string;
  msg: string;
}

const KEY = 'hookline-log';
const MAX = 400;
let entries: LogEntry[] = [];
try {
  entries = JSON.parse(localStorage.getItem(KEY) ?? '[]');
} catch {
  entries = [];
}

let saveTimer: number | undefined;
export function log(kind: string, msg: string): void {
  entries.push({ t: Date.now(), kind, msg });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      /* storage full or blocked: the log is best effort */
    }
  }, 1000) as unknown as number;
  emit('log');
}

export function logEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit('log');
}
