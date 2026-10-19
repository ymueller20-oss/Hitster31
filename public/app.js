import * as spotify from './spotify.js';

// ---------- Zustand ----------

const LS = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const params = new URLSearchParams(location.search);
const S = {
  config: { spotifyClientId: '' },
  connected: false,
  session: LS.get('hit31.session'),
  game: null,
  toast: '',
  busy: '',
  ui: {
    name: LS.get('hit31.name', ''),
    joinCode: (params.get('join') || '').toUpperCase().slice(0, 4),
    clientIdInput: '',
    showSetup: false,
    guess: { title: '', artist: '' },
    guessOpen: false,
    challengeSlot: null,
    viewPlayerId: null,
    roundId: null,
    showPlayers: false,
  },
  host: {
    playlists: null,
    selected: new Set(LS.get('hit31.selected', [])),
    customLink: '',
    excludeCompilations: LS.get('hit31.noComp', true),
    devices: null,
    deviceId: LS.get('hit31.device', ''),
    lastPlayedRound: null,
    playError: '',
    playing: false,
    poolNote: '',
  },
  audio: {
    pref: LS.get('hit31.audioMode'), // gewählter Ton-Modus, wird nach dem Beitreten an den Server geschickt
    src: null,
    playing: false,
    blocked: false,
  },
};

// ---------- YouTube ----------
const yt = { player: null, ready: null, videoId: null, checkTimer: null, failedId: null };

function loadYouTubeApi() {
  if (!yt.ready) {
    yt.ready = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }
  return yt.ready;
}

async function playYoutube(videoId) {
  yt.videoId = videoId;
  S.audio.blocked = false;
  await loadYouTubeApi();
  if (yt.videoId !== videoId) return;
  if (!yt.player) {
    yt.player = new YT.Player('yt-player', {
      height: '200',
      width: '100%',
      videoId,
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, start: 0 },
      events: {
        onReady: (e) => e.target.playVideo(),
        // Video gesperrt/gelöscht/nicht einbettbar -> auf die Hörprobe ausweichen.
        onError: () => {
          yt.failedId = yt.videoId;
          stopYoutube();
          S.audio.blocked = false;
          syncAudio();
          render();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) {
            e.target.seekTo(0);
            e.target.playVideo();
          }
          S.audio.playing = e.data === YT.PlayerState.PLAYING;
          if (S.audio.playing) S.audio.blocked = false;
          render();
        },
      },
    });
  } else {
    yt.player.loadVideoById({ videoId, startSeconds: 0 });
  }
  // Startet nichts (Autoplay-Sperre des Browsers)? Dann großen Play-Knopf anbieten.
  clearTimeout(yt.checkTimer);
  yt.checkTimer = setTimeout(() => {
    const st = yt.player?.getPlayerState?.();
    if (yt.videoId === videoId && st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) {
      S.audio.blocked = true;
      render();
    }
  }, 3000);
}

function stopYoutube() {
  clearTimeout(yt.checkTimer);
  yt.videoId = null;
  try {
    yt.player?.stopVideo?.();
  } catch {}
}

// Ein einziges Audio-Element außerhalb von #app, damit es das Neu-Rendern überlebt.
const audioEl = new Audio();
audioEl.loop = true;
audioEl.preload = 'auto';
audioEl.addEventListener('playing', () => {
  S.audio.playing = true;
  S.audio.blocked = false;
  render();
});
audioEl.addEventListener('pause', () => {
  S.audio.playing = false;
  render();
});
if (params.has('join')) history.replaceState(null, '', '/');

const $app = document.getElementById('app');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Verbindung ----------

let ws = null;
let retry = 0;
let pendingOnOpen = [];

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    retry = 0;
    S.connected = true;
    if (S.session) raw({ type: 'resume', ...S.session });
    const q = pendingOnOpen;
    pendingOnOpen = [];
    q.forEach(raw);
    render();
  };
  ws.onclose = () => {
    S.connected = false;
    render();
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}

function raw(msg) {
  ws.send(JSON.stringify(msg));
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) raw(msg);
  else {
    pendingOnOpen.push(msg);
    connect();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    connect();
    requestWakeLock();
  }
});

function onMessage(msg) {
  switch (msg.type) {
    case 'session':
      S.session = { code: msg.code, playerId: msg.playerId, secret: msg.secret };
      LS.set('hit31.session', S.session);
      S.busy = '';
      if (S.audio.pref) send({ type: 'audio', mode: S.audio.pref });
      break;
    case 'resumeFailed':
      S.session = null;
      S.game = null;
      LS.set('hit31.session', null);
      break;
    case 'closed':
      S.session = null;
      S.game = null;
      LS.set('hit31.session', null);
      stopPreview();
      if (msg.reason) showToast(msg.reason);
      break;
    case 'error':
      S.busy = '';
      showToast(msg.message);
      break;
    case 'state':
      onState(msg.state);
      break;
  }
  render();
}

function onState(g) {
  const prev = S.game;
  S.game = g;
  if (g.round?.id !== S.ui.roundId) {
    S.ui.roundId = g.round?.id || null;
    S.ui.guess = { title: '', artist: '' };
    S.ui.guessOpen = false;
    S.ui.challengeSlot = null;
    S.ui.viewPlayerId = null;
    if (g.round && g.round.playerId === g.you && g.phase === 'placing') buzz([80, 60, 80]);
  }
  if (prev?.phase !== 'challenge' && g.phase === 'challenge' && g.round.playerId !== g.you) buzz(120);
  if (g.phase !== 'lobby') requestWakeLock();
  syncAudio();
}

const me = () => S.game?.players.find((p) => p.id === S.game.you);
const audioMode = () => me()?.audioMode || 'off';
const isHost = () => S.game && S.game.hostId === S.game.you;
const playerById = (id) => S.game?.players.find((p) => p.id === id);

// ---------- Kleinkram ----------

let toastTimer;
function showToast(t) {
  S.toast = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    S.toast = '';
    render();
  }, 4000);
  render();
}

