// Minimal tag reader for title, artist and cover art: ID3v2 (mp3), MP4 ilst (m4a), FLAC and Ogg Vorbis comments.

export interface Tags {
  title?: string;
  artist?: string;
  cover?: Blob;
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16 = new TextDecoder('utf-16');
const utf16be = new TextDecoder('utf-16be');

const ascii = (b: Uint8Array, o: number, n: number) => latin1.decode(b.subarray(o, o + n));
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const clean = (s: string) => s.replace(/\0+$/g, '').split('\0')[0].trim() || undefined;

export function readTags(buf: ArrayBuffer, fileName: string): Tags {
  const b = new Uint8Array(buf);
  let tags: Tags = {};
  try {
    if (ascii(b, 0, 3) === 'ID3') tags = id3(b);
    else if (ascii(b, 0, 4) === 'fLaC') tags = flac(b);
    else if (ascii(b, 4, 4) === 'ftyp') tags = mp4(b);
    else if (ascii(b, 0, 4) === 'OggS') tags = ogg(b);
  } catch {
    tags = {};
  }
  if (!tags.title || !tags.artist) {
    const base = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/^\d+[\s.\-_]+/, '').replace(/_/g, ' ');
    const m = base.split(/\s+-\s+/);
    if (m.length >= 2) {
      tags.artist ??= m[0].trim();
      tags.title ??= m.slice(1).join(' - ').trim();
    } else tags.title ??= base.trim();
  }
  return tags;
}

function id3(b: Uint8Array): Tags {
  const ver = b[3];
  const size = syncsafe(b, 6);
  const out: Tags = {};
  let o = 10;
  if (b[5] & 0x40) o += ver === 4 ? syncsafe(b, 10) : u32(b, 10) + 4; // extended header
  const end = Math.min(b.length, 10 + size);
  while (o + 10 <= end) {
    const id = ascii(b, o, ver === 2 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let len: number, hdr: number;
    if (ver === 2) {
      len = (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5];
      hdr = 6;
    } else {
      len = ver === 4 ? syncsafe(b, o + 4) : u32(b, o + 4);
      hdr = 10;
    }
    const body = b.subarray(o + hdr, o + hdr + len);
    if (id === 'TIT2' || id === 'TT2') out.title = text(body);
    else if (id === 'TPE1' || id === 'TP1') out.artist = text(body);
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) out.cover = apic(body, ver === 2);
    o += hdr + len;
  }
  return out;
}

function text(body: Uint8Array): string | undefined {
  const enc = body[0];
  const d = body.subarray(1);
  if (enc === 1) return clean(utf16.decode(d));
  if (enc === 2) return clean(utf16be.decode(d));
  if (enc === 3) return clean(utf8.decode(d));
  return clean(latin1.decode(d));
}

function apic(body: Uint8Array, v2: boolean): Blob | undefined {
  const enc = body[0];
  let o = 1, mime: string;
  if (v2) {
    mime = ascii(body, 1, 3).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    o = 4;
  } else {
    const z = body.indexOf(0, 1);
    mime = ascii(body, 1, z - 1) || 'image/jpeg';
    o = z + 1;
  }
  o += 1; // picture type
  // Skip the description, which is NUL-terminated (double NUL for UTF-16).
  if (enc === 1 || enc === 2) {
    while (o + 1 < body.length && !(body[o] === 0 && body[o + 1] === 0)) o += 2;
    o += 2;
  } else {
    while (o < body.length && body[o] !== 0) o++;
    o += 1;
  }
  if (o >= body.length) return undefined;
  return new Blob([body.slice(o)], { type: mime.includes('/') ? mime : `image/${mime}` });
}

function vorbis(b: Uint8Array, o: number, out: Tags): void {
  const le = (p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  const vendor = le(o);
  o += 4 + vendor;
  const n = le(o);
  o += 4;
  for (let i = 0; i < n && o < b.length; i++) {
    const len = le(o);
    const s = utf8.decode(b.subarray(o + 4, o + 4 + len));
    o += 4 + len;
    const eq = s.indexOf('=');
    const key = s.slice(0, eq).toUpperCase();
    const val = s.slice(eq + 1).trim();
    if (key === 'TITLE') out.title ??= val;
    else if (key === 'ARTIST') out.artist ??= val;
  }
}

function flac(b: Uint8Array): Tags {
  const out: Tags = {};
  let o = 4;
  for (;;) {
    if (o + 4 > b.length) break;
    const last = b[o] & 0x80, type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    const body = o + 4;
    if (type === 4) vorbis(b, body, out);
    else if (type === 6 && !out.cover) {
      let p = body + 4;
      const ml = u32(b, p);
      const mime = ascii(b, p + 4, ml);
      p += 4 + ml;
      const dl = u32(b, p);
      p += 4 + dl + 16;
      const size = u32(b, p);
      out.cover = new Blob([b.slice(p + 4, p + 4 + size)], { type: mime || 'image/jpeg' });
    }
    o = body + len;
    if (last) break;
  }
  return out;
}

function ogg(b: Uint8Array): Tags {
  // The comment header follows "\x03vorbis" (Vorbis) or "OpusTags" (Opus) in the first pages.
  const out: Tags = {};
  const head = latin1.decode(b.subarray(0, Math.min(b.length, 1 << 16)));
  let i = head.indexOf('\x03vorbis');
  if (i >= 0) vorbis(b, i + 7, out);
  else if ((i = head.indexOf('OpusTags')) >= 0) vorbis(b, i + 8, out);
  return out;
}

function mp4(b: Uint8Array): Tags {
  const out: Tags = {};
  const walk = (start: number, end: number, path: string) => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = ascii(b, o + 4, 4);
      let hdr = 8;
      if (size === 1) { size = Number((BigInt(u32(b, o + 8)) << 32n) | BigInt(u32(b, o + 12))); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      const body = o + hdr;
      if (type === 'moov' || type === 'udta' || type === 'ilst' || type === 'trak') walk(body, o + size, `${path}/${type}`);
      else if (type === 'meta') walk(body + 4, o + size, `${path}/meta`);
      else if (path.endsWith('/ilst')) {
        // Each item holds a 'data' atom: size(4) 'data'(4) type(4) locale(4) payload.
        const dataSize = u32(b, body);
        const flags = u32(b, body + 8) & 0xffffff;
        const payload = b.subarray(body + 16, body + dataSize);
        if (type === '\xa9nam') out.title = utf8.decode(payload).trim();
        else if (type === '\xa9ART') out.artist = utf8.decode(payload).trim();
        else if (type === 'covr' && !out.cover) out.cover = new Blob([payload.slice()], { type: flags === 14 ? 'image/png' : 'image/jpeg' });
      }
      o += size;
    }
  };
  walk(0, b.length, '');
  return out;
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
