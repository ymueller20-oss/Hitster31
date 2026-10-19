// Tolerantes Vergleichen von getippten Titeln/Interpreten mit den Spotify-Daten.

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // (Remastered 2011), [Live]
    .replace(/\s[-–—]\s.*$/, ' ') // "Song - Remastered"
    .replace(/\b(feat|ft|featuring)\b.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/\b(the|and|und)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function similar(guess, actual) {
  const g = normalize(guess);
  const a = normalize(actual);
  if (!g || !a) return false;
  if (g === a) return true;
  const dist = levenshtein(g, a);
  return 1 - dist / Math.max(g.length, a.length) >= 0.75;
}

export function isGuessCorrect(guess, card) {
  if (!guess || !guess.title || !guess.artist) return false;
  const artists = card.artists?.length ? card.artists : [card.artist];
  return similar(guess.title, card.title) && artists.some((a) => similar(guess.artist, a));
}