function buzz(p) {
  try {
    navigator.vibrate?.(p);
  } catch {}
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if (!wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}

function inviteUrl() {
  return `${location.origin}/?join=${S.game.code}`;
}

async function share() {
  const url = inviteUrl();
  const text = `Spiel mit mir Hit31! 🎵 Code: ${S.game.code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Hit31', text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    showToast('Einladungslink kopiert!');
  } catch {
    prompt('Link kopieren:', url);
  }
}

// ---------- Host: Spotify ----------

// Bei jedem neuen Zustand: passend zum eigenen Ton-Modus abspielen oder stoppen.
function syncAudio() {
  const g = S.game;
  const r = g?.round;
  const running = g && r && ['placing', 'challenge', 'reveal'].includes(g.phase);
  let mode = audioMode();
  // Kein YouTube-Video gefunden oder Tageslimit erreicht -> Hörprobe als Ersatz.
  if (mode === 'youtube' && r && ((!r.youtubeId && (r.yt === 'missing' || r.yt === 'quota')) || r.youtubeId === yt.failedId)) {
    mode = 'preview';
  }

  const ytOn = mode === 'youtube' && running;
  document.body.classList.toggle('yt-on', ytOn);
  if (ytOn && r.youtubeId && yt.videoId !== r.youtubeId) playYoutube(r.youtubeId);
  else if (!ytOn && yt.videoId) stopYoutube();

  if (mode === 'preview' && running && r.audioUrl) {
    if (S.audio.src !== r.audioUrl) {
      S.audio.src = r.audioUrl;
      audioEl.src = r.audioUrl;
      playPreview();
    }
  } else if (S.audio.src && !(mode === 'preview' && running && r.audio === 'loading')) {
    stopPreview();
  }

  if (mode === 'spotify' && g.phase === 'placing' && g.playUri && S.host.lastPlayedRound !== r.id) {
    S.host.lastPlayedRound = r.id;
    playCurrent();
  }
}

function playPreview() {
  if (!S.audio.src) return;
  audioEl.play().catch(() => {
    // Browser blockiert Autoplay ohne Antippen -> großen Play-Knopf zeigen.
    S.audio.blocked = true;
    render();
  });
}

function stopPreview() {
  S.audio.src = null;
  S.audio.blocked = false;
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
}

// Jeder Tipp im Spiel darf eine blockierte Wiedergabe nachholen (iOS/Chrome-Autoplay-Regeln).
document.addEventListener('click', () => {
  if (!S.audio.blocked) return;
  if (S.audio.src && audioEl.paused) playPreview();
  if (yt.videoId) yt.player?.playVideo?.();
}, true);

async function playCurrent() {
  const uri = S.game?.playUri;
  if (!uri) return;
  if (!spotify.isLoggedIn()) {
    S.host.playError = 'Nicht mit Spotify verbunden.';
    return render();
  }
  try {
    await spotify.play(uri, S.host.deviceId);
    S.host.playError = '';
    S.host.playing = true;
  } catch (e) {
    if (e.status === 404) {
      // Gespeichertes Gerät weg oder keins aktiv -> anderes Gerät versuchen.
      try {
        const list = await spotify.devices();
        S.host.devices = list;
        const dev = list.find((d) => d.is_active) || list.find((d) => d.type === 'Smartphone') || list[0];
        if (dev) {
          setDevice(dev.id);
          await spotify.play(uri, dev.id);
          S.host.playError = '';
          S.host.playing = true;
          return render();
        }
      } catch {}
      S.host.playError = 'Kein Spotify-Gerät gefunden. Öffne kurz die Spotify-App, dann ▶ tippen.';
    } else if (e.status === 403) {
      S.host.playError = 'Spotify verweigert das Abspielen (Premium nötig?).';
    } else {
      S.host.playError = e.message;
    }
    S.host.playing = false;
  }
  render();
}

async function pausePlayback() {
  try {
    await spotify.pause(S.host.deviceId);
    S.host.playing = false;
  } catch (e) {
    S.host.playError = e.message;
  }
  render();
}

function setDevice(id) {
  S.host.deviceId = id;
  LS.set('hit31.device', id);
}

async function loadDevices() {
  S.busy = 'devices';
  render();
  try {
    S.host.devices = await spotify.devices();
    if (!S.host.deviceId || !S.host.devices.some((d) => d.id === S.host.deviceId)) {
      const d = S.host.devices.find((x) => x.is_active) || S.host.devices[0];
      if (d) setDevice(d.id);
    }
  } catch (e) {
    showToast(e.message);
  }
  S.busy = '';
  render();
}

async function loadPlaylists() {
  if (S.host.playlists || S.busy === 'playlists') return;
  S.busy = 'playlists';
  render();
  try {
    S.host.playlists = await spotify.myPlaylists();
  } catch (e) {
    S.host.playlists = [];
    showToast(e.message);
  }
  S.busy = '';
  render();
}

async function loadPool() {
  const ids = [...S.host.selected];
  if (!ids.length) return showToast('Wähle mindestens eine Playlist.');
  S.busy = 'pool';
  S.host.poolNote = '';
  render();
  const tracks = [];
  const failed = [];
  for (const id of ids) {
    try {
      if (id === 'saved') tracks.push(...(await spotify.savedTracks(S.host.excludeCompilations)));
      else tracks.push(...(await spotify.playlistTracks(id, S.host.excludeCompilations)));
    } catch (e) {
      failed.push(playlistName(id));
      console.warn(id, e);
    }
  }
  if (failed.length) S.host.poolNote = `Nicht ladbar: ${failed.join(', ')} (Spotify sperrt manche fremden Playlists für Apps).`;
  send({ type: 'setPool', tracks });
  S.busy = '';
  render();
}

function playlistName(id) {
  if (id === 'saved') return 'Lieblingssongs';
  return S.host.playlists?.find((p) => p.id === id)?.name || 'Playlist ' + id.slice(0, 6);
}

// ---------- Aktionen ----------

let guessTimer;
const actions = {
  async create() {
    const name = S.ui.name.trim();
    if (!name) return showToast('Bitte gib deinen Namen ein.');
    LS.set('hit31.name', name);
    if (!S.config.spotifyClientId) {
      S.ui.showSetup = true;
      return render();
    }
    if (!spotify.isLoggedIn()) {
      LS.set('hit31.intent', { action: 'create', name });
      try {
        await spotify.login();
      } catch (e) {
        showToast(e.message);
      }
      return;
    }
    S.busy = 'create';
    send({ type: 'create', name });
    render();
  },
  join() {
    const name = S.ui.name.trim();
    const code = S.ui.joinCode.trim().toUpperCase();
    if (!name) return showToast('Bitte gib deinen Namen ein.');
    if (code.length !== 4) return showToast('Der Raum-Code hat 4 Buchstaben.');
    LS.set('hit31.name', name);
    S.busy = 'join';
    send({ type: 'join', name, code });
    render();
  },
  saveClientId() {
    const id = S.ui.clientIdInput.trim();
    if (!/^[a-f0-9]{32}$/i.test(id)) return showToast('Die Client-ID hat 32 Zeichen (0-9, a-f).');
    LS.set('hit31.clientId', id);
    S.config.spotifyClientId = id;
    spotify.setClientId(id);
    S.ui.showSetup = false;
    actions.create();
  },
  closeSetup() {
    S.ui.showSetup = false;
    render();
  },
  spotifyLogin() {
    spotify.login().catch((e) => showToast(e.message));
  },
  spotifyLogout() {
    spotify.logout();
    S.host.playlists = null;
    render();
  },
  share,
  copyCode() {
    navigator.clipboard?.writeText(S.game.code).then(() => showToast('Code kopiert!'));
  },
  togglePlaylist(el) {
    const id = el.dataset.id;
    if (S.host.selected.has(id)) S.host.selected.delete(id);
    else S.host.selected.add(id);
    LS.set('hit31.selected', [...S.host.selected]);
    render();
  },
  addLink() {
    const id = spotify.playlistIdFromInput(S.host.customLink);
    if (!id) return showToast('Das ist kein Spotify-Playlist-Link.');
    S.host.selected.add(id);
    LS.set('hit31.selected', [...S.host.selected]);
    if (S.host.playlists && !S.host.playlists.some((p) => p.id === id)) {
      S.host.playlists.unshift({ id, name: 'Playlist aus Link', image: '', count: null, owner: '' });
    }
    S.host.customLink = '';
    render();
  },
  toggleComp() {
    S.host.excludeCompilations = !S.host.excludeCompilations;
    LS.set('hit31.noComp', S.host.excludeCompilations);
    render();
  },
  loadPool,
  loadDevices,
  pickDevice(el) {
    setDevice(el.dataset.id);
    render();
  },
  start() {
    if (!S.host.deviceId) showToast('Tipp: Wähle unten ein Spotify-Gerät, sonst wird das aktive genommen.');
    send({ type: 'start' });
  },
  kick(el) {
    if (confirm(`${playerById(el.dataset.id)?.name} entfernen?`)) send({ type: 'kick', playerId: el.dataset.id });
  },
  leave() {
    const msg = isHost() ? 'Spiel für alle beenden?' : 'Raum verlassen?';
    if (confirm(msg)) send({ type: 'leave' });
  },
  slot(el) {
    const slot = Number(el.dataset.slot);
    const g = S.game;
    if (g.phase === 'placing') send({ type: 'slot', slot });
    else if (g.phase === 'challenge') {
      S.ui.challengeSlot = S.ui.challengeSlot === slot ? null : slot;
      render();
    }
  },
  lockIn() {
    clearTimeout(guessTimer);
    send({ type: 'guess', guess: S.ui.guess });
    send({ type: 'lockIn' });
  },
  skip() {
    if (confirm('Song überspringen? Kostet 1 Token.')) send({ type: 'skip' });
  },
  buy() {
    if (confirm(`Karte kaufen? Kostet ${S.game.settings.buyCost} Tokens – sie wird automatisch richtig einsortiert.`)) {
      send({ type: 'buy' });
    }
  },
  challenge() {
    if (S.ui.challengeSlot === null) return showToast('Tippe zuerst eine Stelle in der Zeitleiste an.');
    send({ type: 'challenge', slot: S.ui.challengeSlot });
  },
  pass() {
    send({ type: 'pass' });
  },
  next() {
    send({ type: 'next' });
  },
  forceNext() {
    if (confirm(`Zug von ${playerById(S.game.round.playerId)?.name} überspringen?`)) send({ type: 'next' });
  },
  toLobby() {
    send({ type: 'lobby' });
  },
  restart() {
    send({ type: 'start' });
  },
  replay() {
    if (yt.videoId) {
      yt.player?.seekTo?.(0);
      yt.player?.playVideo?.();
    } else if (S.audio.src) {
      audioEl.currentTime = 0;
      playPreview();
    } else playCurrent();
  },
  pause() {
    if (yt.videoId) yt.player?.pauseVideo?.();
    else if (S.audio.src) audioEl.pause();
    else pausePlayback();
  },
  playPreview() {
    if (yt.videoId) yt.player?.playVideo?.();
    else playPreview();
  },
  setAudio(el) {
    const mode = el.dataset.mode;
    const before = audioMode();
    S.audio.pref = mode;
    LS.set('hit31.audioMode', mode);
    if (before === 'spotify' && mode !== 'spotify' && spotify.isLoggedIn()) pausePlayback();
    if (mode === 'spotify') S.host.lastPlayedRound = null; // aktuellen Song sofort abspielen
    send({ type: 'audio', mode });
    if (mode === 'spotify' && spotify.isLoggedIn() && !S.host.devices) loadDevices();
  },
  viewPlayer(el) {
    S.ui.viewPlayerId = el.dataset.id === S.ui.viewPlayerId ? null : el.dataset.id;
    render();
  },
  toggleGuess() {
    S.ui.guessOpen = !S.ui.guessOpen;
    render();
  },
  togglePlayers() {
    S.ui.showPlayers = !S.ui.showPlayers;
    render();
  },
};

const binders = {
  name: (v) => (S.ui.name = v),
  joinCode: (v) => (S.ui.joinCode = v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)),
  clientId: (v) => (S.ui.clientIdInput = v),
  customLink: (v) => (S.host.customLink = v),
  guessTitle: (v) => updateGuess('title', v),
  guessArtist: (v) => updateGuess('artist', v),
};

function updateGuess(k, v) {
  S.ui.guess[k] = v;
  clearTimeout(guessTimer);
  guessTimer = setTimeout(() => send({ type: 'guess', guess: S.ui.guess }), 400);
}

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // Klick ins Innere eines Dialogs schließt ihn nicht.
  if (el.classList.contains('modal') && e.target !== el) return;
  e.preventDefault();
  actions[el.dataset.action]?.(el);
});
$app.addEventListener('input', (e) => {
  const b = e.target.dataset.bind;
  if (!b) return;
  binders[b](e.target.value);
  if (b === 'joinCode' && e.target.value !== S.ui.joinCode) e.target.value = S.ui.joinCode;
});
$app.addEventListener('change', (e) => {
  const s = e.target.dataset.setting;
  if (!s) return;
  send({ type: 'settings', settings: { ...S.game.settings, [s]: Number(e.target.value) } });
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const b = e.target.dataset.bind;
  if (b === 'joinCode' || (b === 'name' && S.ui.joinCode.length === 4)) actions.join();
  else if (b === 'customLink') actions.addLink();
  else if (b === 'clientId') actions.saveClientId();
});

// ---------- Rendering ----------

function render() {
  // Fokus/Cursor in Eingabefeldern über das Neu-Rendern retten.
  const a = document.activeElement;
  const focus = a?.dataset?.bind ? { bind: a.dataset.bind, start: a.selectionStart, end: a.selectionEnd } : null;
  const scrollers = [...$app.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);

  $app.innerHTML = view();

  for (const [k, top] of scrollers) {
    const el = $app.querySelector(`[data-scroll="${k}"]`);
    if (el) el.scrollTop = top;
  }
  if (focus) {
    const el = $app.querySelector(`[data-bind="${focus.bind}"]`);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(focus.start, focus.end);
      } catch {}
    }
  }
  tick();
}

function tick() {
  const d = S.game?.round?.deadline;
  for (const el of $app.querySelectorAll('[data-countdown]')) {
    el.textContent = d ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) + ' s' : '';
  }
}
setInterval(tick, 250);

function view() {
  let body;
  if (!S.game) body = S.session && !S.connected ? viewLoading('Verbinde…') : S.session ? viewLoading('Lade Raum…') : viewHome();
  else if (S.game.phase === 'lobby') body = viewLobby();
  else body = viewGame();
  return `${body}
    ${!S.connected && S.game ? `<div class="offline">Verbindung verloren – verbinde neu…</div>` : ''}
    ${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}
    ${S.ui.showSetup ? viewSetup() : ''}`;
}

function viewLoading(text) {
  return `<main class="center"><div class="logo-big">${logo()}</div><p class="muted">${esc(text)}</p></main>`;
}

function logo() {
  return `<span class="logo">Hit<b>31</b></span>`;
}

function viewHome() {
  const hasCode = S.ui.joinCode.length === 4;
  return `<main class="home">
    <div class="hero">
      <div class="logo-big">${logo()}</div>
      <p class="tagline">Hör den Song. Rate das Jahr. Bau deinen Zeitstrahl.</p>
      <div class="hero-cards"><div class="mini c1">1979</div><div class="mini c2">?</div><div class="mini c3">2004</div></div>
    </div>
    <label class="field"><span>Dein Name</span>
      <input data-bind="name" value="${esc(S.ui.name)}" maxlength="20" autocomplete="nickname" placeholder="z. B. Alex" ${hasCode ? 'autofocus' : ''}>
    </label>
    <section class="card">
      <h2>Mitspielen</h2>
      <div class="row">
        <input class="code-input" data-bind="joinCode" value="${esc(S.ui.joinCode)}" placeholder="CODE" maxlength="4" autocapitalize="characters" autocomplete="off" inputmode="text">
        <button class="btn primary" data-action="join" ${S.busy === 'join' ? 'disabled' : ''}>Beitreten</button>
      </div>
    </section>
    <section class="card">
      <h2>Neues Spiel</h2>
      <p class="muted small">Du bist Host: Die Musik kommt aus deinem Spotify (Premium) und läuft auf deinem Handy oder Lautsprecher.</p>
      <button class="btn spotify wide" data-action="create" ${S.busy === 'create' ? 'disabled' : ''}>
        ${spotifyIcon()} Spiel erstellen
      </button>
    </section>
    <details class="rules"><summary>So wird gespielt</summary>${rulesHtml()}</details>
  </main>`;
}

function rulesHtml() {
  return `<ol>
    <li>Jeder startet mit einer aufgedeckten Song-Karte (mit Jahr) in seinem Zeitstrahl.</li>
    <li>Wer dran ist, hört einen Song und legt ihn an die passende Stelle im eigenen Zeitstrahl – älter oben, neuer unten.</li>
    <li>Bonus: Titel <i>und</i> Interpret richtig getippt → +1 🪙 Token.</li>
    <li>Die anderen dürfen mit 1 🪙 <b>challengen</b> und eine andere Stelle wählen. Lag der Spieler falsch und du richtig, bekommst du die Karte.</li>
    <li>Mit Tokens kannst du auch einen Song überspringen (1 🪙) oder eine Karte kaufen (3 🪙).</li>
    <li>Wer zuerst die Ziel-Anzahl an Karten hat, gewinnt!</li>
  </ol>`;
}

function viewSetup() {
  return `<div class="modal"><div class="modal-box">
    <h2>Spotify einrichten (einmalig)</h2>
    <ol class="small">
      <li>Öffne <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> und melde dich an.</li>
      <li><b>Create app</b> → Name egal, „Web API“ anhaken.</li>
      <li>Als <b>Redirect URI</b> genau das eintragen:<br><code class="copy">${esc(spotify.redirectUri())}</code></li>
      <li>Unter <b>User Management</b> die Spotify-E-Mail von jedem eintragen, der hosten will.</li>
      <li>Die <b>Client ID</b> kopieren und hier einfügen:</li>
    </ol>
    <input data-bind="clientId" value="${esc(S.ui.clientIdInput)}" placeholder="Client ID" autocomplete="off" spellcheck="false">
    <div class="row end">
      <button class="btn ghost" data-action="closeSetup">Abbrechen</button>
      <button class="btn primary" data-action="saveClientId">Speichern</button>
    </div>
  </div></div>`;
}

function spotifyIcon() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21Zm4.8 15.1a.65.65 0 0 1-.9.2c-2.5-1.5-5.6-1.9-9.3-1a.65.65 0 1 1-.3-1.3c4-.9 7.5-.5 10.3 1.2.3.2.4.6.2.9Zm1.3-2.9a.82.82 0 0 1-1.1.3c-2.8-1.7-7.1-2.2-10.5-1.2a.82.82 0 1 1-.5-1.6c3.8-1.2 8.6-.6 11.8 1.4.4.2.5.7.3 1.1Zm.1-3c-3.4-2-8.9-2.2-12.1-1.2a1 1 0 1 1-.6-1.9c3.7-1.1 9.8-.9 13.7 1.4a1 1 0 0 1-1 1.7Z"/></svg>`;
}

// ---------- Lobby ----------

function viewLobby() {
  const g = S.game;
  return `<main class="lobby">
    <header class="topbar">${logo()}<button class="btn ghost small" data-action="leave">${isHost() ? 'Beenden' : 'Verlassen'}</button></header>
    <section class="card invite">
      <p class="muted small">Raum-Code</p>
      <button class="room-code" data-action="copyCode" aria-label="Code kopieren">${esc(g.code)}</button>
      <button class="btn primary wide" data-action="share">📨 Freunde einladen</button>
      <a class="btn whatsapp wide" href="https://wa.me/?text=${encodeURIComponent(`Spiel mit mir Hit31! 🎵 ${inviteUrl()}`)}" target="_blank" rel="noopener">Per WhatsApp einladen</a>
    </section>
    <section class="card">
      <h2>Spieler (${g.players.length})</h2>
      <ul class="players">${g.players
        .map(
          (p) => `<li><span class="avatar" style="--h:${hue(p.name)}">${esc(p.name[0].toUpperCase())}</span>
          <span class="grow">${esc(p.name)}${p.id === g.hostId ? ' <span class="tag">Host</span>' : ''}${p.id === g.you ? ' <span class="tag">Du</span>' : ''}</span>
          ${!p.connected ? '<span class="muted small">offline</span>' : ''}
          ${isHost() && p.id !== g.you ? `<button class="icon-btn" data-action="kick" data-id="${p.id}" aria-label="Entfernen">✕</button>` : ''}</li>`,
        )
        .join('')}</ul>
    </section>
    ${isHost() ? viewHostSetup() : `${viewAudioCard()}<section class="card center"><div class="eq"><i></i><i></i><i></i><i></i></div><p>Warte, bis der Host das Spiel startet…</p>
      <p class="muted small">Ziel: ${g.settings.targetCards} Karten · ${g.poolSize ? g.poolSize + ' Songs bereit' : 'Host wählt Songs aus'}</p></section>`}
    <details class="rules"><summary>Spielregeln</summary>${rulesHtml()}</details>
  </main>`;
}

function viewHostSetup() {
  const g = S.game;
  const h = S.host;
  if (!spotify.isLoggedIn()) {
    return `<section class="card"><h2>Musik</h2><p class="muted small">Verbinde dein Spotify, um Songs auszuwählen.</p>
      <button class="btn spotify wide" data-action="spotifyLogin">${spotifyIcon()} Mit Spotify verbinden</button></section>`;
  }
  if (!h.playlists) queueMicrotask(loadPlaylists);
  const entries = [{ id: 'saved', name: '❤️ Lieblingssongs', image: '', count: null }, ...(h.playlists || [])];
  const canStart = g.poolSize > 0;
  return `<section class="card">
      <h2>1 · Songs auswählen</h2>
      <div class="playlists" data-scroll="playlists">
        ${
          h.playlists === null
            ? '<p class="muted">Lade Playlists…</p>'
            : entries
                .map(
                  (p) => `<button class="pl ${h.selected.has(p.id) ? 'on' : ''}" data-action="togglePlaylist" data-id="${esc(p.id)}">
              ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="pl-ph">♫</span>`}
              <span class="grow"><span class="pl-name">${esc(p.name)}</span>${p.count != null ? `<span class="muted small">${p.count} Songs</span>` : ''}</span>
              <span class="check">${h.selected.has(p.id) ? '✓' : ''}</span></button>`,
                )
                .join('')
        }
      </div>
      <div class="row">
        <input data-bind="customLink" value="${esc(h.customLink)}" placeholder="Playlist-Link einfügen" autocomplete="off">
        <button class="btn ghost" data-action="addLink">+</button>
      </div>
      <button class="toggle ${h.excludeCompilations ? 'on' : ''}" data-action="toggleComp"><span class="sw"></span>Best-of/Sampler-Alben ausschließen <span class="muted small">(sonst oft falsches Jahr)</span></button>
      <button class="btn primary wide" data-action="loadPool" ${S.busy === 'pool' || !h.selected.size ? 'disabled' : ''}>
        ${S.busy === 'pool' ? 'Lade Songs…' : `Songs übernehmen (${h.selected.size} ausgewählt)`}</button>
      ${g.poolSize ? `<p class="ok">✅ ${g.poolSize} Songs im Stapel</p>` : ''}
      ${h.poolNote ? `<p class="warn small">${esc(h.poolNote)}</p>` : ''}
    </section>
    ${viewAudioCard('2 · ')}
    <section class="card">
      <h2>3 · Einstellungen</h2>
      <label class="setting">Karten zum Sieg ${select('targetCards', [5, 7, 10, 12, 15], g.settings.targetCards)}</label>
      <label class="setting">Start-Tokens ${select('startTokens', [0, 1, 2, 3, 4, 5], g.settings.startTokens)}</label>
      <label class="setting">Zeit zum Challengen ${select('challengeSeconds', [10, 15, 20, 30, 45], g.settings.challengeSeconds, ' s')}</label>
    </section>
    <div class="sticky-bottom"><button class="btn primary wide big" data-action="start" ${canStart ? '' : 'disabled'}>Spiel starten ▶</button></div>
    <p class="center small"><button class="link" data-action="spotifyLogout">Spotify-Konto wechseln</button></p>`;
}

const AUDIO_OPTIONS = [
  ['youtube', '▶️', 'Ganzer Song über YouTube', 'Kostenlos, ohne Konto, ab 0:00 – das Video ist sichtbar, also nicht hinschauen 😉'],
  ['preview', '🎧', 'Hörprobe auf diesem Handy', '30 Sekunden aus der Songmitte, ohne Konto'],
  ['spotify', '🟢', 'Ganzer Song (eigenes Spotify)', 'Braucht Premium und Freischaltung durch den Host'],
  ['off', '🔇', 'Kein Ton', 'Ich sitze neben jemandem, bei dem die Musik läuft'],
];

function viewAudioCard(prefix = '') {
  const mode = audioMode();
  return `<section class="card">
    <h2>${prefix}Wie hörst du die Musik?</h2>
    <div class="devices">${AUDIO_OPTIONS.filter(([m]) => m !== 'youtube' || S.config.youtube).map(
      ([m, icon, label, hint]) => `<button class="pl ${mode === m ? 'on' : ''}" data-action="setAudio" data-mode="${m}">
        <span class="pl-ph">${icon}</span><span class="grow"><span class="pl-name">${label}</span><span class="muted small">${hint}</span></span>
        <span class="check">${mode === m ? '✓' : ''}</span></button>`,
    ).join('')}</div>
    ${
      mode === 'spotify'
        ? spotify.isLoggedIn()
          ? `<p class="muted small">Öffne die Spotify-App auf deinem Handy (oder Box/TV) und tippe auf „Geräte suchen“. Nicht aufs Spotify-Display schauen – da steht der Titel. 😉</p>${viewDevices()}`
          : `<button class="btn spotify wide" data-action="spotifyLogin">${spotifyIcon()} Mit meinem Spotify verbinden</button>
             <p class="muted small">Klappt nur, wenn der Host deine Spotify-E-Mail im Spotify-Dashboard unter „User Management“ eingetragen hat.</p>`
        : ''
    }
  </section>`;
}

function viewDevices() {
  const h = S.host;
  const list = h.devices || [];
  return `<div class="devices">${list
    .map(
      (d) => `<button class="pl ${d.id === h.deviceId ? 'on' : ''}" data-action="pickDevice" data-id="${esc(d.id)}">
      <span class="pl-ph">${deviceIcon(d.type)}</span><span class="grow"><span class="pl-name">${esc(d.name)}</span><span class="muted small">${esc(d.type)}${d.is_active ? ' · aktiv' : ''}</span></span>
      <span class="check">${d.id === h.deviceId ? '✓' : ''}</span></button>`,
    )
    .join('')}
    ${h.devices && !list.length ? '<p class="warn small">Keine Geräte gefunden. Ist die Spotify-App offen?</p>' : ''}
    <button class="btn ghost wide" data-action="loadDevices" ${S.busy === 'devices' ? 'disabled' : ''}>${S.busy === 'devices' ? 'Suche…' : '🔎 Geräte suchen'}</button></div>`;
}

function deviceIcon(type) {
  return { Smartphone: '📱', Computer: '💻', Speaker: '🔊', TV: '📺', CastAudio: '🔊', Tablet: '📱' }[type] || '🎵';
}

function select(key, opts, val, suffix = '') {
  return `<select data-setting="${key}">${opts
    .map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}${suffix}</option>`)
    .join('')}</select>`;
}

