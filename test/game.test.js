import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, isPlacementCorrect } from '../server/game.js';
import { isGuessCorrect, normalize } from '../server/fuzzy.js';

const track = (i, year) => ({ uri: `spotify:track:${i}`, title: `Song ${i}`, artists: [`Artist ${i}`], year, cover: '' });

// Deterministischer Zufall, damit Tests reproduzierbar sind.
function seeded(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function setup(n = 2) {
  const g = new Game('TEST', seeded());
  const players = Array.from({ length: n }, (_, i) => g.addPlayer('P' + i));
  g.setPool(players[0].id, Array.from({ length: 60 }, (_, i) => track(i, 1960 + i)));
  g.start(players[0].id);
  return { g, players };
}

const active = (g) => g.players.get(g.round.playerId);
const correctSlot = (g) => {
  const tl = active(g).timeline;
  for (let i = 0; i <= tl.length; i++) if (isPlacementCorrect(tl, i, g.round.card.year)) return i;
};
const wrongSlot = (g) => {
  const tl = active(g).timeline;
  for (let i = 0; i <= tl.length; i++) if (!isPlacementCorrect(tl, i, g.round.card.year)) return i;
  return null;
};

test('Platzierung prüfen inkl. gleicher Jahre', () => {
  const tl = [{ year: 1980 }, { year: 1990 }];
  assert.equal(isPlacementCorrect(tl, 0, 1975), true);
  assert.equal(isPlacementCorrect(tl, 1, 1985), true);
  assert.equal(isPlacementCorrect(tl, 2, 1999), true);
  assert.equal(isPlacementCorrect(tl, 0, 1985), false);
  assert.equal(isPlacementCorrect(tl, 0, 1980), true);
  assert.equal(isPlacementCorrect(tl, 1, 1980), true);
});

test('Start: jeder hat eine Karte und Start-Tokens', () => {
  const { g } = setup(3);
  assert.equal(g.phase, 'placing');
  for (const p of g.players.values()) {
    assert.equal(p.timeline.length, 1);
    assert.equal(p.tokens, 2);
  }
});

test('Richtig platziert: Karte geht an den aktiven Spieler', () => {
  const { g } = setup(2);
  const a = active(g);
  g.selectSlot(a.id, correctSlot(g));
  g.lockIn(a.id);
  assert.equal(g.phase, 'challenge');
  const other = [...g.players.values()].find((p) => p.id !== a.id);
  g.pass(other.id);
  assert.equal(g.phase, 'reveal');
  assert.equal(a.timeline.length, 2);
  assert.equal(g.round.result.activeCorrect, true);
});

test('Falsch platziert + erfolgreiche Challenge: Challenger bekommt die Karte', () => {
  const { g } = setup(2);
  // Runden durchspielen, bis eine falsche Position möglich ist (immer bei >=1 Karte).
  const a = active(g);
  const other = [...g.players.values()].find((p) => p.id !== a.id);
  const wrong = wrongSlot(g);
  if (wrong === null) return; // bei einer Karte gibt es immer eine falsche Seite, außer bei gleichem Jahr
  g.selectSlot(a.id, wrong);
  g.lockIn(a.id);
  g.challenge(other.id, correctSlot(g));
  assert.equal(g.phase, 'reveal');
  assert.equal(other.tokens, 1);
  assert.equal(other.timeline.length, 2);
  assert.equal(a.timeline.length, 1);
  assert.equal(g.round.result.winnerId, other.id);
});

test('Challenge auf belegte Position ist verboten', () => {
  const { g } = setup(3);
  const a = active(g);
  const others = [...g.players.values()].filter((p) => p.id !== a.id);
  g.selectSlot(a.id, 0);
  g.lockIn(a.id);
  assert.throws(() => g.challenge(others[0].id, 0), GameError);
  g.challenge(others[0].id, 1);
  // Bei 1 Karte gibt es nur 2 Positionen -> alle belegt -> automatisch aufgelöst.
  assert.equal(g.phase, 'reveal');
});

test('Timeout löst die Challenge-Phase auf', () => {
  const { g } = setup(2);
  const a = active(g);
  g.selectSlot(a.id, correctSlot(g));
  g.lockIn(a.id);
  g.challengeTimeout('falsche-id');
  assert.equal(g.phase, 'challenge');
  g.challengeTimeout(g.round.id);
  assert.equal(g.phase, 'reveal');
});

test('Ohne mögliche Challenger geht es direkt zur Auflösung', () => {
  const { g } = setup(2);
  for (const p of g.players.values()) p.tokens = 0;
  const a = active(g);
  g.selectSlot(a.id, 0);
  g.lockIn(a.id);
  assert.equal(g.phase, 'reveal');
});

test('Überspringen und Kaufen kosten Tokens', () => {
  const { g } = setup(2);
  const a = active(g);
  const firstRound = g.round.id;
  g.skipSong(a.id);
  assert.notEqual(g.round.id, firstRound);
  assert.equal(a.tokens, 1);
  assert.throws(() => g.buyCard(a.id), GameError);
  a.tokens = 3;
  g.buyCard(a.id);
  assert.equal(a.tokens, 0);
  assert.equal(a.timeline.length, 2);
  assert.equal(g.phase, 'reveal');
});

test('Erratener Titel + Interpret gibt einen Token', () => {
  const { g } = setup(2);
  const a = active(g);
  const { card } = g.round;
  g.setGuess(a.id, { title: card.title.toLowerCase(), artist: card.artists[0] });
  g.selectSlot(a.id, 0);
  g.lockIn(a.id);
  if (g.phase === 'challenge') g.challengeTimeout(g.round.id);
  assert.equal(g.round.result.guessCorrect, true);
  assert.equal(a.tokens, 3);
});

test('Wer zuerst die Zielanzahl erreicht, gewinnt', () => {
  const g = new Game('WIN', seeded(7));
  const p = g.addPlayer('Solo');
  g.setPool(p.id, Array.from({ length: 40 }, (_, i) => track(i, 1950 + i)));
  g.updateSettings(p.id, { targetCards: 3 });
  g.start(p.id);
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 50) {
    g.selectSlot(p.id, correctSlot(g));
    g.lockIn(p.id);
    if (g.phase === 'reveal') g.next(p.id);
  }
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.winnerIds, [p.id]);
  assert.equal(p.timeline.length, 3);
});

