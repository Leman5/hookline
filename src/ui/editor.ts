// Per-track highlight editor: a heat strip with draggable segment handles snapped to bars.
import { analysisOf, overrides, segmentsFor, setOverride, tracks, ytKey, ytSegmentFor } from '../library.ts';
import type { Player } from '../player.ts';
import type { ListId, Segment } from '../types.ts';
import { h, mmss, toast } from './dom.ts';

const MIN_LEN = 5;

export function editorView(id: string, list: ListId, player: Player, kind: 'audio' | 'yt' = 'audio'): HTMLElement {
  const t = tracks.get(id);
  if (!t) return h('div', { class: 'view' }, h('p', { text: 'Song not found.' }), h('a', { class: 'chip', href: '#/', text: '← Home' }));
  const isYt = kind === 'yt' && !!t.youtubeId;
  // YouTube hooks have no audio analysis (no heat strip or bars); they are edited by time only.
  const a = isYt ? undefined : analysisOf(t);
  const key = isYt ? ytKey(id) : id;
  const duration = isYt ? (t.ytDuration ?? 240) : (a?.duration ?? (t.source === 'preview' ? 30 : (t.duration ?? 30)));
  const initial = isYt ? [ytSegmentFor(t, list, 'highlights')!] : segmentsFor(t, list, 'highlights');
  let segs: Segment[] = initial.map((s) => ({ start: s.start, end: s.end > 0 ? s.end : duration }));
  const custom = !!overrides.get(key)?.[list]?.length;

  const step = isYt ? 5 : 0.5;
  const canvas = h('canvas', { class: 'strip', height: '96' });
  const listEl = h('div', { class: 'seg-list' });
  let drag: { i: number; edge: 'start' | 'end' } | null = null;

  const x2t = (x: number) => (x / canvas.clientWidth) * duration;
  const t2x = (s: number) => (s / duration) * canvas.clientWidth;
  const snap = (s: number) => {
    const bars = a?.bars ?? [];
    let best = s;
    for (const b of bars) if (Math.abs(b - s) < Math.abs(best - s) && Math.abs(b - s) < 0.6) best = b;
    return Math.round(Math.max(0, Math.min(duration, best)) * 100) / 100;
  };

  function draw(): void {
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const hgt = (canvas.height = 96 * devicePixelRatio);
    const c = canvas.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    c.clearRect(0, 0, w, hgt);
    const heat = a?.heat ?? [];
    c.fillStyle = css.getPropertyValue('--strip').trim() || '#d6d3cd';
    if (heat.length) {
      const bw = w / heat.length;
      heat.forEach((v, i) => {
        const bh = Math.max(2, (v / 100) * (hgt - 8));
        c.fillRect(i * bw, hgt - bh, Math.max(1, bw - 0.5), bh);
      });
    } else c.fillRect(0, hgt / 2 - 2, w, 4);
    const accent = css.getPropertyValue('--accent').trim() || '#ff5a36';
    for (const s of segs) {
      const x0 = (s.start / duration) * w, x1 = (s.end / duration) * w;
      c.fillStyle = accent + '33';
      c.fillRect(x0, 0, x1 - x0, hgt);
      c.fillStyle = accent;
      c.fillRect(x0 - 2 * devicePixelRatio, 0, 4 * devicePixelRatio, hgt);
      c.fillRect(x1 - 2 * devicePixelRatio, 0, 4 * devicePixelRatio, hgt);
    }
  }

  function renderList(): void {
    listEl.replaceChildren(
      ...segs.map((s, i) =>
        h(
          'div',
          { class: 'seg-row' },
          h('span', { class: 'seg', text: `${mmss(s.start)}–${mmss(s.end)} (${Math.round(s.end - s.start)} s)` }),
          h('button', { class: 'chip', text: 'start −', onclick: () => nudge(i, 'start', -step) }),
          h('button', { class: 'chip', text: 'start +', onclick: () => nudge(i, 'start', step) }),
          h('button', { class: 'chip', text: 'end −', onclick: () => nudge(i, 'end', -step) }),
          h('button', { class: 'chip', text: 'end +', onclick: () => nudge(i, 'end', step) }),
          segs.length > 1 ? h('button', { class: 'chip', text: 'Delete', onclick: () => { segs.splice(i, 1); update(); } }) : null,
        ),
      ),
    );
  }

  function clampSeg(i: number): void {
    const s = segs[i];
    const prevEnd = i > 0 ? segs[i - 1].end : 0;
    const nextStart = i < segs.length - 1 ? segs[i + 1].start : duration;
    s.start = Math.max(prevEnd, Math.min(s.start, s.end - MIN_LEN));
    s.end = Math.min(nextStart, Math.max(s.end, s.start + MIN_LEN));
  }

  function nudge(i: number, edge: 'start' | 'end', d: number): void {
    segs[i][edge] = Math.round((segs[i][edge] + d) * 100) / 100;
    clampSeg(i);
    update();
  }

  function update(): void {
    draw();
    renderList();
  }

  canvas.addEventListener('pointerdown', (e) => {
    const x = e.offsetX;
    let best: typeof drag = null, bestD = 18;
    segs.forEach((s, i) => {
      for (const edge of ['start', 'end'] as const) {
        const d = Math.abs(t2x(s[edge]) - x);
        if (d < bestD) { bestD = d; best = { i, edge }; }
      }
    });
    drag = best;
    if (drag) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    segs[drag.i][drag.edge] = snap(x2t(e.offsetX));
    clampSeg(drag.i);
    update();
  });
  canvas.addEventListener('pointerup', () => (drag = null));

  const add = () => {
    if (isYt) return toast('Full songs from YouTube play one hook');
    const last = segs[segs.length - 1];
    const start = last ? Math.min(duration - MIN_LEN, last.end + 5) : 0;
    if (start + MIN_LEN > duration) return toast('No room for another highlight');
    segs.push({ start: snap(start), end: Math.min(duration, start + 20) });
    update();
  };
  const save = async (play: boolean) => {
    await setOverride(key, list, segs.map((s) => ({ ...s })));
    player.refreshQueue();
    toast('Highlights saved');
    if (play) void player.start(list, id);
  };

  const view = h(
    'div',
    { class: 'view' },
    h('header', { class: 'top' }, h('a', { class: 'chip', href: `#/p/${list}`, text: '← Back' }), h('h1', { text: 'Highlights' })),
    h('p', null, h('strong', { text: t.title }), ` — ${t.artist}`),
    isYt
      ? h('p', { class: 'muted', text: `Full song on YouTube · ${mmss(duration)}${custom ? ' · edited by you' : ' · typical hook position, adjust if it starts off'}` })
      : h('p', { class: 'muted', text: a ? `${a.bpm ? `${Math.round(a.bpm)} BPM · ` : ''}energy ${a.energy} · ${mmss(duration)}${custom ? ' · edited by you' : ' · detected automatically'}` : t.source === 'preview' ? 'Free 30-second preview. Trim it if it starts slowly.' : '' }),
    canvas,
    h('p', { class: 'fine', text: isYt ? 'Drag the orange edges, or nudge 5 s at a time.' : 'Drag the orange edges. They snap to bar lines.' }),
    t.youtubeId && !isYt && t.source === 'preview' ? h('a', { class: 'chip', href: `#/t/${encodeURIComponent(id)}/${list}/yt`, text: 'Edit the full-song hook instead' }) : null,
    listEl,
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn primary', text: 'Save & play', onclick: () => void save(true) }),
      h('button', { class: 'btn', text: 'Save', onclick: () => void save(false) }),
      isYt ? null : h('button', { class: 'btn', text: '+ Add highlight', onclick: add }),
      custom
        ? h('button', {
            class: 'btn',
            text: 'Reset to automatic',
            onclick: async () => {
              await setOverride(key, list, null);
              player.refreshQueue();
              location.hash = `#/p/${list}`;
            },
          })
        : null,
    ),
  );
  requestAnimationFrame(update);
  return view;
}