function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// ---------- Spiel ----------

function viewGame() {
  const g = S.game;
  const r = g.round;
  const active = playerById(r?.playerId);
  const shownId = S.ui.viewPlayerId || r?.playerId || g.you;
  const shown = playerById(shownId) || me();
  return `<main class="game phase-${g.phase}">
    <header class="topbar">
      ${logo()}
      <span class="muted small">Raum ${esc(g.code)} · 🃏 ${g.deckLeft}</span>
      <button class="icon-btn" data-action="togglePlayers" aria-label="Spieler">👥</button>
    </header>
    ${viewScoreboard()}
    ${g.phase === 'over' ? viewOver() : `
      ${viewAudioBar()}
      ${viewStatus(active)}
      ${shown.id !== r?.playerId ? `<button class="btn ghost small back" data-action="viewPlayer" data-id="${shown.id}">← zurück zu ${esc(active?.name)}</button>` : ''}
      ${viewTimeline(shown)}
      ${viewActions(active)}`}
    ${S.ui.showPlayers ? viewPlayersSheet() : ''}
  </main>`;
}

function viewScoreboard() {
  const g = S.game;
  return `<nav class="scores">${g.players
    .map(
      (p) => `<button class="score ${p.id === g.round?.playerId ? 'active' : ''} ${p.id === S.ui.viewPlayerId ? 'viewing' : ''} ${p.connected ? '' : 'off'}" data-action="viewPlayer" data-id="${p.id}">
      <span class="avatar" style="--h:${hue(p.name)}">${esc(p.name[0].toUpperCase())}</span>
      <span class="score-name">${esc(p.id === g.you ? 'Du' : p.name)}</span>
      <span class="score-stats">🃏${p.timeline.length}/${g.settings.targetCards} · 🪙${p.tokens}</span></button>`,
    )
    .join('')}</nav>`;
}

