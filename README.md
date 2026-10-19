# Hit31 🎵 – Musik-Zeitstrahl fürs Handy

Partyspiel nach dem Hitster-Prinzip, als reine Handy-App:
**Song hören → Jahr schätzen → an der richtigen Stelle in deinen Zeitstrahl legen.**
Die Musik kommt aus deinem Spotify, deine Freunde machen per Code oder Link mit – ohne App-Store, ohne Spotify-Konto.

## So funktioniert's

1. **Host** (du) öffnet die App → *Spiel erstellen* → mit Spotify anmelden.
2. Playlists auswählen (eigene Playlists, Lieblingssongs oder ein Playlist-Link) und das Wiedergabegerät wählen (dein Handy, eine Box, ein TV… alles, was Spotify Connect kann).
3. **Freunde einladen**: über *Freunde einladen* / WhatsApp den Link schicken oder den 4-stelligen Code sagen. Sie öffnen den Link im Handy-Browser, geben ihren Namen ein – fertig.
4. Spielen:
   - Jeder startet mit einer aufgedeckten Karte.
   - Wer dran ist, hört den Song und tippt auf die Lücke im Zeitstrahl, wo er hingehört (älter oben, neuer unten). Bonus: Titel **und** Interpret richtig tippen → +1 🪙.
   - Danach dürfen alle anderen mit 1 🪙 **challengen** (andere Lücke wählen). Liegt der Spieler falsch und der Challenger richtig, bekommt der Challenger die Karte.
   - Mit Tokens: Song überspringen (1 🪙) oder Karte kaufen (3 🪙).
   - Wer zuerst die Ziel-Anzahl Karten hat (Standard 10), gewinnt.

### Online spielen (jeder an einem anderen Ort)

Jeder wählt auf seinem Handy, wie er die Musik hört („Wie hörst du die Musik?“ in der Lobby oder im Menü ⚙️):

| Modus | Was passiert | Voraussetzung |
| --- | --- | --- |
| ▶️ **YouTube** (Standard für Mitspieler, wenn eingerichtet) | ganzer Song ab 0:00 über ein eingebettetes YouTube-Video, das von einer „?“-Karte verdeckt wird | nichts – kein Konto; Server braucht `YOUTUBE_API_KEY` |
| 🎧 **Hörprobe** | 30-Sekunden-Ausschnitt in Dauerschleife, direkt im Browser | nichts – kein Konto |
| 🟢 **Eigenes Spotify** (Standard für Host) | ganzer Song über das eigene Spotify (Handy, Box, TV) | Spotify Premium + im Spotify-Dashboard unter *User Management* eingetragen (max. 5) |
| 🔇 **Kein Ton** | still | man sitzt neben jemandem, bei dem die Musik läuft |

**YouTube einrichten:** In der [Google Cloud Console](https://console.cloud.google.com/) ein Projekt anlegen, „YouTube Data API v3“ aktivieren, unter *Anmeldedaten* einen API-Schlüssel erstellen und als `YOUTUBE_API_KEY` auf dem Server setzen. Hinweis: Das Verdecken des Players widerspricht den YouTube-API-Nutzungsbedingungen; im schlimmsten Fall sperrt Google den Schlüssel, dann läuft automatisch die Hörprobe. Das kostenlose Kontingent reicht für ca. 100 neue Songs pro Tag; gefundene Videos werden zwischengespeichert. Findet sich kein Video, ist es nicht abspielbar oder ist das Tageslimit erreicht, läuft automatisch die Hörprobe.

Die Hörproben kommen von der öffentlichen Deezer-API und werden über den Hit31-Server ausgeliefert, damit niemand am Link den Titel erkennt. Gibt es zu einem Song keine Hörprobe und braucht jemand eine, wird automatisch ein anderer Song gezogen.

Die App ist eine installierbare Web-App (PWA): im Browser *„Zum Home-Bildschirm hinzufügen“* → startet dann im Vollbild wie eine normale App. Der Bildschirm bleibt während des Spiels an.

## Voraussetzungen

- **Spotify Premium** für den Host (Spotify erlaubt das Fernsteuern der Wiedergabe nur mit Premium). Mitspieler brauchen nichts.
- Die **Spotify-App muss auf dem Abspielgerät offen sein** (einmal kurz öffnen reicht, wenn sie im Hintergrund weiterläuft).
- Ein Server, auf dem die App läuft (siehe unten) – nötig, damit sich alle Handys verbinden können.

## Einrichtung

### 1. Spotify-App anlegen (einmalig, 2 Minuten)

1. <https://developer.spotify.com/dashboard> → **Create app**.
2. Name/Beschreibung egal, bei *APIs* „Web API“ anhaken.
3. **Redirect URI**: die Adresse deiner App mit `/` am Ende, z. B. `https://hit31-production.up.railway.app/`
   (lokal zum Testen: `http://127.0.0.1:3000/`).
4. **Client ID** kopieren.
5. Unter *User Management* die Spotify-E-Mail-Adresse von jedem eintragen, der **hosten** will (im Entwicklungsmodus erlaubt Spotify nur eine kleine Anzahl freigeschalteter Nutzer – Mitspieler ohne Spotify-Login zählen nicht).

### 2. Server starten

Lokal:

```bash
npm install
SPOTIFY_CLIENT_ID=deine_client_id npm start
# → http://127.0.0.1:3000
```

Online (damit Freunde über Handy-Netz mitspielen können), z. B. auf **Railway**, Render oder Fly.io:

- Repo verbinden, Start-Befehl `npm start` (wird automatisch erkannt).
- Umgebungsvariable `SPOTIFY_CLIENT_ID` setzen.
- Die vergebene HTTPS-Adresse als Redirect URI bei Spotify eintragen.

Ohne `SPOTIFY_CLIENT_ID` fragt die App beim ersten *Spiel erstellen* nach der Client ID und merkt sie sich auf dem Handy.

## Technik

| Teil | Datei |
| --- | --- |
| Spielregeln & Zustand (serverseitig, getestet) | `server/game.js` |
| Tolerantes Prüfen von Titel/Interpret | `server/fuzzy.js` |
| HTTP + WebSocket-Räume, Reconnect, Challenge-Timer | `server/index.js` |
| App-Oberfläche (Vanilla JS, kein Build) | `public/app.js`, `public/styles.css` |
| Spotify-Login (PKCE), Playlists, Wiedergabe | `public/spotify.js` |
| 30-s-Hörproben über Deezer | `server/audio.js` |

- Der Server entscheidet über alle Regeln; welcher Song läuft, erfährt nur das Host-Handy (als Spotify-URI zum Abspielen) – die anderen sehen Titel und Jahr erst bei der Auflösung.
- Fällt die Verbindung weg (Handy gesperrt, Funkloch), verbindet sich die App automatisch wieder und landet im selben Spiel.
- Tests: `npm test`

## Bekannte Grenzen

- **Erscheinungsjahr**: Spotify liefert das Jahr des *Albums*. Bei Remastern/Neuauflagen kann es daher später sein als das Original. „Best-of/Sampler ausschließen“ hilft schon viel; am besten funktionieren Playlists mit Original-Alben.
- **Fremde Playlists**: Spotify sperrt für Apps manche Playlists, die nicht dir gehören (v. a. Spotify-eigene/redaktionelle Playlists). Tipp: solche Songs in eine eigene Playlist kopieren.
- **Nicht aufs Spotify-Display schauen** – dort steht der Titel. 😉 Am besten eine Bluetooth-Box oder ein anderes Gerät per Spotify Connect nutzen.
- Räume liegen im Arbeitsspeicher des Servers; ein Server-Neustart beendet laufende Spiele.
