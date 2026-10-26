# Namefinder

Öffentlich gehosteter Firmennamen-Finder: Claude oder OpenAI schlägt Firmennamen vor, ein Domain-Check
(DNS-Vorfilter, dann RDAP bei DENIC bzw. Verisign) zeigt, welche .de/.com-Domains frei sind.
Zugang per Passwort, Ergebnisse werden live (SSE) gestreamt.

## Lokale Entwicklung

```bash
cp .env.example .env   # Werte setzen (APP_PASSWORD, ANTHROPIC_API_KEY und/oder OPENAI_API_KEY)
npm install
npm run dev
```

## Docker lokal

```bash
cp .env.example .env
docker compose up --build
```

Erreichbar unter http://127.0.0.1:8787 (nur lokal gebunden).

## Deployment auf einem VPS

Die App bringt keinen eigenen Reverse-Proxy mit. Sie lauscht nur auf `127.0.0.1:8787`
(änderbar über `HOST_PORT`); HTTPS übernimmt der vorhandene Caddy auf dem VPS.

1. `git clone <repo> && cd namefinder`
2. `cp .env.example .env` und alle Werte setzen.
3. `docker compose up -d --build`
4. Im Caddyfile des VPS einen Eintrag ergänzen und Caddy neu laden (`systemctl reload caddy`):

   ```caddyfile
   namefinder.example.com {
   	encode zstd gzip
   	reverse_proxy 127.0.0.1:8787 {
   		# Live-Updates (SSE) nicht puffern
   		flush_interval -1
   	}
   }
   ```

Läuft Caddy selbst in einem Docker-Container, erreicht er `127.0.0.1` des Hosts nicht. Dann den
App-Container in dasselbe Docker-Netzwerk wie Caddy hängen und `reverse_proxy app:8787` verwenden.

`TRUST_PROXY=true` lassen: Die App nimmt die Client-IP (für die Login-Sperre) aus dem letzten
Eintrag von `X-Forwarded-For`, den Caddy setzt. Updates: `git pull` und `docker compose up -d --build`.
Daten (SQLite) liegen im Volume `namefinder-data`.

## Umgebungsvariablen

| Variable | Default | Bedeutung |
|---|---|---|
| `APP_PASSWORD` | – (Pflicht) | Zugangspasswort |
| `ANTHROPIC_API_KEY` | – | API-Key für Claude |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Claude-Modell |
| `OPENAI_API_KEY` | – | API-Key für OpenAI |
| `OPENAI_MODEL` | `gpt-5.5` | OpenAI-Modell |
| `GENERATIONS_PER_HOUR` | `10` | Generierungen pro Stunde |
| `MAX_GENERATIONS_PER_DAY` | `50` | Generierungen pro Tag (Kostendeckel) |
| `LOGIN_MAX_ATTEMPTS` | `5` | Fehlversuche bis zur Sperre |
| `LOGIN_LOCK_MINUTES` | `15` | Sperrdauer |
| `WHOIS_CACHE_HOURS` | `24` | Cache-Dauer für belegte Domains (Stunden) |
| `WHOIS_CACHE_FREE_HOURS` | `1` | Cache-Dauer für freie Domains (Stunden) |
| `DENIC_INTERVAL_MS` | `2000` | Mindestabstand zwischen .de-Abfragen (DENIC) |
| `VERISIGN_INTERVAL_MS` | `250` | Mindestabstand zwischen .com-Abfragen (Verisign) |
| `TRUST_PROXY` | `true` | Client-IP aus Proxy-Headern verwenden |
| `DATA_DIR` | `./data` (Docker: `/data`) | Ablage der SQLite-Datenbank |
| `STATIC_DIR` | `../web/dist` | Auszuliefernde Frontend-Dateien |
| `PORT` | `8787` | Server-Port im Container |
| `HOST_PORT` | `8787` | Port auf dem Host (nur `127.0.0.1`), Ziel für den Reverse-Proxy |

## Hinweise

- **Domain-Check:** Zuerst ein schneller DNS-Vorfilter (existiert ein Eintrag, ist die Domain belegt),
  für verbleibende Kandidaten eine RDAP-Abfrage (DENIC für .de, Verisign für .com).
- **Rate-Limits:** Pro Stunde und pro Tag begrenzte Generierungen sowie Login-Sperre nach Fehlversuchen.
- **KI-Anbieter:** Mindestens einen der beiden API-Keys setzen. Sind beide gesetzt, erscheint im Formular eine Auswahl
  (Claude ist voreingestellt); im Verlauf steht, welcher Anbieter die Namen geliefert hat. Die Limits gelten für beide zusammen.
- **Kosten:** Mit Sonnet 5.5 ca. 1–3 Cent pro Generierung; `MAX_GENERATIONS_PER_DAY` begrenzt die Tageskosten.
- **Markenrecht:** Eine freie Domain ist keine freie Marke. Vor Verwendung eines Namens
  Marken-Register (DPMA, EUIPO, WIPO) prüfen; die App ersetzt keine Rechtsberatung.