function viewPlayersSheet() {
  const g = S.game;
  return `<div class="modal" data-action="togglePlayers"><div class="modal-box">
    <h2>Raum ${esc(g.code)}</h2>
    <button class="btn primary wide" data-action="share">📨 Weitere Freunde einladen</button>
    <ul class="players">${g.players
      .map(
        (p) => `<li><span class="avatar" style="--h:${hue(p.name)}">${esc(p.name[0].toUpperCase())}</span><span class="grow">${esc(p.name)} <span class="small">${{ youtube: '▶️', preview: '🎧', spotify: '🟢', off: '🔇' }[p.audioMode] || ''}</span> ${p.connected ? '' : '<span class="muted small">offline</span>'}</span>
        ${isHost() && p.id !== g.you ? `<button class="icon-btn" data-action="kick" data-id="${p.id}">✕</button>` : ''}</li>`,
      )
      .join('')}</ul>
    ${viewAudioCard()}
    ${isHost() && g.phase === 'placing' ? `<button class="btn ghost wide" data-action="forceNext">Aktuellen Zug überspringen</button>` : ''}
    <details class="rules"><summary>Spielregeln</summary>${rulesHtml()}</details>
    <div class="row end"><button class="btn danger" data-action="leave">${isHost() ? 'Spiel beenden' : 'Raum verlassen'}</button>
    <button class="btn ghost" data-action="togglePlayers">Schließen</button></div>
  </div></div>`;
}

