// Spiellogik (unabhängig von Netzwerk/Timern, damit sie testbar bleibt).
import { randomUUID, randomBytes } from 'node:crypto';
import { isGuessCorrect } from './fuzzy.js';

export const DEFAULT_SETTINGS = {
  targetCards: 10,
  startTokens: 2,
  maxTokens: 5,
  challengeSeconds: 20,
  buyCost: 3,
};

export const AUDIO_MODES = ['spotify', 'youtube', 'preview', 'off'];

export class GameError extends Error {}

const fail = (msg) => {
  throw new GameError(msg);
};

export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Liegt `year` korrekt, wenn die Karte an Position `slot` in die (sortierte) Zeitleiste kommt?
export function isPlacementCorrect(timeline, slot, year) {
  const prev = timeline[slot - 1];
  const next = timeline[slot];
  return (!prev || prev.year <= year) && (!next || year <= next.year);
}

function insertSorted(timeline, card) {
  let i = 0;
  while (i < timeline.length && timeline[i].year <= card.year) i++;
  timeline.splice(i, 0, card);
}

function sanitizeTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const year = Number(t.year);
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const uri = str(t.uri);
  const title = str(t.title);
  if (!uri.startsWith('spotify:track:') || !title || !Number.isInteger(year) || year < 1900 || year > 2100) {
    return null;
  }
  const artists = Array.isArray(t.artists) ? t.artists.map((a) => str(a)).filter(Boolean).slice(0, 10) : [];
  return {
    id: randomUUID(),
    uri,
    title,
    artists,
    artist: artists.join(', '),
    year,
    cover: str(t.cover, 500).startsWith('https://') ? str(t.cover, 500) : '',
    isrc: /^[A-Z0-9]{12}$/i.test(str(t.isrc, 20)) ? str(t.isrc, 20) : '',
  };
}

export class Game {
  constructor(code, rnd = Math.random) {
    this.code = code;
    this.rnd = rnd;
    this.players = new Map();
    this.order = [];
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'lobby';
    this.pool = []; // vom Host geladene Songs
    this.deck = [];
    this.turnIndex = 0;
    this.round = null;
    this.winnerIds = [];
    this.lastActivity = Date.now();
  }

  // ---------- Spieler ----------

