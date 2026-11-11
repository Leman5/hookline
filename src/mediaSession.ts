// Lock-screen / notification controls through the Media Session API.
export interface MediaControls {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  /** Seek to a position relative to the current highlight. */
  seek(rel: number): void;
  /** Current position and length of the highlight, for relative seeks. */
  position(): { pos: number; len: number };
}

const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;

export function bindControls(c: MediaControls): void {
  if (!ms) return;
  const set = (a: MediaSessionAction, h: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(a, h);
    } catch {
      /* action not supported on this browser */
    }
  };
  set('play', () => c.play());
  set('pause', () => c.pause());
  set('nexttrack', () => c.next());
  set('previoustrack', () => c.prev());
  set('seekto', (d) => d.seekTime !== undefined && c.seek(d.seekTime));
  set('seekforward', (d) => c.seek(c.position().pos + (d.seekOffset ?? 10)));
  set('seekbackward', (d) => c.seek(c.position().pos - (d.seekOffset ?? 10)));
  set('stop', () => c.pause());
}

export function setMetadata(title: string, artist: string, album: string, artwork?: string): void {
  if (!ms) return;
  const art = artwork
    ? [
        { src: artwork, sizes: '512x512', type: artwork.includes('.png') ? 'image/png' : 'image/jpeg' },
      ]
    : [
        { src: new URL('./icons/icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' },
        { src: new URL('./icons/icon-192.png', document.baseURI).href, sizes: '192x192', type: 'image/png' },
      ];
  ms.metadata = new MediaMetadata({ title, artist, album, artwork: art });
}

export function setPlaybackState(playing: boolean): void {
  if (ms) ms.playbackState = playing ? 'playing' : 'paused';
}

export function setPosition(pos: number, len: number): void {
  if (!ms?.setPositionState || !(len > 0)) return;
  try {
    ms.setPositionState({ duration: len, position: Math.min(len, Math.max(0, pos)), playbackRate: 1 });
  } catch {
    /* invalid state during loading; next update fixes it */
  }
}