function viewAudioBar() {
  const mode = audioMode();
  const r = S.game.round;
  if (mode === 'off') {
    return `<div class="hostbar"><span class="grow small">🔇 Kein Ton auf diesem Handy</span>
      <button class="btn ghost small" data-action="togglePlayers">Ändern</button></div>`;
  }
  if (mode === 'spotify') return viewSpotifyBar();
  const ytFailed = r.youtubeId && r.youtubeId === yt.failedId;
  if (mode === 'youtube' && !ytFailed && (r.youtubeId || r.yt === 'loading' || !r.yt)) {
    if (S.audio.blocked) return `<button class="btn primary wide big" data-action="playPreview">▶ Tippen zum Abspielen</button>`;
    return `<div class="hostbar"><span class="grow small">${
      r.youtubeId ? (S.audio.playing ? '▶️ Song läuft (YouTube)' : '▶️ Song pausiert') : '⏳ Suche Song auf YouTube…'
    }</span>
      ${r.youtubeId ? `<button class="icon-btn" data-action="replay" aria-label="Von vorn">⏮</button>
      <button class="icon-btn" data-action="${S.audio.playing ? 'pause' : 'playPreview'}" aria-label="Play/Pause">${S.audio.playing ? '⏸' : '▶'}</button>` : ''}
      <button class="icon-btn" data-action="togglePlayers" aria-label="Ton-Einstellungen">⚙️</button></div>`;
  }
  const fallback =
    mode === 'youtube'
      ? ytFailed
        ? 'Video hier nicht abspielbar – '
        : r.yt === 'quota'
          ? 'YouTube-Tageslimit erreicht – '
          : 'Nicht auf YouTube gefunden – '
      : '';
  if (S.audio.blocked && S.audio.src) {
    return `<button class="btn primary wide big" data-action="playPreview">▶ Tippen zum Abspielen</button>`;
  }
  const status =
    fallback +
    (r.audio === 'ready'
      ? S.audio.playing
        ? '🎧 Hörprobe läuft'
        : '🎧 Hörprobe pausiert'
      : r.audio === 'missing'
        ? '⚠️ Für diesen Song gibt es keine Hörprobe'
        : '⏳ Hörprobe lädt…');
  return `<div class="hostbar ${r.audio === 'missing' ? 'err' : ''}">
    <span class="grow small">${status}</span>
    ${r.audio === 'ready' ? `<button class="icon-btn" data-action="replay" aria-label="Von vorn">⏮</button>
    <button class="icon-btn" data-action="${S.audio.playing ? 'pause' : 'playPreview'}" aria-label="Play/Pause">${S.audio.playing ? '⏸' : '▶'}</button>` : ''}
    <button class="icon-btn" data-action="togglePlayers" aria-label="Ton-Einstellungen">⚙️</button>
  </div>`;
}

