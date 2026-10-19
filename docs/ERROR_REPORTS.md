# Automatic error reports

When the mod hits an error, it sends a small, redacted error report to the project's backend, so the developer sees the problem without asking players for logs. It is on by default. **Companion Manager > Settings > Privacy > Send error reports automatically** turns it off; then nothing is recorded or sent, and anything already waiting is deleted.

## For players

**What a report holds**

- What went wrong: the kind of error, its message and where in the code it happened.
- Versions: the mod's Scripts and Runtime, the game, Cyber Engine Tweaks, RED4ext, redscript, Codeware, Audioware, TweakXL, ArchiveXL, Node and Windows.
- Your choices: conversation provider, companion voice, Local AI model, interface language, and whether Mature content is on (on or off, nothing more).
- Your graphics card's name and memory.
- The setup check's lines (the same ones as on the Help page).
- Up to 150 log lines from around the error: the conversation service's log, the launcher's, the mod's own logs, and the error lines of the redscript log.
- A random number for your installation, hashed twice, so reports from one computer can be counted together without identifying it.

**What it never holds:** API keys or tokens, what you or the characters say, typed lines, character memories, microphone audio, voice files, or your Windows user name. Every log line goes through the same redactor as the support report (keys, tokens, IDs and your account name are removed), and then through a second filter that removes anything that looks like conversation text. Your IP address is not stored: the backend keeps only a keyed hash of it, for at most two hours, to limit how often one address can send.

**How often:** at most one report per kind of error per day, and at most five a day in all. Reports are sent in the background, a little after the error, never while a character is answering, and the mod never retries them in a loop.

**The notice.** The first time you load the game after updating, a notice says once that error reports are sent and where to turn them off.

**Where they go:** to the mod's own backend on Vercel (the same one that hands out the free tier's sign-in), stored for 30 days, readable only with the developer's admin secret.

The support report (**Settings > Help > Generate report**) says whether the setting is on, how many reports went out today and how many are waiting.

## How it works

```
 bridge (convai-bridge.mjs)        game Lua (mod/error-reports.lua)
   crash, failed turn, setup         service-silent, failed service,
   problem at start                  first-load setup check, versions
        |                                   |
        v                                   v
 <data>/error-reports/queue/<signature>.json     runtime/error-events.json
        \                                   /
         v                                 v
    supervisor (bridge-supervisor.mjs) + bridge/error-reports.mjs
      also: the service failed, the bridge exited, Lua errors in the mod's logs
        |
        v   one signed POST, 10 s timeout, off the turn path
    auth-backend  POST /api/errors/report  ->  Upstash Redis (30 days)
        |
        v
    scripts/Fetch-ErrorReports.mjs  ->  deliverables/error-reports/<signature>/<id>.json + INDEX.md
```

**Recording** (`bridge/error-events.mjs`, `mod/error-reports.lua`) only writes small files; nothing is sent from the bridge or the game.

- **Bridge crashes.** `installCrashCapture` listens on Node's `uncaughtExceptionMonitor`, which runs for an uncaught exception and for an unhandled rejection that ends the process, without changing how the process ends. It writes one queue file synchronously.
- **Failed turns.** After the failure reply is written, `ErrorEvents.turnFailed` records turns that failed for a reason that is not the player's own doing. Left out: a key the provider refused, a used-up plan or free limit, the daily allowance, the player's own custom endpoint or account (`custom-*`), a cancelled turn, Local AI that is not installed, does not fit the graphics memory or needs Mature content, and microphone turns that failed for the device. Kept: timeouts, crashes, a Local AI server that never answers, refused requests, a backend that is down.
- **Setup check.** The bridge's light check at start (version mismatch, packs one folder too deep, Local AI problems) and the game's first-load check (missing or old requirements, scripts that did not load). The game also writes the versions it knows (game, CET, Codeware, Audioware, TweakXL), which every report of that session carries.
- **The service.** The supervisor records `service-failed` (with the supervisor's code, such as `bridge-crashed` or `browser-missing`) and a bridge that exited unexpectedly (`bridge-crash`, with the exit code; skipped when the bridge recorded its own exception just before). The game records `service-silent` (a service that never came up) and failures only it saw (the start script's `install-incomplete`, `game-folder-not-visible`).
- **Lua errors.** The supervisor reads the mod's two logs from where it last stopped, at most every five minutes: `AiNpcCyberpunkMod.log` (where Cyber Engine Tweaks writes a callback's uncaught error) and `runtime/probe.log` (the errors the mod caught and logged, `... failed: init.lua:150: attempt to index ...`). Lines from before the first look are never reported.

**Signatures.** `kind + normalised message + top frame` hashed to 16 hex characters. The message loses folders, IDs, long hex runs, numbers, long quoted text, case and spacing; the frame loses its line and column numbers. The same fault in another folder, after another delay or a few lines further down gives the same signature.

**Sending** (`bridge/error-reports.mjs`, run by the supervisor). The supervisor is a separate process for the whole game session: it outlives a crashed bridge and is never on a turn's path, so a report costs a turn nothing.