test('Sicht: Song bleibt geheim, nur der Host bekommt die URI', () => {
  const { g, players } = setup(2);
  for (const p of players) {
    const v = g.viewFor(p.id);
    assert.equal(v.round.card, null);
    assert.equal('playUri' in v, p.id === g.hostId);
    assert.ok(!JSON.stringify(v).includes(g.round.card.title), 'Titel darf nicht durchsickern');
  }
});

test('Aktiver Spieler verlässt das Spiel: nächster ist dran', () => {
  const { g } = setup(3);
  const a = active(g);
  g.removePlayer(a.id);
  assert.equal(g.phase, 'placing');
  assert.notEqual(g.round.playerId, a.id);
  assert.ok(g.players.has(g.round.playerId));
});

test('Ungültige Songs werden aussortiert, Duplikate entfernt', () => {
  const g = new Game('X');
  const p = g.addPlayer('H');
  g.setPool(p.id, [track(1, 1990), track(1, 1990), { uri: 'evil', title: 'x', year: 1990 }, track(2, 'abc'), null]);
  assert.equal(g.pool.length, 1);
});

test('Fuzzy-Vergleich ist tolerant', () => {
  assert.equal(normalize('Bohemian Rhapsody - Remastered 2011'), 'bohemianrhapsody');
  assert.ok(isGuessCorrect({ title: 'bohemian rapsody', artist: 'queen' }, { title: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'] }));
  assert.ok(isGuessCorrect({ title: '99 Luftballons', artist: 'Nena' }, { title: '99 Luftballons', artists: ['Nena'] }));
  assert.ok(isGuessCorrect({ title: 'Dont stop me now', artist: 'Queen' }, { title: "Don't Stop Me Now (Remastered)", artists: ['Queen'] }));
  assert.ok(!isGuessCorrect({ title: 'Yesterday', artist: 'Queen' }, { title: 'Bohemian Rhapsody', artists: ['Queen'] }));
  assert.ok(!isGuessCorrect({ title: 'Bohemian Rhapsody', artist: '' }, { title: 'Bohemian Rhapsody', artists: ['Queen'] }));
});

test('Ton-Modus: Spotify-URI nur für Spieler im Spotify-Modus, Hörprobe-Link wenn bereit', () => {
  const { g, players } = setup(3);
  const [host, a, b] = players;
  g.setAudioMode(b.id, 'spotify');
  g.setAudioMode(a.id, 'off');
  assert.throws(() => g.setAudioMode(a.id, 'laut'), GameError);
  assert.ok('playUri' in g.viewFor(host.id));
  assert.ok('playUri' in g.viewFor(b.id));
  assert.ok(!('playUri' in g.viewFor(a.id)));
  assert.equal(g.viewFor(a.id).round.audioUrl, null);
  g.round.audio = 'ready';
  assert.equal(g.viewFor(a.id).round.audioUrl, `/audio/TEST/${g.round.id}`);
});

test('Ohne Hörprobe wird ein anderer Song für denselben Spieler gezogen', () => {
  const { g } = setup(2);
  const { id, playerId } = g.round;
  const left = g.deck.length;
  assert.equal(g.replaceCard('falsch'), false);
  assert.equal(g.replaceCard(id), true);
  assert.notEqual(g.round.id, id);
  assert.equal(g.round.playerId, playerId);
  assert.equal(g.round.audioMisses, 1);
  assert.equal(g.deck.length, left - 1);
});