function viewSpotifyBar() {
  const h = S.host;
  if (!spotify.isLoggedIn()) {
    return `<div class="hostbar err"><span class="grow small">⚠️ Nicht mit Spotify verbunden</span>
      <button class="btn ghost small" data-action="togglePlayers">Ändern</button></div>`;
  }
  const dev = h.devices?.find((d) => d.id === h.deviceId);
  return `<div class="hostbar ${h.playError ? 'err' : ''}">
    <span class="grow small">${h.playError ? '⚠️ ' + esc(h.playError) : `🔊 ${esc(dev?.name || 'Spotify')}${h.playing ? ' · läuft' : ''}`}</span>
    <button class="icon-btn" data-action="replay" aria-label="Abspielen">▶</button>
    <button class="icon-btn" data-action="pause" aria-label="Pause">⏸</button>
    ${h.playError ? '<button class="icon-btn" data-action="loadDevices" aria-label="Geräte">🔎</button>' : ''}
    <button class="icon-btn" data-action="togglePlayers" aria-label="Ton-Einstellungen">⚙️</button>
  </div>
  ${h.playError && h.devices?.length ? `<div class="card">${viewDevices()}</div>` : ''}`;
}

function viewStatus(active) {
  const g = S.game;
  const r = g.round;
  const mine = r.playerId === g.you;
  const name = esc(active?.name || '?');
  if (g.phase === 'placing') {
    return mine
      ? `<div class="status you"><div class="eq"><i></i><i></i><i></i><i></i></div><div><b>Du bist dran!</b><br><span class="small">Wo gehört der Song hin? Tippe auf eine Lücke.</span></div></div>`
      : `<div class="status"><div class="eq"><i></i><i></i><i></i><i></i></div><div><b>${name}</b> ordnet den Song ein…<br><span class="small muted">Denk schon mal mit – gleich darfst du challengen.</span></div></div>`;
  }
  if (g.phase === 'challenge') {
    return `<div class="status challenge"><span class="timer" data-countdown></span><div><b>Challenge-Zeit!</b><br><span class="small">${
      mine ? 'Die anderen überlegen, ob du falsch liegst…' : `Glaubst du, ${name} liegt falsch?`
    }</span></div></div>`;
  }
  if (g.phase === 'reveal') return viewReveal(active);
  return '';
}

