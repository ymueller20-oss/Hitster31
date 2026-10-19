// Volle Songs für Mitspieler ohne Spotify Premium: passendes YouTube-Video über die
// YouTube Data API suchen. Bevorzugt werden "- Topic"-Kanäle (offizielle Audiospur,
// startet ohne Intro bei 0:00) und offizielle Kanäle.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalize, similar } from './fuzzy.js';

const KEY = process.env.YOUTUBE_API_KEY || '';
const CACHE_FILE = process.env.YOUTUBE_CACHE_FILE || new URL('../data/youtube-cache.json', import.meta.url).pathname;
const BAD = /\b(live|cover|karaoke|instrumental|remix|nightcore|slowed|reverb|sped up|8d|reaction|tutorial|lesson|piano version)\b/i;

export const youtubeEnabled = !!KEY;

let cache = {};
try {
  cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
} catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) {
      console.warn('YouTube-Cache nicht gespeichert:', e.message);
    }
  }, 2000);
}

export class QuotaError extends Error {}
let quotaBlockedUntil = 0;

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

function score(item, card) {
  const title = decode(item.snippet?.title);
  const channel = decode(item.snippet?.channelTitle);
  const nTitle = normalize(title.replace(/\s[-–—]\s/g, ' '));
  const nCard = normalize(card.title);
  if (!nCard || !(nTitle.includes(nCard) || similar(title, card.title))) return -1;
  if (BAD.test(title) && !BAD.test(card.title)) return -1;
  const artists = card.artists?.length ? card.artists : [card.artist];
  const artistInChannel = artists.some((a) => similar(channel.replace(/\s*-\s*Topic$|VEVO$/i, ''), a));
  const artistInTitle = artists.some((a) => nTitle.includes(normalize(a)));
  if (!artistInChannel && !artistInTitle) return -1;
  let s = 1;
  if (/ - Topic$/.test(channel)) s += 4;
  if (/VEVO$/i.test(channel)) s += 2;
  if (artistInChannel) s += 2;
  if (/official (audio|video|music video)/i.test(title)) s += 1;
  return s;
}

async function search(card) {
  const q = `${card.artists?.[0] || card.artist} ${card.title.replace(/\s[-–—]\s.*$|\(.*?\)|\[.*?\]/g, ' ')}`.trim();
  const url = new URL(process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '8',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    q,
    key: KEY,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || '';
    if (res.status === 403 && /quota/i.test(reason)) {
      // Tageslimit erreicht -> bis zum nächsten Tag (Reset um Mitternacht US-Westküste) nicht mehr fragen.
      quotaBlockedUntil = Date.now() + 60 * 60 * 1000;
      throw new QuotaError('YouTube-Tageslimit erreicht');
    }
    throw new Error(`YouTube ${res.status} ${reason || data?.error?.message || ''}`);
  }
  let best = null;
  let bestScore = 0;
  for (const item of data.items || []) {
    const s = score(item, card);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best?.id?.videoId || null;
}

const inflight = new Map();

// Liefert die Video-ID, null wenn nichts Passendes gefunden wurde,
// oder wirft QuotaError, wenn das Tageslimit erreicht ist.
export function findVideo(card) {
  if (!KEY) return Promise.resolve(null);
  if (card.uri in cache) return Promise.resolve(cache[card.uri]);
  if (Date.now() < quotaBlockedUntil) return Promise.reject(new QuotaError('YouTube-Tageslimit erreicht'));
  if (inflight.has(card.uri)) return inflight.get(card.uri);
  const p = search(card)
    .then((id) => {
      cache[card.uri] = id;
      save();
      return id;
    })
    .finally(() => inflight.delete(card.uri));
  inflight.set(card.uri, p);
  return p;
}
