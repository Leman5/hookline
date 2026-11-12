// Screens: home, playlist, queue, settings, debug.
import { clearLog, logEntries } from '../debuglog.ts';
import {
  analysisOf,
  applySeed,
  importFiles,
  moveTrack,
  refreshPreviews,
  removeTrack,
  resetHistory,
  saveSettings,
  segmentsFor,
  settings,
  ytSegmentFor,
  tracks,
  visible,
  type ImportProgress,
} from '../library.ts';
import type { Player } from '../player.ts';
import { LISTS, type ListId, type Track } from '../types.ts';
import { h, mmss, toast } from './dom.ts';

const NAMES: Record<ListId, string> = { commute: 'Commute', gym: 'Gym' };
const BLURB: Record<ListId, string> = { commute: 'Calm and slow, for the ride in', gym: 'High energy, for heavy sets' };

function highlightSeconds(t: Track, list: ListId): number {
  const yt = settings.youtube && t.source === 'preview' ? ytSegmentFor(t, list) : undefined;
  if (yt) return yt.end - yt.start;
  return segmentsFor(t, list).reduce((s, g) => s + ((g.end > 0 ? g.end : (t.source === 'preview' ? 30 : (t.duration ?? 0))) - g.start), 0);
}

const spotifyUrl = (t: Track) => `https://open.spotify.com/search/${encodeURIComponent(`${t.title} ${t.artist}`)}`;

export function homeView(player: Player): HTMLElement {
  const anyTracks = [...tracks.values()].some((t) => !t.hidden);
  const cards = LISTS.map((l) => {
    const ts = visible(l);
    const mins = Math.round(ts.reduce((s, t) => s + highlightSeconds(t, l), 0) / 60);
    return h(
      'section',
      { class: `card card-${l}` },
      h('a', { class: 'card-link', href: `#/p/${l}` }, h('h2', { text: NAMES[l] }), h('p', { class: 'muted', text: BLURB[l] }), h('p', { class: 'meta', text: `${ts.length} ${ts.length === 1 ? 'song' : 'songs'} · ${mins} min of highlights` })),
      h('button', { class: 'btn primary', disabled: !ts.length, onclick: () => void player.start(l), text: '▶ Play' }),
    );
  });
  return h(
    'div',
    { class: 'view' },
    h('header', { class: 'top' }, h('h1', { text: 'Hookline' }), h('a', { class: 'chip', href: '#/settings', text: 'Settings' })),
    anyTracks ? null : seedBox(),
    ...cards,
    importBox(),
    attribution(),
  );
}

function seedBox(): HTMLElement {
  const input = h('input', { type: 'url', placeholder: 'Paste your seed link', class: 'input' });
  return h(
    'section',
    { class: 'card' },
    h('h2', { text: 'Load your songs' }),
    h('p', { class: 'muted', text: 'Open your private seed link on this phone, or paste it here. Songs play as free 30-second previews until you add your own files.' }),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', text: 'Load', onclick: () => void loadSeed(input.value) })),
  );
}

export async function loadSeed(value: string): Promise<void> {
  const raw = value.includes('#seed=') ? value.split('#seed=')[1] : value.replace(/^seed=/, '');
  try {
    const n = await applySeed(raw.trim());
    toast(`Loaded ${n} songs`);
    void navigator.storage?.persist?.();
  } catch (e) {
    toast((e as Error).message);
  }
}

// Import progress lives outside the view so re-renders during an import keep it.
const importStatus = new Map<string, string>();
function renderProgress(list: HTMLElement): void {
  list.replaceChildren(...[...importStatus].map(([name, status]) => h('li', { text: `${name} — ${status}` })));
}

function importBox(): HTMLElement {
  const list = h('ul', { class: 'progress', id: 'import-progress' });
  renderProgress(list);
  const onProgress = (p: ImportProgress) => {
    importStatus.set(p.name, p.status);
    const live = document.getElementById('import-progress');
    if (live) renderProgress(live);
  };
  const input = h('input', {
    type: 'file',
    accept: 'audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav',
    multiple: true,
    hidden: true,
    onchange: async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      importStatus.clear();
      void navigator.storage?.persist?.();
      await importFiles(files, onProgress);
      toast('Import finished');
      input.value = '';
    },
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', { text: 'Your own music files' }),
    h('p', { class: 'muted', text: 'Optional. Files stay on this phone. They get full-song highlight detection and replace the matching preview.' }),
    h('button', { class: 'btn', text: '+ Add music files', onclick: () => input.click() }),
    input,
    list,
  );
}