function viewReveal(active) {
  const g = S.game;
  const r = g.round;
  const res = r.result;
  const c = r.card;
  let text;
  if (res.kind === 'bought') text = `${esc(active.name)} hat die Karte gekauft.`;
  else if (res.activeCorrect) text = r.playerId === g.you ? '🎉 Richtig! Die Karte gehört dir.' : `🎉 ${esc(active.name)} lag richtig!`;
  else if (res.winnerId) {
    const w = playerById(res.winnerId);
    text = res.winnerId === g.you ? '🔥 Challenge gewonnen! Die Karte gehört dir.' : `😬 Falsch – ${esc(w?.name)} schnappt sich die Karte!`;
  } else text = '❌ Leider falsch – die Karte fliegt raus.';
  const guess =
    res.guessCorrect
      ? `<p class="ok small">+1 🪙 für Titel & Interpret!</p>`
      : r.guess?.title || r.guess?.artist
        ? `<p class="muted small">Getippt: „${esc(r.guess.title)}“ von ${esc(r.guess.artist)} – kein Token.</p>`
        : '';
  return `<div class="reveal">
    ${songCard(c, 'big')}
    <p class="reveal-text">${text}</p>${guess}
  </div>`;
}

function songCard(c, cls = '') {
  return `<div class="song ${cls}" style="--h:${decadeHue(c.year)}">
    ${c.cover ? `<img src="${esc(c.cover)}" alt="" loading="lazy">` : ''}
    <div class="song-info"><span class="song-artist">${esc(c.artist)}</span><span class="song-year">${c.year}</span><span class="song-title">${esc(c.title)}</span></div>
  </div>`;
}

function decadeHue(y) {
  return (((Math.floor(y / 10) * 10 - 1950) / 10) * 47 + 200) % 360;
}

function viewTimeline(p) {
  const g = S.game;
  const r = g.round;
  const isActiveTl = p.id === r?.playerId;
  const placing = g.phase === 'placing' && isActiveTl && r.playerId === g.you;
  const myChallenge = r?.challenges.find((c) => c.playerId === g.you);
  const canChallenge =
    g.phase === 'challenge' && isActiveTl && r.playerId !== g.you && !myChallenge && !r.passes.includes(g.you) && me()?.tokens > 0;
  const showMarkers = isActiveTl && (g.phase === 'placing' || g.phase === 'challenge' || g.phase === 'reveal');
  const items = [];
  const n = p.timeline.length;

  // In der Auflösung ist die Karte schon eingefügt – Marker beziehen sich auf die alte Zeitleiste.
  const placedId = g.phase === 'reveal' ? r.card?.id : null;
  const tl = p.timeline;
  const base = placedId && isActiveTl ? tl.filter((c) => c.id !== placedId) : tl;

  const slotHtml = (i) => {
    const taken = showMarkers ? r.challenges.filter((c) => c.slot === i) : [];
    const isActiveSlot = showMarkers && r.slot === i && g.phase !== 'reveal';
    if (isActiveSlot) {
      return `<div class="slot chosen" ${placing ? `data-action="slot" data-slot="${i}"` : ''}>${mysteryCard(playerById(r.playerId))}</div>`;
    }
    const chips = taken
      .map((c) => `<span class="chip" style="--h:${hue(playerById(c.playerId)?.name)}">⚔️ ${esc(playerById(c.playerId)?.name)}</span>`)
      .join('');
    if (placing || (canChallenge && !taken.length)) {
      const sel = canChallenge && S.ui.challengeSlot === i;
      return `<button class="slot open ${sel ? 'selected' : ''}" data-action="slot" data-slot="${i}">${sel ? mysteryCard(me(), true) : '<span>＋ hier</span>'}</button>`;
    }
    if (chips) return `<div class="slot chips">${chips}</div>`;
    return `<div class="slot gap"></div>`;
  };

  if (placedId && isActiveTl) {
    // Auflösung: Zeitleiste mit neu eingefügter Karte, markiert.
    tl.forEach((c, i) => items.push(timelineCard(c, c.id === placedId)));
  } else {
    for (let i = 0; i <= base.length; i++) {
      items.push(slotHtml(i));
      if (i < base.length) items.push(timelineCard(base[i], placedId === base[i].id));
    }
  }

  return `<section class="timeline-wrap">
    <div class="tl-head"><span>${p.id === g.you ? 'Dein Zeitstrahl' : `Zeitstrahl von ${esc(p.name)}`}</span><span class="muted small">${n} ${n === 1 ? "Karte" : "Karten"} · älter ↑ neuer ↓</span></div>
    <div class="timeline">${items.join('')}</div>
  </section>`;
}

