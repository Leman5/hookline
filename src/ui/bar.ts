// The fixed player bar at the bottom of every screen.
import { saveSettings, settings } from '../library.ts';
import type { Player } from '../player.ts';
import { h, mmss } from './dom.ts';

export function mountBar(root: HTMLElement, player: Player, ytHost: HTMLElement): () => void {
  const title = h('div', { class: 'bar-title' });
  const sub = h('div', { class: 'bar-sub' });
  const fill = h('div', { class: 'bar-fill' });
  const time = h('span', { class: 'bar-time' });
  const progress = h('div', {
    class: 'bar-progress',
    onclick: (e: MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const { len } = player.position();
      if (len > 0) player.seek(((e.clientX - r.left) / r.width) * len);
    },
  }, fill);
  const playBtn = h('button', { class: 'btn-icon big', 'aria-label': 'Play or pause', onclick: () => player.toggle() });
  const mode = h('button', {
    class: 'chip',
    onclick: async () => {
      await saveSettings({ mode: settings.mode === 'highlights' ? 'full' : 'highlights' });
      player.refreshQueue();
      render();
    },
  });
  root.append(
    ytHost,
    h('div', { class: 'bar-info' }, title, sub),
    h('div', { class: 'bar-row' }, progress, time),
    h(
      'div',
      { class: 'bar-controls' },
      mode,
      h('button', { class: 'btn-icon', 'aria-label': 'Previous', text: '⏮', onclick: () => void player.prev() }),
      playBtn,
      h('button', { class: 'btn-icon', 'aria-label': 'Next', text: '⏭', onclick: () => void player.next(false) }),
      h('a', { class: 'chip', href: '#/queue', text: 'Queue' }),
    ),
  );

  function render(): void {
    const item = player.current;
    ytHost.classList.toggle('off', !player.ytVisible);
    root.hidden = !item && !player.ytVisible;
    if (!item) return;
    const part = item.parts > 1 ? ` · part ${item.part + 1}/${item.parts}` : '';
    const via = player.route === 'yt' ? 'full song' : item.track.source === 'preview' ? '30 s preview' : 'your file';
    title.textContent = item.track.title;
    sub.textContent = player.ytAd
      ? 'YouTube ad, then the next full song (tap Skip when YouTube offers it)'
      : `${item.track.artist}${part} · ${item.list === 'gym' ? 'Gym' : 'Commute'} · ${via}`;
    const { pos, len } = player.position();
    fill.style.width = len > 0 ? `${Math.min(100, (100 * pos) / len)}%` : '0';
    time.textContent = `${mmss(pos)} / ${mmss(len)}`;
    playBtn.textContent = player.wantPlaying ? '⏸' : '▶';
    mode.textContent = settings.mode === 'highlights' ? 'Highlights' : 'Full songs';
  }
  render();
  return render;
}