function attribution(): HTMLElement | null {
  if (![...tracks.values()].some((t) => t.source === 'preview' && !t.hidden)) return null;
  return h('p', { class: 'fine', text: 'Full songs play in the YouTube player while the screen is on. Song previews provided courtesy of iTunes / Apple Music. Tap ↗ on a song to open it in Apple Music or Spotify.' });
}

export function playlistView(list: ListId, player: Player): HTMLElement {
  const ts = visible(list);
  const playing = player.current?.track.id;
  const rows = ts.map((t) => {
    const a = analysisOf(t);
    const segs = segmentsFor(t, list);
    const yt = settings.youtube && t.source === 'preview' ? ytSegmentFor(t, list) : undefined;
    const chips = yt
      ? [h('span', { class: 'seg', text: `${t.ytHook ? 'chorus' : 'guessed'} ${mmss(yt.start)}–${mmss(yt.end)}` }), h('span', { class: 'seg alt', text: 'locked: 30 s preview' })]
      : segs.map((s) =>
          h('span', { class: 'seg', text: s.end > 0 ? `${mmss(s.start)}–${mmss(s.end)}` : t.source === 'preview' ? 'preview clip' : 'whole song' }),
        );
    const meta = [
      t.source === 'file' ? 'Your file' : yt ? 'YouTube + preview' : 'Preview',
      a?.bpm ? `${Math.round(a.bpm)} BPM` : null,
      a ? `energy ${a.energy}` : null,
      a && !a.confident ? 'beat unclear' : null,
    ].filter(Boolean).join(' · ');
    return h(
      'li',
      { class: `track${t.id === playing ? ' now' : ''}` },
      h(
        'button',
        { class: 'track-main', onclick: () => void player.start(list, t.id) },
        h('span', { class: 'track-title', text: t.title }),
        h('span', { class: 'track-artist', text: t.artist }),
        h('span', { class: 'track-meta', text: meta }),
        h('span', { class: 'segs' }, ...chips),
      ),
      h(
        'div',
        { class: 'track-actions' },
        h('a', { class: 'chip', href: `#/t/${encodeURIComponent(t.id)}/${list}${yt ? '/yt' : ''}`, text: 'Edit' }),
        h('button', {
          class: 'chip',
          text: list === 'gym' ? '→ Commute' : '→ Gym',
          onclick: async () => {
            await moveTrack(t.id);
            player.refreshQueue();
          },
        }),
        t.appleUrl ? h('a', { class: 'chip', href: t.appleUrl, target: '_blank', rel: 'noopener', text: 'Apple ↗' }) : null,
        h('a', { class: 'chip', href: spotifyUrl(t), target: '_blank', rel: 'noopener', text: 'Spotify ↗' }),
      ),
    );
  });
  return h(
    'div',
    { class: 'view' },
    h('header', { class: 'top' }, h('a', { class: 'chip', href: '#/', text: '← Back' }), h('h1', { text: NAMES[list] })),
    h('button', { class: 'btn primary wide', disabled: !ts.length, onclick: () => void player.start(list), text: `▶ Shuffle ${ts.length} ${ts.length === 1 ? 'song' : 'songs'}` }),
    ts.length ? h('ul', { class: 'tracks' }, ...rows) : h('p', { class: 'muted', text: 'No songs here yet. Load your seed link or add files on the home screen.' }),
    attribution(),
  );
}