function timelineCard(c, highlight) {
  return `<div class="tl-card ${highlight ? 'new' : ''}" style="--h:${decadeHue(c.year)}">
    <span class="tl-year">${c.year}</span>
    <span class="tl-meta"><span class="tl-title">${esc(c.title)}</span><span class="tl-artist">${esc(c.artist)}</span></span>
  </div>`;
}

function mysteryCard(p, challenge = false) {
  return `<div class="mystery ${challenge ? 'ch' : ''}"><div class="eq"><i></i><i></i><i></i><i></i></div><span>${
    challenge ? 'Deine Challenge' : p?.id === S.game.you ? 'Dein Tipp' : `Tipp von ${esc(p?.name)}`
  }</span><b>?</b></div>`;
}

function viewActions(active) {
  const g = S.game;
  const r = g.round;
  const mine = r.playerId === g.you;
  const my = me();
  if (g.phase === 'placing' && mine) {
    return `<div class="actions">
      <button class="guess-toggle" data-action="toggleGuess">${S.ui.guessOpen ? '▾' : '▸'} Bonus: Titel & Interpret raten (+1 🪙)</button>
      ${
        S.ui.guessOpen
          ? `<div class="guess"><input data-bind="guessTitle" value="${esc(S.ui.guess.title)}" placeholder="Titel" autocomplete="off">
             <input data-bind="guessArtist" value="${esc(S.ui.guess.artist)}" placeholder="Interpret" autocomplete="off"></div>`
          : ''
      }
      <div class="row">
        <button class="btn ghost" data-action="skip" ${my.tokens < 1 ? 'disabled' : ''}>⏭ −1🪙</button>
        <button class="btn ghost" data-action="buy" ${my.tokens < g.settings.buyCost ? 'disabled' : ''}>🛒 −${g.settings.buyCost}🪙</button>
        <button class="btn primary grow" data-action="lockIn" ${r.slot === null ? 'disabled' : ''}>Festlegen ✓</button>
      </div></div>`;
  }
  if (g.phase === 'challenge' && !mine) {
    const decided = r.challenges.some((c) => c.playerId === g.you) || r.passes.includes(g.you);
    if (decided) return `<div class="actions"><p class="center muted">Warte auf die anderen… <span data-countdown></span></p></div>`;
    if (my.tokens < 1) return `<div class="actions"><p class="center muted">Keine Tokens – du schaust diesmal zu.</p></div>`;
    return `<div class="actions">
      <p class="small center">Tippe eine <b>andere</b> Lücke an, um zu challengen (kostet 1 🪙).</p>
      <div class="row"><button class="btn ghost grow" data-action="pass">Passen</button>
      <button class="btn danger grow" data-action="challenge" ${S.ui.challengeSlot === null ? 'disabled' : ''}>⚔️ Challenge!</button></div></div>`;
  }
  if (g.phase === 'reveal') {
    const can = mine || isHost();
    return `<div class="actions">${
      can
        ? `<button class="btn primary wide big" data-action="next">Nächster Song →</button>`
        : `<p class="center muted">Warte auf ${esc(active?.name)}…</p>`
    }</div>`;
  }
  return '';
}

function viewOver() {
  const g = S.game;
  const ranked = g.players.slice().sort((a, b) => b.timeline.length - a.timeline.length || b.tokens - a.tokens);
  const winners = g.winnerIds.map((id) => playerById(id)?.name).filter(Boolean);
  const iWon = g.winnerIds.includes(g.you);
  const r = g.round;
  return `<section class="over">
    <div class="confetti">${'<i></i>'.repeat(24)}</div>
    <h1>${iWon ? '🏆 Du hast gewonnen!' : `🏆 ${esc(winners.join(' & '))} gewinnt!`}</h1>
    ${r?.card ? `<p class="muted small">Letzter Song:</p>${songCard(r.card)}` : ''}
    <ol class="ranking">${ranked
      .map((p) => `<li><span class="grow">${esc(p.name)}</span><span>🃏 ${p.timeline.length} · 🪙 ${p.tokens}</span></li>`)
      .join('')}</ol>
    ${
      isHost()
        ? `<button class="btn primary wide big" data-action="restart">Nochmal spielen</button>
           <button class="btn ghost wide" data-action="toLobby">Zur Lobby (Songs/Einstellungen ändern)</button>`
        : `<p class="center muted">Der Host kann eine neue Runde starten.</p>`
    }
    <button class="btn ghost wide" data-action="leave">${isHost() ? 'Spiel beenden' : 'Verlassen'}</button>
  </section>`;
}

// ---------- Start ----------

async function boot() {
  try {
    S.config = await (await fetch('/config.json')).json();
  } catch {}
  if (!S.config.spotifyClientId) S.config.spotifyClientId = LS.get('hit31.clientId', '');
  spotify.setClientId(S.config.spotifyClientId);

  try {
    if (await spotify.handleRedirect()) {
      const intent = LS.get('hit31.intent');
      LS.set('hit31.intent', null);
      if (intent?.action === 'create' && !S.session) {
        S.busy = 'create';
        send({ type: 'create', name: intent.name });
      }
    }
  } catch (e) {
    showToast(e.message);
  }
  connect();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
