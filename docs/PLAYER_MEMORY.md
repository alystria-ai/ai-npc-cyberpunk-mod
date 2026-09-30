# Player memory

## Current policy

One persistent Convai `endUserId` belongs to this local player. Every named
character and every conversation channel uses that ID. Loading another save,
reloading CET, restarting the bridge, and either Forget action retain it.

Characters build provider memory from actual conversations. The first player
message enables memory on that verified mod-owned character profile. Spawning,
warming connections, reading quests, and automatic battle/loot triggers never
enable an unused profile or add it to the contacted registry. This runtime has
no `/memory/add`, quest-seeding worker, save-identity component, branch archive,
or pool of provider IDs.

Generic NC Resident profiles represent templates rather than unique pedestrians.
Transient sessions distinguish their entity IDs, but provider memory is attached
to the resident profile and player ID, not to each pedestrian's physical body.

## Persistence and current game context

`runtime/player-memory.json` holds the player ID, contacted profiles, reset
epochs and confirmed-action outcomes. `runtime/player-memory.json.identity`
anchors the same ID. Keep **both files** across updates and backups. They are
ignored by Git. The `.lock` file allows one writer; corrupt or disagreeing
established files stop routing instead of silently replacing the player.

Lua publishes a fresh world token after restore/detach. The bridge cancels prior
turns and transient sessions; it never changes the player ID. Reviewed current
facts and revealed journal objectives are supplied as dynamic context. They are
authoritative about the loaded game; remembered conversations can refer to an
earlier save and do not establish which quest choices happened now.

Each channel, exact group audience, world token and reset epoch has a separate
transient session. Provider LTM remains shared for the same player/character.
Session separation does not promise separate private/group provider memories.

## Forget controls

**Companion Manager → Settings → Memory** provides a searchable character picker,
**Forget selected character**, and **Forget all memories**. An inline confirmation
is required. All targets only the locally recorded contacted characters; it does
not issue deletions for the rest of the catalogue.

Before deletion, durable reset epochs invalidate old replies and local provider
sessions close. The clear names the exact player/character pair and checks an
empty provider list afterward. A timeout or inconclusive result remains failed
and blocks affected sends until a new explicit clear succeeds. Restarting the
bridge never repeats a deletion or performs automatic recovery.

Success means an empty list was observed. Convai's asynchronous extraction has
no documented flush barrier, so this does not guarantee that an earlier server
job cannot finish afterward. Natural recall and a real Forget action still need
live acceptance with this installed flow.

Forget preserves the player ID and saved local Phone Chat messages. The separate
**Disappearing messages** preference controls the phone display history.

## Implementation and checks

- `bridge/player-memory.mjs`: durable identity, conversation admission and clears.
- `bridge/player-memory-api.mjs`: verified ownership and bounded Core API calls.
- `bridge/player-knowledge.mjs`: fresh current-world and audience routing.
- `bridge/player-phone-knowledge.mjs`: immutable phone request/session ownership.
- `bridge/player-memory-control.mjs`: native MCM command/result IPC.
- `mod/init.lua`: Lua world lifecycle and bounded game knowledge collectors.

Run `npm run test:memory` for the core, provider fixtures, routing, IPC, isolated
real bridge startup and native MCM framework checks. These tests use local
fixtures and make no production provider requests. API details and limitations
are in `research/cyberpunk/PLAYER_MEMORY_API.md`; native UI behavior is described
in `docs/PLAYER_MEMORY_UI.md`.

September 30 coordinated verification: **926 tests passed, zero failed or
skipped**, including the installed MCM API framework fixture and the real bridge
startup with provider/browser/GPU side effects trapped. The realtime browser
bundle also built successfully. A separate read-only production check confirmed
Judy's exact profile ID, ownership marker and memory-settings schema; memory
remained disabled before her first actual message. These checks do not establish
rendered UI acceptance, natural recall or a real Forget result.