  addPlayer(name) {
    name = String(name || '').trim().slice(0, 20);
    if (!name) fail('Bitte gib einen Namen ein.');
    if (this.players.size >= 12) fail('Der Raum ist voll (max. 12 Spieler).');
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      fail('Dieser Name ist schon vergeben.');
    }
    const p = {
      id: randomUUID(),
      secret: randomBytes(16).toString('hex'),
      name,
      tokens: this.settings.startTokens,
      timeline: [],
      connected: true,
      // Der Host spielt standardmäßig über Spotify, alle anderen hören die Hörprobe.
      audioMode: this.players.size === 0 ? 'spotify' : 'preview',
    };
    this.players.set(p.id, p);
    this.order.push(p.id);
    if (!this.hostId) this.hostId = p.id;
    // Wer mitten im Spiel dazukommt, bekommt sofort eine Startkarte.
    if (this.phase !== 'lobby' && this.phase !== 'over') {
      const card = this.deck.pop();
      if (card) p.timeline.push(card);
    }
    this.touch();
    return p;
  }

  removePlayer(id) {
    const p = this.player(id);
    const idx = this.order.indexOf(id);
    const wasActive = this.round && this.round.playerId === id;
    this.players.delete(id);
    this.order.splice(idx, 1);
    if (this.phase === 'lobby' || this.phase === 'over') return p;
    if (this.order.length === 0) {
      this.phase = 'over';
      return p;
    }
    if (idx < this.turnIndex) this.turnIndex--;
    if (wasActive) {
      this.turnIndex = this.turnIndex % this.order.length;
      this.startRound();
    } else if (this.round) {
      this.round.challenges = this.round.challenges.filter((c) => c.playerId !== id);
      this.round.passes = this.round.passes.filter((x) => x !== id);
      if (this.phase === 'challenge') this.maybeFinishChallenge();
    }
    return p;
  }

  player(id) {
    const p = this.players.get(id);
    if (!p) fail('Spieler nicht gefunden.');
    return p;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (this.phase === 'challenge') this.maybeFinishChallenge();
  }

  setAudioMode(id, mode) {
    if (!AUDIO_MODES.includes(mode)) fail('Unbekannter Ton-Modus.');
    this.player(id).audioMode = mode;
  }

  // Nutzt gerade jemand (verbunden) diesen Ton-Modus?
  usesMode(mode) {
    return [...this.players.values()].some((p) => p.connected && p.audioMode === mode);
  }

  needsPreview() {
    return this.usesMode('preview');
  }

  // Für den aktuellen Song gibt es keine Hörprobe -> anderen Song ziehen (gleicher Spieler).
  replaceCard(roundId) {
    if (this.phase !== 'placing' || this.round?.id !== roundId) return false;
    const misses = (this.round.audioMisses || 0) + 1;
    this.startRound();
    if (this.round) this.round.audioMisses = misses;
    return true;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  requireHost(id) {
    if (id !== this.hostId) fail('Nur der Host kann das.');
  }

  // ---------- Lobby ----------

  setPool(id, tracks) {
    this.requireHost(id);
    if (this.phase !== 'lobby' && this.phase !== 'over') fail('Songs können nur in der Lobby geändert werden.');
    if (!Array.isArray(tracks)) fail('Ungültige Songliste.');
    const seen = new Set();
    const pool = [];
    for (const t of tracks.slice(0, 3000)) {
      const s = sanitizeTrack(t);
      if (!s) continue;
      const key = s.uri;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(s);
    }
    this.pool = pool;
    this.touch();
  }

  updateSettings(id, patch) {
    this.requireHost(id);
    if (this.phase !== 'lobby' && this.phase !== 'over') fail('Einstellungen nur in der Lobby.');
    const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);
    this.settings.targetCards = clamp(patch.targetCards, 3, 20, this.settings.targetCards);
    this.settings.startTokens = clamp(patch.startTokens, 0, 5, this.settings.startTokens);
    this.settings.challengeSeconds = clamp(patch.challengeSeconds, 5, 60, this.settings.challengeSeconds);
    this.touch();
  }

  start(id) {
    this.requireHost(id);
    if (this.phase !== 'lobby' && this.phase !== 'over') fail('Das Spiel läuft bereits.');
    if (this.order.length < 1) fail('Keine Spieler.');
    const needed = this.order.length * this.settings.targetCards;
    if (this.pool.length < Math.min(needed, this.order.length + 10)) {
      fail(`Zu wenige Songs (${this.pool.length}). Wähle mehr Playlists aus.`);
    }
    this.deck = shuffle(this.pool, this.rnd);
    for (const pid of this.order) {
      const p = this.players.get(pid);
      p.tokens = this.settings.startTokens;
      p.timeline = [this.deck.pop()];
    }
    this.order = shuffle(this.order, this.rnd);
    this.turnIndex = 0;
    this.winnerIds = [];
    this.startRound();
    this.touch();
  }

  backToLobby(id) {
    this.requireHost(id);
    this.phase = 'lobby';
    this.round = null;
    this.winnerIds = [];
    for (const p of this.players.values()) {
      p.timeline = [];
      p.tokens = this.settings.startTokens;
    }
    this.touch();
  }

  // ---------- Runde ----------

  get activePlayerId() {
    return this.order[this.turnIndex];
  }

  startRound() {
    const card = this.deck.pop();
    if (!card) return this.finish();
    this.phase = 'placing';
    this.round = {
      id: randomUUID(),
      playerId: this.activePlayerId,
      card,
      slot: null,
      guess: { title: '', artist: '' },
      challenges: [],
      passes: [],
      deadline: null,
      result: null,
      audio: null, // Hörprobe: null | 'loading' | 'ready' | 'missing'
      yt: null, // YouTube: null | 'loading' | 'ready' | 'missing' | 'quota'
      ytId: null,
      audioMisses: 0,
    };
  }

  requireActive(id, phase) {
    if (this.phase !== phase) fail('Gerade nicht möglich.');
    if (this.round.playerId !== id) fail('Du bist nicht dran.');
  }

  selectSlot(id, slot) {
    this.requireActive(id, 'placing');
    const tl = this.player(id).timeline;
    if (!Number.isInteger(slot) || slot < 0 || slot > tl.length) fail('Ungültige Position.');
    this.round.slot = slot;
    this.touch();
  }

  setGuess(id, guess) {
    this.requireActive(id, 'placing');
    this.round.guess = {
      title: String(guess?.title || '').slice(0, 120),
      artist: String(guess?.artist || '').slice(0, 120),
    };
  }

  lockIn(id) {
    this.requireActive(id, 'placing');
    if (this.round.slot === null) fail('Wähle zuerst eine Position.');
    this.phase = 'challenge';
    this.round.deadline = Date.now() + this.settings.challengeSeconds * 1000;
    this.maybeFinishChallenge();
    this.touch();
  }

  skipSong(id) {
    this.requireActive(id, 'placing');
    const p = this.player(id);
    if (p.tokens < 1) fail('Du hast keine Chips.');
    p.tokens--;
    this.startRound();
    this.touch();
  }

  buyCard(id) {
    this.requireActive(id, 'placing');
    const p = this.player(id);
    if (p.tokens < this.settings.buyCost) fail(`Du brauchst ${this.settings.buyCost} Chips.`);
    p.tokens -= this.settings.buyCost;
    insertSorted(p.timeline, this.round.card);
    this.reveal({ kind: 'bought', winnerId: id, activeCorrect: true, guessCorrect: false });
  }

  // Spieler, die (noch) challengen könnten.
  eligibleChallengers() {
    return this.order.filter((pid) => {
      if (pid === this.round.playerId) return false;
      const p = this.players.get(pid);
      return p.connected && p.tokens > 0;
    });
  }

  challenge(id, slot) {
    if (this.phase !== 'challenge') fail('Gerade kannst du keinen Chip setzen.');
    if (id === this.round.playerId) fail('Auf deine eigene Karte kannst du keinen Chip setzen.');
    const p = this.player(id);
    const r = this.round;
    if (r.challenges.some((c) => c.playerId === id) || r.passes.includes(id)) fail('Du hast schon entschieden.');
    if (p.tokens < 1) fail('Du hast keine Chips.');
    const tl = this.player(r.playerId).timeline;
    if (!Number.isInteger(slot) || slot < 0 || slot > tl.length) fail('Ungültige Position.');
    if (slot === r.slot || r.challenges.some((c) => c.slot === slot)) fail('Diese Position ist schon belegt.');
    p.tokens--;
    r.challenges.push({ playerId: id, slot });
    this.maybeFinishChallenge();
    this.touch();
  }

  pass(id) {
    if (this.phase !== 'challenge') return;
    const r = this.round;
    if (id === r.playerId || r.passes.includes(id) || r.challenges.some((c) => c.playerId === id)) return;
    r.passes.push(id);
    this.maybeFinishChallenge();
    this.touch();
  }

  maybeFinishChallenge() {
    if (this.phase !== 'challenge') return;
    const r = this.round;
    const open = this.eligibleChallengers().filter(
      (pid) => !r.passes.includes(pid) && !r.challenges.some((c) => c.playerId === pid),
    );
    const freeSlots = this.player(r.playerId).timeline.length + 1 - 1 - r.challenges.length;
    if (open.length === 0 || freeSlots <= 0) this.resolve();
  }

  // Vom Server-Timer aufgerufen.
  challengeTimeout(roundId) {
    if (this.phase === 'challenge' && this.round.id === roundId) this.resolve();
  }

  resolve() {
    const r = this.round;
    const active = this.player(r.playerId);
    const { card } = r;
    const activeCorrect = isPlacementCorrect(active.timeline, r.slot, card.year);
    let winnerId = null;
    if (activeCorrect) {
      active.timeline.splice(r.slot, 0, card);
      winnerId = active.id;
    } else {
      const winner = r.challenges.find((c) => isPlacementCorrect(active.timeline, c.slot, card.year));
      if (winner) {
        winnerId = winner.playerId;
        insertSorted(this.player(winnerId).timeline, card);
      }
    }
    const guessCorrect = isGuessCorrect(r.guess, card);
    if (guessCorrect) active.tokens = Math.min(this.settings.maxTokens, active.tokens + 1);
    this.reveal({ kind: 'placed', winnerId, activeCorrect, guessCorrect });
  }

  reveal(result) {
    this.phase = 'reveal';
    this.round.deadline = null;
    this.round.result = result;
    this.winnerIds = this.order.filter(
      (pid) => this.players.get(pid).timeline.length >= this.settings.targetCards,
    );
    if (this.winnerIds.length) this.phase = 'over';
    this.touch();
  }

  next(id) {
    if (this.phase === 'reveal') {
      if (id !== this.round.playerId && id !== this.hostId) fail('Nur der aktive Spieler oder der Host.');
    } else if (this.phase === 'placing') {
      // Host darf den Zug überspringen, z. B. wenn jemand offline ist.
      this.requireHost(id);
    } else {
      fail('Gerade nicht möglich.');
    }
    this.turnIndex = (this.turnIndex + 1) % this.order.length;
    this.startRound();
    this.touch();
  }

  finish() {
    // Stapel leer: Wer die meisten Karten hat, gewinnt.
    const max = Math.max(...this.order.map((pid) => this.players.get(pid).timeline.length));
    this.winnerIds = this.order.filter((pid) => this.players.get(pid).timeline.length === max);
    this.phase = 'over';
  }

  // ---------- Sicht pro Spieler ----------

  viewFor(id) {
    const r = this.round;
    const revealed = this.phase === 'reveal' || this.phase === 'over';
    const view = {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      hostId: this.hostId,
      you: id,
      poolSize: this.pool.length,
      deckLeft: this.deck.length,
      winnerIds: this.winnerIds,
      players: this.order.map((pid) => {
        const p = this.players.get(pid);
        return {
          id: p.id,
          name: p.name,
          tokens: p.tokens,
          connected: p.connected,
          audioMode: p.audioMode,
          timeline: p.timeline.map(publicCard),
        };
      }),
      round: r && {
        id: r.id,
        playerId: r.playerId,
        slot: r.slot,
        challenges: r.challenges,
        passes: r.passes,
        deadline: r.deadline,
        card: revealed ? publicCard(r.card) : null,
        guess: revealed || id === r.playerId ? r.guess : null,
        result: r.result,
        audio: r.audio,
        audioUrl: r.audio === 'ready' ? `/audio/${this.code}/${r.id}` : null,
        yt: r.yt,
      },
    };
    if (r && this.players.get(id)?.audioMode === 'youtube') view.round.youtubeId = r.ytId;
    // Die Spotify-URI bekommt nur, wer über sein eigenes Spotify hört – ohne Titel/Jahr.
    if (r && this.players.get(id)?.audioMode === 'spotify') view.playUri = r.card.uri;
    return view;
  }
}

function publicCard(c) {
  return { id: c.id, title: c.title, artist: c.artist, year: c.year, cover: c.cover };
}
