import './styles.css';
import { log } from './debuglog.ts';
import { load, refreshPreviews, tracks } from './library.ts';
import { Player } from './player.ts';
import { on } from './state.ts';
import { LISTS, type ListId } from './types.ts';
import { mountBar } from './ui/bar.ts';
import { toast } from './ui/dom.ts';
import { editorView } from './ui/editor.ts';
import { debugView, homeView, loadSeed, playlistView, queueView, settingsView } from './ui/views.ts';

const app = document.getElementById('app')!;
const barEl = document.getElementById('bar')!;
const ytHost = document.createElement('div');
ytHost.className = 'yt off';
const player = new Player(document.body, ytHost);
const renderBar = mountBar(barEl, player, ytHost);

function route(): HTMLElement {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (parts[0]) {
    case 'p':
      if (LISTS.includes(parts[1] as ListId)) return playlistView(parts[1] as ListId, player);
      break;
    case 't':
      return editorView(parts[1], LISTS.includes(parts[2] as ListId) ? (parts[2] as ListId) : 'commute', player, parts[3] === 'yt' ? 'yt' : 'audio');
    case 'queue':
      return queueView(player);
    case 'settings':
      return settingsView(player);
    case 'debug':
      return debugView();
  }
  return homeView(player);
}

function render(): void {
  // Keep the editor stable while the user drags; it re-renders itself.
  const y = scrollY;
  app.replaceChildren(route());
  scrollTo(0, y);
}

let lastTrack: string | undefined;
on('player', () => {
  renderBar();
  const id = player.current?.track.id;
  if (id !== lastTrack) {
    lastTrack = id;
    if (/^#\/(p|queue)/.test(location.hash)) render();
  }
});
on('library', () => {
  if (!location.hash.startsWith('#/t/')) render();
  renderBar();
});
on('log', () => {
  if (location.hash === '#/debug') render();
});
/** A "#seed=..." link loads the private song list, then the hash is cleared so it is not bookmarked. */
async function takeSeed(): Promise<boolean> {
  if (!location.hash.startsWith('#seed=')) return false;
  const seed = location.hash.slice(6);
  history.replaceState(null, '', location.pathname + location.search + '#/');
  await loadSeed(seed);
  return true;
}

addEventListener('hashchange', async () => {
  if (await takeSeed()) return;
  render();
  scrollTo(0, 0);
});

async function boot(): Promise<void> {
  await load();
  if (!(await takeSeed())) void refreshPreviews();
  render();
  if ([...tracks.values()].some((t) => t.youtubeId)) player.preloadYouTube();
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch((e) => log('sw', String(e)));
  }
  log('boot', `${navigator.userAgent}`);
}

boot().catch((e) => {
  toast(`Startup failed: ${e?.message ?? e}`);
  log('error', String(e));
});
