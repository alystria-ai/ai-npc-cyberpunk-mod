# Conversation runtime

The CET adapter writes requests into the installed mod's `runtime` directory. The hidden Node bridge uses the project's ignored Convai key and character mapping. It starts no microphone capture until an explicit F7 command.

## Connections and turns

- Accepted companion spawns publish a party snapshot immediately, before entity attachment. Duplicate copies share a profile; dismissal, failed spawning, death and game loss remove identities that are no longer present. A two-second heartbeat keeps the bridge informed.
- Each present identity keeps a private connection. Up to three additional connections prepare the current group audience. The eight-slot party therefore needs at most eleven pages in one hidden browser. Connection setup is staggered, with retry cooldowns and silent keepalive checks.
- Private conversations and each distinct group audience use separate sessions. Opening a composer prioritizes the actual selected audience; closing it preserves the party's private connections.
- Only the addressed character appears in the composer heading. F8 schedules that character first and at most two different nearby identities. A duplicate copy cannot become an extra speaker.
- The next response may be prepared while the current speaker is heard. Full preparation uses an isolated new session; an existing session is only warmed because the SDK cannot roll back a cancelled speculative turn. Prepared output is adopted only when the submitted request exactly matches its identity, audience and delivered dialogue.
- A changed audience, superseding request, cancelled round, failed native playback or lost game heartbeat invalidates obsolete preparation. Speculative replies never directly publish audio or captions.

## Playback and evidence

Remote audio is captured silently and validated as PCM WAV. Eight reusable Audioware slots supply native positional playback; a playing slot is not overwritten. The native playback cursor drives this mod's dialogue subtitles. Facial frames are captured, but Cyberpunk facial animation and lip sync are still unfinished.

Installed runtime diagnostics:

- `party-connections.json`: game-owned membership and heartbeat.
- `party-connection-state.json`: connection state, setup timing and retries, without credentials or session IDs.
- `bridge-latency.json`: request, preparation, publication and observed native playback timing.
- `speech-state.json`: native playback state and cursor.

Service-only measurements are not proof of audible game behavior. The September 28 isolated comparison measured 8.90 seconds cold versus 3.90 seconds with a ready connection. Game acceptance remains recorded in `TODO.md`.

## Development

Run `npm test` and `npm run build:voice` after changing the bridge. Start it through `scripts/Start-ConversationBridge.ps1`; the launcher keeps helpers hidden and refuses a duplicate bridge process.

For Lua and catalog changes, `scripts/Install-DevelopmentMod.ps1 -LuaOnly` copies and verifies the files while the game is running. Activate them with CET's **Reload All Mods**. Redscript and native plugin changes still need a game restart. Use the request-file diagnostic path for game state; do not inject keyboard input or replay old spawn requests.
