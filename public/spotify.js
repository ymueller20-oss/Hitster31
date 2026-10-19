// Spotify: Login (Authorization Code + PKCE, ohne Server-Geheimnis), Songs laden, Abspielen.
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');
const TOKEN_KEY = 'hit31.spotify';
const API = 'https://api.spotify.com/v1';

let clientId = '';
export const redirectUri = () => location.origin + '/';

export function setClientId(id) {
  clientId = id;
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY)) || null;
  } catch {
    return null;
  }
}
function save(t) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}
export function isLoggedIn() {
  return !!load()?.refresh_token;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login() {
  if (!clientId) throw new Error('Keine Spotify Client-ID eingetragen.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('hit31.pkce', JSON.stringify({ verifier, state }));
  localStorage.setItem('hit31.pkce', JSON.stringify({ verifier, state })); // iOS verliert sessionStorage manchmal
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

// Nach der Rückkehr von Spotify (?code=...). Gibt true zurück, wenn ein Login abgeschlossen wurde.
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return false;
  history.replaceState(null, '', '/');
  if (error) throw new Error('Spotify-Login abgebrochen.');
  const pkce = JSON.parse(sessionStorage.getItem('hit31.pkce') || localStorage.getItem('hit31.pkce') || 'null');
  sessionStorage.removeItem('hit31.pkce');
  localStorage.removeItem('hit31.pkce');
  if (!pkce || pkce.state !== url.searchParams.get('state')) throw new Error('Login ungültig, bitte erneut versuchen.');
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: pkce.verifier,
  });
  return true;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.grant_type === 'refresh_token') logout();
    throw new Error('Spotify-Login fehlgeschlagen: ' + (data.error_description || res.status));
  }
  const prev = load() || {};
  save({
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  });
}

async function accessToken() {
  const t = load();
  if (!t) throw new Error('Nicht bei Spotify angemeldet.');
  if (Date.now() < t.expires_at) return t.access_token;
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  return load().access_token;
}

export class SpotifyError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: 'Bearer ' + (await accessToken()),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new SpotifyError(res.status, data?.error?.message || 'Spotify-Fehler ' + res.status, data?.error?.reason);
    return data;
  }
  throw new SpotifyError(429, 'Spotify ist gerade überlastet, bitte kurz warten.');
}

async function pages(path, query, max = 2000) {
  const items = [];
  let next = null;
  let data = await api(path, { query: { limit: 50, ...query } });
  for (;;) {
    items.push(...(data.items || []));
    next = data.next;
    if (!next || items.length >= max) break;
    data = await api(next);
  }
  return items;
}

// ---------- Songs ----------

export const me = () => api('/me');

export async function myPlaylists() {
  const items = await pages('/me/playlists', {}, 500);
  return items.filter(Boolean).map((p) => ({
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || '',
    count: p.tracks?.total ?? p.items?.total ?? null,
    owner: p.owner?.display_name || '',
  }));
}

export function playlistIdFromInput(input) {
  const s = String(input).trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{16,}$/.test(s)) return s;
  return null;
}

function toTrack(t, excludeCompilations) {
  if (!t || t.type !== 'track' || !t.uri?.startsWith('spotify:track:') || t.is_local) return null;
  if (excludeCompilations && t.album?.album_type === 'compilation') return null;
  const year = parseInt(String(t.album?.release_date || '').slice(0, 4), 10);
  if (!year) return null;
  return {
    uri: t.uri,
    title: t.name,
    artists: (t.artists || []).map((a) => a.name),
    year,
    cover: t.album?.images?.[0]?.url || '',
  };
}

export async function playlistTracks(id, excludeCompilations) {
  let items;
  try {
    items = await pages(`/playlists/${id}/tracks`, { additional_types: 'track' });
  } catch (e) {
    // Neuere API-Versionen nennen den Endpunkt /items.
    if (!(e instanceof SpotifyError) || ![403, 404, 410].includes(e.status)) throw e;
    items = await pages(`/playlists/${id}/items`, { additional_types: 'track' });
  }
  return items.map((it) => toTrack(it?.track || it?.item, excludeCompilations)).filter(Boolean);
}

export async function savedTracks(excludeCompilations) {
  const items = await pages('/me/tracks', {}, 2000);
  return items.map((it) => toTrack(it?.track, excludeCompilations)).filter(Boolean);
}

// ---------- Abspielen (Spotify Connect) ----------

export async function devices() {
  const data = await api('/me/player/devices');
  return data?.devices || [];
}

export async function play(uri, deviceId) {
  await api('/me/player/play', { method: 'PUT', query: { device_id: deviceId || undefined }, body: { uris: [uri] } });
}

export async function pause(deviceId) {
  try {
    await api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId || undefined } });
  } catch (e) {
    // Schon pausiert -> egal.
    if (!(e instanceof SpotifyError) || e.status !== 403) throw e;
  }
}
