export type ListId = 'commute' | 'gym';
export const LISTS: readonly ListId[] = ['commute', 'gym'];

/** One playable highlight window, in seconds of the source audio. end < 0 means "to the end of the media". */
export interface Segment {
  start: number;
  end: number;
}

export interface Track {
  /** 'it:<itunesId>' for previews, 'f:<sha256>' for imported files. */
  id: string;
  title: string;
  artist: string;
  list: ListId;
  /** The user moved this track by hand; auto-assignment must not move it back. */
  pinned?: boolean;
  source: 'preview' | 'file';
  itunesId?: number;
  previewUrl?: string;
  appleUrl?: string;
  artwork?: string;
  /** Imported file: content hash (key into the blob and analysis stores). */
  hash?: string;
  /** Imported file: the preview track it replaces, when matched to a seed. */
  replaces?: string;
  /** Preview track hidden because an imported file replaced it. */
  hidden?: boolean;
  duration?: number;
  /** YouTube video with the full song, played while the screen is on. */
  youtubeId?: string;
  /** Other uploads of the same song, tried when YouTube refuses to embed the first. */
  youtubeAlt?: string[];
  /** Length of that video in seconds. */
  ytDuration?: number;
  /** The chorus in that video (seconds), found from time-synced lyrics when the seed was built. */
  ytHook?: Segment;
  /** The video failed to play (removed, embedding disabled); skip YouTube for this track. */
  ytBroken?: boolean;
  addedAt: number;
}

export interface Analysis {
  version: number;
  duration: number;
  bpm: number;
  bpmConfidence: number;
  /** false when the tempo was unclear and segments use a plain 0.5 s grid. */
  confident: boolean;
  energy: number;
  /** One loudness value (0..100) per second, for the heat strip. */
  heat: number[];
  /** Downbeat times (s), used to snap edited segment handles. */
  bars: number[];
  segments: Record<ListId, Segment[]>;
}

export interface ListProfile {
  minLen: number;
  maxLen: number;
  target: number;
  maxSegments: number;
  crossfade: number;
  wLoud: number;
  wRep: number;
  wOnset: number;
}

export const PROFILES: Record<ListId, ListProfile> = {
  commute: { minLen: 30, maxLen: 60, target: 45, maxSegments: 1, crossfade: 1.2, wLoud: 0.35, wRep: 0.35, wOnset: 0.1 },
  gym: { minLen: 20, maxLen: 45, target: 30, maxSegments: 2, crossfade: 0.8, wLoud: 0.3, wRep: 0.25, wOnset: 0.25 },
};