export function queueView(player: Player): HTMLElement {
  const items = player.queue.slice(Math.max(0, player.idx), player.idx + 40);
  return h(
    'div',
    { class: 'view' },
    h('header', { class: 'top' }, h('a', { class: 'chip', href: '#/', text: '← Back' }), h('h1', { text: 'Up next' })),
    items.length
      ? h(
          'ol',
          { class: 'tracks' },
          ...items.map((q, i) =>
            h(
              'li',
              { class: `track${i === 0 ? ' now' : ''}` },
              h(
                'button',
                { class: 'track-main', onclick: () => void player.jump(player.idx + i) },
                h('span', { class: 'track-title', text: q.track.title }),
                h('span', { class: 'track-artist', text: `${q.track.artist}${q.parts > 1 ? ` · part ${q.part + 1}/${q.parts}` : ''}` }),
                h('span', { class: 'segs' }, h('span', { class: 'seg', text: q.seg.end > 0 ? `${mmss(q.seg.start)}–${mmss(q.seg.end)}` : 'clip' })),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted', text: 'Nothing queued. Start a playlist.' }),
  );
}

export function settingsView(player: Player): HTMLElement {
  const toggle = (label: string, value: boolean, onchange: (v: boolean) => Promise<void>) =>
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: value, onchange: (e: Event) => void onchange((e.target as HTMLInputElement).checked) }), h('span', { text: label }));
  const storage = h('p', { class: 'muted', text: 'Checking storage…' });
  void (async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    storage.textContent = `Using ${((est?.usage ?? 0) / 1e6).toFixed(0)} MB of ${((est?.quota ?? 0) / 1e9).toFixed(1)} GB. ${persisted ? 'Storage is persistent.' : 'Storage may be cleared by the browser if space runs low; install the app to make it persistent.'}`;
  })();
  const seedInput = h('input', { type: 'url', placeholder: 'Paste a seed link', class: 'input' });
  const files = [...tracks.values()].filter((t) => t.source === 'file');
  return h(
    'div',
    { class: 'view' },
    h('header', { class: 'top' }, h('a', { class: 'chip', href: '#/', text: '← Back' }), h('h1', { text: 'Settings' })),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Playback' }),
      toggle('Play highlights only (off = full songs)', settings.mode === 'highlights', async (v) => {
        await saveSettings({ mode: v ? 'highlights' : 'full' });
        player.refreshQueue();
      }),
      toggle('Crossfade between songs', settings.crossfade, (v) => saveSettings({ crossfade: v })),
      toggle('Full songs from YouTube while the screen is on (switches to previews when locked)', settings.youtube, async (v) => {
        await saveSettings({ youtube: v });
        if (v) player.preloadYouTube();
        player.refreshQueue();
      }),
      toggle('Use free Apple previews for songs without a file', settings.previews, async (v) => {
        await saveSettings({ previews: v });
        player.refreshQueue();
      }),
      h('button', { class: 'btn', text: 'Forget what played today (24 h no-repeat)', onclick: () => { resetHistory(); toast('History cleared'); } }),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Songs' }),
      h('div', { class: 'row' }, seedInput, h('button', { class: 'btn', text: 'Load', onclick: () => void loadSeed(seedInput.value) })),
      h('button', { class: 'btn', text: 'Refresh preview links', onclick: async () => { await refreshPreviews(true); toast('Previews refreshed'); } }),
      files.length
        ? h('details', null, h('summary', { text: `Imported files (${files.length})` }), h('ul', { class: 'plain' }, ...files.map((t) => h('li', null, `${t.title} — ${t.artist} `, h('button', { class: 'chip', text: 'Remove', onclick: () => void removeTrack(t.id) })))))
        : null,
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Phone tips' }),
      h('p', { class: 'muted', text: 'Install: Chrome menu ⋮ → Add to Home screen. On Oppo/ColorOS: Settings → Apps → Chrome → Battery usage → allow background activity, so music keeps playing with the screen locked.' }),
      storage,
      h('a', { class: 'chip', href: '#/debug', text: 'Playback log' }),
    ),
  );
}

export function debugView(): HTMLElement {
  const rows = [...logEntries()].reverse().slice(0, 300);
  return h(
    'div',
    { class: 'view' },
    h('header', { class: 'top' }, h('a', { class: 'chip', href: '#/settings', text: '← Back' }), h('h1', { text: 'Playback log' })),
    h('button', { class: 'btn', text: 'Clear', onclick: () => clearLog() }),
    h('ul', { class: 'log' }, ...rows.map((e) => h('li', null, h('time', { text: new Date(e.t).toLocaleTimeString() }), ` ${e.kind}: ${e.msg}`))),
  );
}
