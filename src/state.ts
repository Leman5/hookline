// Tiny pub/sub so views re-render when the library or player changes.
export type Topic = 'library' | 'player' | 'log';
const subs = new Map<Topic, Set<() => void>>();

export function on(topic: Topic, fn: () => void): () => void {
  let s = subs.get(topic);
  if (!s) subs.set(topic, (s = new Set()));
  s.add(fn);
  return () => s!.delete(fn);
}

let pending = new Set<Topic>();
let scheduled = false;
/** Coalesces bursts of events into one notification per topic per frame. */
export function emit(topic: Topic): void {
  pending.add(topic);
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    const topics = pending;
    pending = new Set();
    for (const t of topics) for (const fn of subs.get(t) ?? []) fn();
  };
  // rAF does not run while the screen is locked; a microtask keeps state consistent there.
  if (document.visibilityState === 'visible') requestAnimationFrame(flush);
  else queueMicrotask(flush);
}
