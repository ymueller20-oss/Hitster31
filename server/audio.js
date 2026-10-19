// 30-Sekunden-Hörproben über die öffentliche Deezer-API (kein Konto nötig),
// damit auch Mitspieler ohne Spotify den Song auf ihrem eigenen Handy hören.
import { similar } from './fuzzy.js';

const API = 'https://api.deezer.com';
const MAX_BYTES = 2 * 1024 * 1024;
const idCache = new Map(); // spotify-uri -> deezer-track-id | null
const bufCache = new Map(); // spotify-uri -> { buf, at }
const inflight = new Map(); // spotify-uri -> Promise<Buffer|null>

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Deezer ' + res.status);
  const data = await res.json();
  if (data?.error) throw new Error('Deezer: ' + (data.error.message || 'Fehler'));
  return data;
}

function matches(t, card) {
  const artists = card.artists?.length ? card.artists : [card.artist];
  const titleOk = similar(t.title_short || t.title, card.title) || similar(t.title, card.title);
  return titleOk && artists.some((a) => similar(t.artist?.name, a));
}

async function findTrack(card) {
  if (card.isrc) {
    try {
      const t = await getJson(`${API}/track/isrc:${encodeURIComponent(card.isrc)}`);
      if (t?.id && t.preview) return t;
    } catch {}
  }
  const q = `${card.artists?.[0] || card.artist} ${card.title.replace(/\s[-–—]\s.*$|\(.*?\)|\[.*?\]/g, ' ')}`;
  const data = await getJson(`${API}/search?q=${encodeURIComponent(q)}&limit=10`);
  return (data.data || []).find((t) => t.preview && t.readable !== false && matches(t, card)) || null;
}

async function download(card) {
  let id = idCache.get(card.uri);
  let track = null;
  if (id === undefined) {
    track = await findTrack(card);
    id = track?.id ?? null;
    idCache.set(card.uri, id);
  }
  if (!id) return null;
  // Vorschau-Links laufen ab -> beim Laden frisch holen.
  if (!track) track = await getJson(`${API}/track/${id}`);
  if (!track?.preview) return null;
  const res = await fetch(track.preview, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 1000 && buf.length < MAX_BYTES ? buf : null;
}

// Liefert das MP3 als Buffer oder null, wenn es keine Hörprobe gibt.
export function loadPreview(card) {
  const cached = bufCache.get(card.uri);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return Promise.resolve(cached.buf);
  if (inflight.has(card.uri)) return inflight.get(card.uri);
  const p = download(card)
    .catch((e) => {
      console.warn('Hörprobe fehlgeschlagen:', card.title, e.message);
      return null;
    })
    .then((buf) => {
      inflight.delete(card.uri);
      if (buf) {
        bufCache.set(card.uri, { buf, at: Date.now() });
        // Nur die letzten Songs im Speicher halten.
        while (bufCache.size > 40) bufCache.delete(bufCache.keys().next().value);
      }
      return buf;
    });
  inflight.set(card.uri, p);
  return p;
}