- A supervisor event is sent 15 s after it happens; everything else is looked at a minute after start and then every five minutes (one directory listing, two file sizes, one small JSON read).
- Throttles: one report per signature per installation per UTC day; five per UTC day (`DAILY_LIMIT`); a 10 s timeout per request; a failed send waits 15 minutes and three failures stop it for the session; a `404` (a backend without this endpoint), `401` or `429` stops it for the session; a `400` or `413` drops that report. Waiting reports keep for a week.
- State: `<data>/error-reports/sent.json` (the UTC day, today's count and signatures, the last send, the positions read in the Lua logs) and the queue folder beside it. One writer at a time.
- The address: `/api/errors/report` on the first backend address that comes with a secret, signed with that secret: (1) the sign-in backend's own settings, `url` and `secret` in `convai-auth.json` in the data folder (or `CYBERPUNK_CONVAI_AUTH_URL` and `CYBERPUNK_CONVAI_AUTH_SECRET`), backend mode need not be on: a developer's machine; (2) `app/defaults/error-reports.json` in the Runtime, `{"version": 1, "url": "https://<deployment>", "secret": "<CONVAI_AUTH_SIGNING_SECRET>"}`, written by the release build: a player's install. Only the url's origin is used. `CYBERPUNK_CONVAI_ERRORS_URL` replaces the address. With neither, nothing is sent and events wait in the queue. The shipped secret is scrubbed from every report (error reports and Make support report.bat). Like the token endpoint's, it is obfuscation, not authentication: the limits are what bound abuse.

**The payload** (`buildErrorPayload`, at most 60 KB of JSON, far under 64 KB compressed):

```json
{
  "schema": 1, "install": "<32 hex: sha256 of the install id, salted>", "signature": "<16 hex>",
  "kind": "turn-failed", "message": "convai: Convai did not answer: timed out", "frame": "realtime-client.mjs:120 connect",
  "modVersion": "0.2.2", "count": 2,
  "report": {
    "source": "bridge", "firstAt": "...", "lastAt": "...", "sentAt": "...",
    "stack": ["realtime-client.mjs:120 connect", "..."], "detail": {"provider": "convai"},
    "versions": {"runtime": "0.2.2", "scripts": "0.2.2", "game": "2.31", "cet": "v1.35.0", "red4ext": "1.30.0", "codeware": "1.20.5", "...": "..."},
    "choices": {"provider": "convai", "effective": "convai", "voice": "pocket", "localModel": "auto", "matureContent": false, "language": "en"},
    "system": {"gpu": [{"name": "NVIDIA GeForce RTX 4070 Laptop GPU", "memoryMiB": 8188}]},
    "setup": ["versions: ok match", "game codeware: ok found"],
    "logs": [{"source": "bridge-stderr", "lines": ["..."]}, {"source": "service", "lines": ["..."]}],
    "privacy": {"redactions": {"secrets": 0, "ids": 3, "patterns": 1, "paths": 2}}
  }
}
```

Log sources and their share of the 150 lines: `bridge-stderr` 70 (the lines around the error's own message when it is found, else the end), `service` 20, `launcher` 10, `probe` 25 (around the error), `cet-mod` 15, `redscript` 10 (error lines only). Each line is cut to 300 characters.

Redaction, in order: the support report's `createRedactor` with every key file's value as a literal (`credentialSecrets`, `customServerSecrets`, `offlineSecrets`: the data folder's key files, the sign-in file's secret, the custom servers' keys, the packed key), then `withoutConversation` (quoted text of 12 characters or more with a space in it, and the values of `text=`, `reply:`, `prompt=`, `"text":`... fields), then the Windows account names this process can see (`USERNAME`, the profile folder, `os.userInfo()`). The `detail` object keeps only the fields the recorders write. `bridge/error-reports.test.mjs` runs the support report's planted secrets, IDs, account name and conversation text through the whole path and requires none of them to get out.

**Cost.** Nothing per frame and nothing per turn: a failed turn pays one function call (the file write is deferred), the game writes its file at most ten times a session, and the supervisor's five-minute look is a few file reads in another process.

## Backend

`auth-backend/README.md`, "Error reports", has the endpoint, its limits, the storage layout, the admin calls and the estimate against the Upstash free tier. In short: `POST /api/errors/report` (signed like the token endpoint, 64 KB cap, one Redis script per report: per-address hourly and per-install daily limits, dedup per install and signature per UTC day, an index per signature with counts, versions and first and last seen, at most 10 bodies per signature, at most 300 bodies a day for the whole service, everything with a 30-day TTL); `GET`/`DELETE /api/admin/errors` with the admin secret.

## Reading the reports

```
node scripts/Fetch-ErrorReports.mjs
```

It reads the backend address from `runtime/convai-auth.json` and the admin secret from `runtime/convai-auth-admin.txt` (never printed), fetches every report it does not have yet into `deliverables/error-reports/<signature>/<id>.json` and writes `deliverables/error-reports/INDEX.md`, a table of every signature with its counts, versions and first and last seen. Options: `--url`, `--admin-secret-file`, `--out`, `--limit`, `--delete-fetched`.

## Files

| File | What |
|---|---|
| `bridge/error-events.mjs` | Signatures, the queue, the bridge's recorder, the crash capture, the game's events file, the status for the support report |
| `bridge/error-reports.mjs` | The reporter: payload, redaction, throttles, sending, the Lua log scan |
| `bridge/bridge-supervisor.mjs` | Starts the reporter (`errorReports: true` from `packaging/runtime/start-service.mjs` and `scripts/Supervise-ConversationBridge.mjs`), reports `failed` and unexpected exits |
| `mod/error-reports.lua` | The game's events, the first-load versions, the one-time notice |
| `mod/manager.lua`, `mod/manager-ui.lua` | The setting (`errorReports` in `settings.json`, missing means on) and its row; the notice's flag (`errorReportsNoticed`) |
| `auth-backend/api/_lib/errors.js`, `errors-admin.js` | The endpoint and the admin calls |
| `scripts/Fetch-ErrorReports.mjs` | The developer's download |
