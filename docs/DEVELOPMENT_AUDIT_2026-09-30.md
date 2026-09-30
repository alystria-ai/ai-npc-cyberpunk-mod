# Development audit — September 30, 2026

This document records the development methods, defects found, corrections and
remaining verification limits for the Cyberpunk Convai overhaul. It covers the
current runtime and its development tools, not just the latest visible feature.
`TODO.md` remains the requested-feature and acceptance backlog.

**Integration status:** implemented, locally committed and installed. The full
Node suite passed **1,159 / 1,159**, with zero failures or skips and the installed
MCM API included. The real production Convai transport smoke passed. Forty-two
Lua/catalogue files were installed with hash verification and rollback copies;
the hidden bridge restarted successfully. The nine native scripts are unchanged,
so the game was not restarted. **CET activation and audible/visual acceptance of
this combined update are pending the user's requested check.**

## Requirements retained during the audit

- One persistent player ID serves all saves, characters and conversation
  channels. Current-save facts are dynamic context, not proof that an old
  remembered quest outcome occurred in the newly loaded save.
- Invite immediately prepares the requested profile's memory configuration and
  identified connection. A profiled NPC cannot enter the world before both are
  ready. A raw model without an assigned conversation profile is explicitly
  model-only. Preparation must not manufacture dialogue or seed memory.
- Actual conversations build provider memory naturally. Forget is an explicit
  confirmed action for a selected character or the contacted set; it retains the
  player ID and local phone history. Provider extraction has no documented flush
  guarantee, so an empty readback is not a promise about unfinished server work.
- Keep the accepted native MCM page: default-red labels/headings on a common
  left edge, cyan option controls, a separate Memory page, and accepted Esc
  returning to gameplay. Preserve MCM's unsaved-draft guard.
- Follow-up questions default **Off**. An explicitly saved On choice survives
  updates. Only the last remaining group speaker may ask when enabled; automatic
  battle/loot comments never prolong the exchange with a question.
- A close approach by V must not order a settled companion to back away.
  Preserve peer separation, ordinary departure/following and the accepted
  movement/attention behavior.
- Preserve Convai's source speech and provider facial timing. Local OmniVoice
  phrase generation is a separate route. Production OmniVoice remains one
  resident shared FP16 PyTorch model, 32 steps by default or 16 by choice; FP8
  and TensorRT are not shipped precision settings.
- F7/F9 microphone access starts only through an explicit player action. Live
  microphone testing is user-deferred. Game testing remains manual; no input
  automation is authorized. `scripts/Test-GameInput.ps1` is user-owned and is
  excluded from this work.
- Local Git checkpoints, hidden helpers and minimal necessary reloads are the
  development workflow. Subagents inherit the current parent model/reasoning.
  The user authorized GPU use and overrode `gpu use.txt`; no new GPU benchmark
  is part of this audit.

## How the audit was performed

1. **Trace the production path.** Follow a player action through the actual Lua
   adapter, file publication, bridge admission, session/transport ownership and
   native completion. Inspect current files and installed framework contracts;
   do not use an old test fixture as the definition of intended behavior.
2. **Reproduce a specific failure.** Use the production modules with controlled
   native/provider boundaries. Examples include two native commands surviving
   refused cancellation, a phone transcript shrinking from two rows to zero
   after reload, and a recording page disappearing during party maintenance.
3. **Test time and identity boundaries.** Deliver old callbacks after reset,
   create fresh wrappers for the same native object, delay cancellation,
   interrupt file replacement, and fill connection capacity. Exercise zero-delta
   menu updates as well as normal game time.
4. **Fix the owner of the state.** Keep the exact command, request, actor,
   profile, world, connection or file transaction responsible for the work.
   Preserve accepted movement choices and raw audio rather than concealing a
   lifecycle defect with different timing or visual motion.
5. **Verify the reproducer first, then integrate.** Targeted tests must fail
   under the defective implementation and pass with the correction. Add them to
   the normal suite when they protect a production seam. Run the combined suite
   after integration; individual lane counts overlap and cannot be summed.
6. **Use live evidence only for what it establishes.** Native widget readback,
   playback cursor traces, retained audio, user observations and isolated
   provider trials are different evidence types. Source tests cannot establish
   animation quality, audible continuity or a real microphone result.
7. **Keep evidence private and bounded.** Fixtures use disposable storage and
   fake provider/native objects. The isolated direct-audio trial reused the
   existing research identity, not the player's ID. Runtime receipts, dialogue,
   keys, identities and recordings remain ignored; this document records safe
   measurements and source pointers.

## Source and ownership map

| Subsystem | Main source | State it owns |
| --- | --- | --- |
| World and action adapter | `mod/init.lua`, `bridge/world-session.mjs` | Current world lease, action admission, pending request deadline and teardown order |
| Invitation and memory preparation | `mod/invitation-readiness.lua`, `mod/manager-party.lua`, `bridge/companion-invitations.mjs` | Pending copy, preparation revision, readiness receipt and attachment |
| Player memory | `bridge/player-memory.mjs`, `player-memory-api.mjs`, `player-memory-control.mjs` | Durable one-ID registry, verified profile configuration, reset epochs and confirmed Forget outcomes |
| Knowledge routing | `bridge/player-knowledge.mjs`, `player-phone-knowledge.mjs`, `world-knowledge.mjs`, `journal-history.mjs`, `quest-context.mjs` | Current facts, audience, entity and transient conversation partition |
| Connections | `bridge/party-connections.mjs`, `realtime-host.mjs`, `transport-pool.mjs`, `realtime-client.mjs` | Protected pages, verified SDK identity, cancellation and retained sessions |
| Private/group/microphone | `mod/group-chat.lua`, `mod/microphone.lua`, `bridge/microphone-session.mjs` | Captured group, recording mode, recognized user text and ordered delivery |
| Native speech/face | `mod/speech.lua`, `mod/facial-playback.lua`, `r6/scripts/CyberpunkConvai/Speech.reds`, `Face.reds` | Exact speaker, native audio cursor, facial application and final cleanup |
| Provider source audio | `bridge/convai-data-audio.mjs`, `realtime-client.mjs`, `realtime-host.mjs` | Reliable source PCM, indexed NeuroSync data and one complete WAV; installed; live check pending |
| Local voice | `bridge/resident-voice.mjs`, `voice-selection.mjs`, `speech-stream.mjs`, `phonetic-lipsync.mjs` | One owned model worker, immutable turn quality, local phrase synthesis and analysis |
| Companion movement | `mod/companions.lua`, `companion-actuator.lua`, `companion-travel.lua`, `companion-locomotion.lua`, `companion-behavior.lua` | Exact spawned copies, physical movement command and social attention |
| Automatic reactions | `mod/battle-observer.lua`, `battle-reactions.lua`, `loot-observer.lua`, `loot-reactions.lua` | Observed events, exact-copy witnesses, cooldowns and one automatic reply lease |
| Manager and phone | `mod/mcm.lua`, `mcm-entry.lua`, `manager.lua`, `phone-chat.lua`; native `Phone*.reds` | Settings drafts, native menu ownership, contact-local transcript and composer |
| Profiles and installation | `scripts/Build-CharacterProfiles.mjs`, `Provision-Characters.mjs`, `development-files.json`, `DevelopmentFiles.psm1` | Generated API fields, safe provisioning mappings and the exact installed file set |

## Coverage matrix

| Area | Audit outcome | Verification boundary |
| --- | --- | --- |
| Invitations | Existing immediate preparation and spawn barrier retained; attachment-death reservation leak corrected | Readiness/queue fixtures; earlier Judy invitation and first-send reuse accepted |
| Memory | One-ID, ownership/readback, explicit clears and no seeding reviewed; admitted automatic dialogue now recorded for Forget accounting | Provider fixtures and local registry tests; natural recall/real Forget remain unverified |
| Private/ambient connections | Exact ambient entity route retained; active pages no longer absent from the party plan | Real route/pool modules with fake pages; no new live ambient conversation |
| Phone connection reuse | Unconditional post-reply transport discard removed | Repeated actual-host/fake-SDK turns retain page and connection; audible/chat latency still needs measurement |
| F7/F9 connection ownership | Microphone uses the same private/group conversation partition as its warm page | Full-capacity retention fixtures; no live microphone use |
| F9 coordination | Added mode-specific input, finalized transcription, one primary reply and ordered later turns | Registered Lua hotkeys and mocked SDK event contract; live microphone deferred |
| World restore/death | Teardown and stale-result guards reviewed; bounded replacement-gap reader added | Executable lifecycle fixtures; does not close the remaining native crash/obstacle scenarios |
| Movement | Exact native command retained until terminal cancellation; close-face retreat removed | Failure injection, deterministic motion and earlier close-approach user acceptance |
| Combat/loot | Battle witness admission corrected to exact actor/profile; loot provenance guards retained | Reactions/leases/provenance fixtures; earlier opening, closing, loot and holster checks accepted |
| Settings | Completed-page styling and native controller identity corrected | Installed-framework fixtures plus accepted red alignment and Esc gameplay behavior |
| Phone history | Persistent display scope restored independently of retired save identity; write/recovery defects corrected | Actual production binding and filesystem failure fixtures; reload persistence needs new live acceptance |
| Profiles/style | Response-only samples, no spoken labels and stronger opt-in follow-up instruction | All-79 Core field readback, bounded research replies and one accepted Judy F6 reply |
| Quest/world context | Unrelated/duplicate prompt context removed; JS/Lua selector parity and decoded-source hash validation corrected | 152 checks; prior decoded exports remain explicitly unbound to an original hash; 994 outcomes excluded |
| Convai audio | Recapture/file-handoff cause measured; direct data-only PCM path installed | One isolated source trial and byte-identical offline replay; no new native playback acceptance |
| Convai face | Removed RMS neutralization of valid quiet provider poses | Retained-reply reproducers and timeline/playback tests; visible quality still needs checking |
| OmniVoice lifecycle | Cancellation, worker exit and timeout recovery corrected | Fake workers plus CPU-only mocked graph tests; no new GPU render or live memory measurement |
| Installer/compiler/launcher | Shared manifest, rollback receipts, browser freshness, state-directory and binding defects corrected | Disposable project/game directories and mocked process tools; no audit deployment claim |

## Confirmed runtime defects and corrections

### Conversation, world and memory ownership

**Microphone pages were outside the retained conversation namespace.** F7/F9
created a `microphone:` partition while party/composer maintenance protected the
equivalent private or group page. A real-module fixture reproduced disposal of
the busy recording on the next maintenance pass. Input modality now remains
provenance on the request, while the conversation uses the same retained page.
Player, world, reset, character, group audience and ambient entity boundaries
remain part of ownership. The eleven-page limit and eight protected party
private pages are retained. See `bridge/microphone-retention.test.mjs`.

**Ambient conversations could be evicted by normal party maintenance.** Generic
resident routes need the addressed physical entity; the old plan could not
derive that route from a profile alone. The admitted request now supplies its
exact validated configuration as one optional target slot. Switching entities
retires the previous route, and group optional capacity yields before any of
the eight party private pages. Raw credentials and route IDs stay out of
diagnostic output.

**Phone replies disconnected a usable page after every turn.** The forced
`discard: true` flag also awaited teardown before completion. Removing it lets
the existing scoped pool/session owner decide retention. Three real-host tests
with a fake SDK verify repeated page/connection reuse and unchanged
identity/cancellation boundaries. This removes a concrete reconnect cause; it
does not by itself establish a new live latency number.

**A brief Windows heartbeat replacement gap reset all routes.** Lua's fallback
can remove the prior file just before renaming its complete successor. One
`ENOENT` or partial JSON read previously looked like a lost world. The new reader
makes at most three attempts, separated by 15 ms, only for those two transient
read failures. Explicit `ready: false`, a changed world, invalid schema,
permission failure or an expired lease is never hidden by the retry. No prior
world lease is substituted after failure. Five reader regressions and an actual
bridge-startup fixture cover this boundary.

**Pending voice replies could be cleared by focus expiry.** Focus cleanup used
to lose pending ownership before a late reply could be handled consistently.
The request now owns its 90-second deadline; expiry is checked before polling a
late result. Microphone cancellation and group retirement occur together, and a
fresh recording can start afterward. The idle-focus timeout remains separate.
Integrated tests cover initial reply, later speaker, late arrival and restart.

**F9 now has a complete source entry and ordered group route.** Recording start
freezes distinct participants and the follow-up preference. The first character
receives microphone input and its reply plays once. Later speakers receive only
the SDK's recognized user transcription and actually delivered group history;
partial transcription events and assistant text cannot masquerade as V's input.
A consolidated correction takes precedence, and text is bounded to 1,200 UTF-16
units without splitting a surrogate pair. Missing transcription cancels later
speakers instead of inventing a transcript. Wrong-mode keys, zero-delta menus,
target loss, save changes and the 30-second recording finish have adapter
coverage. The user has deferred real microphone tests; no source test overrides
that decision. See `docs/GROUP_VOICE.md`.

**Automatic dialogue and the Forget registry require the same accounting.** An
invitation can configure memory without recording contact. An automatic battle
or loot reply may later be a real provider conversation even if V never typed
to that character. The bridge audit identified that such a character could be
omitted from Forget all because only manual admission updated the local registry.
`recordAutomaticConversation` now durably records contact locally when actual
automatic dialogue is admitted. A trigger, spawn or cancelled preparation alone must not create
contact, and no `/memory/add` or extra memory-building dialogue is introduced.
The reproducer executes the real admission function: the previous branch left
the registry empty; the fix records Judy, leaves an untouched invited Panam out,
retains the ID and avoids repeated writes. These fixtures make no cloud request.
All five bridge audit corrections passed 246 checks across thirteen affected
suites, saved in source checkpoint `0e77954`. Installation and live behavior
remain separate.

### Companion commands, attachment and reactions

**A failed cancellation lost the only native command handle.** A failed state
read or refused cancellation discarded the old command and immediately issued
another; fault injection reproduced two active native commands without an
error. The actuator now keeps the exact handle, requests cancellation at most
once and waits for confirmed terminal state before replacement. Tests include
asynchronous cancellation, refusal, throws, combat release and world
abandonment. This changes command ownership, not the accepted movement policy.

**Death between attachment and ready confirmation leaked an invitation.** The
queue reproduced a retained preparation ticket across 100 flushes. It now
retires the dead attachment's ticket and reports death once, preserving other
copies and leaving corpse removal to its existing owner. These two defects
have eight new regressions in `companion-ownership.test.mjs` and
`manager-party-lifecycle.test.mjs`; their combined audit run passed 107 checks.
Source checkpoint: `b6c9c42`.

**A new copy inherited an old copy's battle witness role.** Witnessing was
keyed by profile, so dismissing a witnessing Judy and inviting a new Judy could
admit the new entity's closing comment. Admission now requires the exact entity
and profile. Published character context and speaker rotation remain
deduplicated by profile. The failing regression, surviving witnesses and copies
that really join ongoing combat are covered. Loot already uses exact-copy
witnesses and showed no additional confirmed defect in this review.

**V's close approach ordered an unwanted retreat.** At less than 0.72 m for
0.6 seconds, personal-space logic ordered a 0.5 m retreat. Peer separation now
considers overlapping companion copies; V approaching a settled face does not
generate a walking destination. The old implementation failed two reproducers;
64 focused checks passed after correction, including 0.68/0.35/0.08 m approaches
with and without selected gaze. The user subsequently confirmed no retreat.
The latest close-up report did not separately retest departure/following.

### Manager, phone and character presentation

**Settings styling ran at the wrong render boundary, then inside an unsafe
native callback.** The initial style pass saw MCM's provisional title and missed
the completed owned page. The first final-title implementation crashed after
reload. The retained dump and CET allocator source establish exhaustion of a
1 MiB scratch arena by repeated nested reflected widget work. That build was
reverted. Styling now queues work for top-level update, performs one bounded
lookup/map, and checks exact provider/title/controller ownership. User readback
accepted native red, one x=20 label edge and preserved cyan values. See
`docs/MANAGER_UI.md` for the crash evidence and revision history.

**Esc close/detach callbacks used unequal wrappers for one native controller.**
CET creates new weak-reference wrappers across callbacks. Native `CalcSeed`
identity now correlates the owned settings screen; actual detach must follow
accepted close before the normal Resume action runs. Fresh-wrapper tests
reproduced the previous miss. The user accepted Esc returning to gameplay;
the receipt records one matched close, detach and Resume with no retained
controller. The unsaved-draft modal still has fixture rather than live coverage.

**Phone display persistence still depended on removed save identity.** The
current production binding has no retired native save ID, but the transcript
store required it. The reproducer changed two rows to zero after a CET reload.
A separate persistent local display scope now retains each contact's history
and draft. In-flight replies still require the current world/generation.
Migration copies only the exact previously displayed session and preserves
original/unrelated buckets. Eight new regressions include the actual production
binding; the phone/UI audit passed 171 checks plus the separately enabled
installed-MCM integration check. The phone and F9 source checkpoint is `dfc6a77`.

**Phone publication ignored failed writes/flushes and replacement backups.**
Write and close results are now checked before replacement; failure preserves
the unsent draft and prior complete request. Missing/malformed primary history
can recover `.previous`, while malformed original data is retained for recovery.
This is verified with injected filesystem failures, not a new live interruption.

**Profile examples and permissive follow-up wording leaked into speech.**
All 618 examples across 79 profiles were regenerated as spoken responses only,
without generated character prefixes or V's prompt. Case-insensitive preflight
prevents labels returning. Existing-style-only provisioning changes the two
style fields while preserving biographies, voices, models and ID mappings, with
Core readback. The On instruction now asks for one relevant question while
prioritizing goodbyes, no-question and fixed-reply requests. Fourteen post-repair
research responses omitted prefixes; the user accepted one Judy F6 question
without a spoken name. This is sampled behavior, not a guarantee for the cast.

## Source audio and facial development

### What the retained reply established

The current Convai path sends one player text request. It does not regenerate
the reply sentence by sentence. Its browser adapter recaptures a paced remote
track and the native adapter plays separately published WAV clips. The retained
Judy reply contains seven complete files and estimated 15–32 ms native handoff
gaps. Existing Audioware events do not guarantee seamless joining of separate
clips. A quiet-boundary experiment retained PCM but merely moved those joins;
it was set aside without installation.

OmniVoice is different: it generates its own local phrases and has its own
buffer/read-ahead policy. The Convai correction must not silently reroute that
local generation or apply new processing to either voice source.

### Direct data-only plan and evidence

The replacement requests Convai's reliable data-only PCM output, collects the
complete source response and publishes **one WAV for native playback**. This
removes inter-file handoffs without a new audio plugin. It also removes browser
AudioContext/worklet recapture from the remote speech path. The SDK's connect
request currently needs a narrowly scoped adapter for these documented output
options; it validates the exact current page/lease identity and matches only
the intended connect origin/route. The host patch preserves original session,
STT, unknown configuration and headers while adding only data-only routing,
100 ms packet duration and no per-packet WAV header. It rejects the legacy
browser-chunk callback before startup rather than maintaining two active audio
owners. Six focused route checks, and 59 host/pool/party checks in total, pass;
client integration and live qualification remain separate.

An isolated SDK/LiveKit trial reused the existing research ID and did not use
the player ID, microphone hardware, GPU generation or native game playback:

| Measurement | Observed value |
| --- | --- |
| Source audio | 31 PCM16LE packets, mono, 24 kHz |
| PCM bytes / duration | 146,400 bytes / 3.05 seconds |
| First source packet after submission | 2,286.7 ms |
| Last source packet after submission | 3,348.7 ms |
| First-to-last delivery span | 1,062 ms, about 2.87× faster than playback |
| Clean terminal event after submission | 3,357.3 ms |
| Provider face data | 15 chunks, 183 ARKit-61 frames, actual 60 fps |

The 1,062 ms value is the delivery span, **not first-audio latency**. The actual
provider frame rate was 60 even though the trial requested 30; frame indices and
the returned clock are authoritative. Offline replay reconstructed a
byte-identical WAV. Receipts are in ignored
`runtime/convai-direct-audit/LiveKit/report.json` and the collector replay receipt.

`bridge/convai-data-audio.mjs` checks reliable ordered delivery, stable PCM
format, sample alignment, bounded size/duration, clean matching terminal/stats
and exact declared byte count. It concatenates source samples and adds a WAV
header; no fades, normalization, resampling or synthetic silence is planned.
Indexed facial data has its own validation/failure result so malformed face
data cannot silently distort otherwise valid speech.

The data protocol's PCM packets have no response ID. Therefore **one admitted
turn, a pinned remote participant and whole-connection retirement after
cancellation/failure are essential ownership requirements**. The isolated trial
did not initially record sender presence; a subsequent warm-connection check
verified the real remote participant. Client integration must pin that verified
participant and reject other origins. Collector unit tests alone cannot prove
that trust boundary. Do not reuse a cancelled connection and assume subsequent
ownerless PCM belongs to the next turn.

The measured response arrived faster than real time, making complete-response
playback plausible for that case. It does not guarantee all providers/replies
will finish in 3.36 seconds, and it is not an in-game latency comparison. Final
host/client integration, sender validation, native playback and audible result
are still required. See `docs/CONVAI_AUDIO_STREAMING.md` for the current contract.

### Quiet facial articulation

Per-chunk RMS gating replaced valid provider poses with neutral during quiet
sounds. The retained reply contains six isolated neutral frames; one jaw
sequence was `0.0715 → 0 → 0.0383`. Two reproducers failed before the correction.
Validated provider articulation now remains independent of audio loudness,
while existing jaw calibration, upper-lip bounds, PCM and local phonetic mapping
are preserved. Twenty-four face/timeline checks passed.

Provider neutral frames still mean rest. Missing/expired facial data,
pause/cancellation and final completion still clean up the owned face layer.
A valid held pose can remain during silence until the provider changes it or
its permitted tail expires; that tradeoff needs rendered review. The facial
segment bound remains **128**. A contemplated increase to 256 was abandoned.
Evidence: ignored `runtime/facial-receipt-audit-20260930.json`, source checkpoint
`5a81389` and `bridge/facial-timeline.test.mjs`.

## Local voice lifecycle

Three confirmed defects were corrected in `resident-voice.mjs` and
`voice-selection.mjs`:

| Before | After | Evidence |
| --- | --- | --- |
| Cancellation during warmup left the conversation waiting | Abort releases that waiter immediately while ownership of shared preparation remains explicit | Pre-fix pending-cancellation reproduction |
| Worker exit during shutdown left an unfinished render unresolved | Exit rejects/clears all unfinished render owners | Pre-fix unresolved-render reproduction |
| Hung startup/render/exit could remain unbounded | 180 s startup, 120 s render, 10 s graceful exit then 5 s exit confirmation; only the owned child may be terminated | Fake-process timeout/exit tests |

Unconfirmed worker exit blocks replacement, preventing overlapping GPU workers.
Twenty-eight focused JavaScript checks and three CPU-only mocked CUDA graph
checks passed. This is not a test of a hung CUDA driver or a new memory/latency
benchmark. Source checkpoint: `cbc8f6e`.

Healthy paths reviewed include cached reference preparation, one serialized
resident model, quality/provider frozen per reply, raw local WAV preservation,
bounded read-ahead, leased output slots and stale-result rejection. Rhubarb
analyzes a separate byte-identical copy with a bounded subprocess and envelope
fallback. Its analysis is still awaited before a local phrase publishes, so
that cost must remain visible in timing. Warming all three references at
32 steps remains intentional and was not changed without measurement.

## World knowledge and content validation

Knowledge collection and projection remain separate from long-term-memory
creation. Native facts, revealed journal entries, source evidence, current world
generation and speaker audience constrain what enters a prompt. Unresolved
conditions remain unknown; absent evidence is not a completed outcome.

The current corpus records 253 quest keys, 704 decisions and 1,160 outcomes;
172 source-verified native rules link 166 outcomes. **994 unmapped outcomes
remain excluded** from executable context. These are research coverage limits,
not defects to bypass with inferred facts. The crash-prone native save-identity
component remains retired, and its archive/seeding prototypes are historical.

Three concrete corrections were verified:

1. **Unrelated history inflated ordinary conversation context.** Greetings could
   include active or character-associated quests without any query relevance,
   and the separately captured tracked objective was repeated by older inventory
   data. Relevance filtering and tracked-quest deduplication now retain explicit
   history/completed-quest questions and fallback tracked data. Signed/unsigned
   forms of the same journal hash match. Replaying a retained capture preserved
   the same 705-character world facts and 958-character direct journal block,
   while total context fell from 8,509 to 3,771 characters (55.7%). History fell
   from 5,879 to 1,141 characters and selected historical rows from five to zero.
   This is an offline prompt-size measurement, not an API latency claim.
2. **The bridge accepted selectors that disabled Lua collection.** Invalid
   native classes, incomplete path aliases, mismatched hashes and unqualified
   retired-choice references could pass JavaScript validation but fail the
   collector's pack load. The bridge now checks the executable Lua selector
   contract. Negative tests reproduce the old mismatch; the production pack
   remains valid.
3. **Native evidence authenticated binary source but not its decoded JSON.**
   `research/cyberpunk/scripts/build_native_pack.mjs` verified raw CR2W bytes while an unbound decoded export
   could still change the interpreted evidence. Declared reference/manifest
   JSON hashes are now verified, with strict `--require-json-hashes` for newly
   qualified material and explicit legacy-unbound reporting. The prior 3,467
   references remain legacy: they have not been mass re-exported or retroactively
   authenticated. A fresh pinned re-export is required before making a stronger
   decoded-source integrity claim.

The world-knowledge audit passed 152 checks across nine world/journal/profile/
router suites, saved in `1ca6ebe`; source-hash regressions are in
`bridge/native-pack-build.test.mjs`. Its runtime pack currently contains 172 executable source-verified
rules, zero live-verified rules and 457 total entries. All 79 generated profile
fields match their rebuilt dossiers; strict unknown-zero, revealed-only,
old-world, conflict and audience cases remain covered. Prompt evidence is in
ignored `runtime/knowledge-audit-20260930.json`. This review does not promote
source-verified narrative rules to live acceptance.

## Development tools and packaging

| Confirmed issue | Correction and verification |
| --- | --- |
| Compiler staged retired `KnowledgeState.reds` while installer shipped another native set | `scripts/development-files.json` and `DevelopmentFiles.psm1` define one exact source/install set for both |
| Retired native experiment could survive an update | Closed-game installation quarantines only the explicitly named retired file; no arbitrary game files are removed |
| Updates lacked a recoverable replacement record | Prior owned files backed up, incremental receipt written, each replacement atomic and hash verified |
| Browser bundle could remain stale | `Build-VoiceClient.mjs` rebuilds the current import graph before launch; a build failure blocks startup |
| Custom state directory made Stop miss the bridge | Start/Stop share `StateDirectory` / `CYBERPUNK_CONVAI_STATE` |
| Binding helper omitted modes and overwrote custom keys | Fill only missing F4/F6–F9 actions, preserve custom bindings, check same-mod conflicts and describe J/L correctly |
| Corrupt provisioning map was treated as empty | Only a missing file defaults to `{}`; malformed/I/O failures stop before provider access and always release the lock |

Twenty-five focused tooling checks passed using disposable project/game trees,
mocked process cmdlets, a fake API and real esbuild; PowerShell syntax and
whitespace checks also passed. Source checkpoint: `9feb8dd`. Read-only installed
inventory contained the expected nine native scripts and no retired
`KnowledgeState.reds` at the time of inspection. No audit installation is
implied by that inventory.

The installer records recoverable partial progress; it is not a transaction over
the entire installation. Direct `node bridge/convai-bridge.mjs` invocation still
bypasses the launcher's browser-build preflight. Dependency packages remain
locally staged and need real startup qualification when changed. Research
Python tests are separate from `npm test` (17 passed in the audit); installed
MCM tests require the real API path. Earlier tracked Node tests and new audit
test files must remain in the package commands.

## Integration failures caught before deployment

The first combined suite ran 1,141 checks: 1,137 passed and four phone-delivery
fixtures failed. Those mocks returned `nil` from successful Lua file writes and
closes, contrary to the real file API. Production correctly rejected them after
the write-safety fix. The mocks now return the handle / `true`; all delivery
assertions remain, and the 20-case delivery suite passes.

An installed-SDK contract check caught an endpoint mismatch in the initial
connection hook. SDK 1.7.0 defaults to `https://realtime-api.convai.com/connect`;
the hook now uses that exact address, verified from the pinned installed package.
It does not redirect arbitrary requests or change provider authentication.

The first real production-path audio smoke timed out. A separate bounded
research request then exposed the precise state: final text, all 146,400 PCM
bytes and all 183 face frames were present, but the completion flag was absent.
The service sends audio/facial metadata inside `server-message` and the owned
`bot-turn-completed` lifecycle event at the top level. The initial browser
adapter listened only inside the wrapper. This is an integration defect that
pure collector and mocked-envelope checks did not establish. The first envelope correction still excluded the provider's flat terminal
because that one packet omits `label`. A narrow exception now admits owned
top-level lifecycle events with an absent label, while retaining exact remote
participant, reliable delivery and response-owner validation. Wrong explicit
labels and ownerless/PCM missing-label packets remain excluded. Both causal
regressions are covered; the corrected production path then passed.
No failed candidate was installed into the game.

A final production-host research request returned one 3.05-second mono 24 kHz
PCM16 WAV: 146,400 PCM bytes, 31 packets, 183 facial frames at 60 FPS. First audio
arrived 1.968 seconds after submission and collection completed at 3.046 seconds;
encoding took 16.4 ms. Cold connection setup was 3.909 seconds, plus browser and
page setup; total probe lifetime including cleanup was 8.648 seconds. This is
a real service/production transport check, not acoustic game acceptance or a
controlled before/after latency benchmark. Evidence remains in ignored
`runtime/convai-direct-audit/LiveKit/production-smoke-verified-report.json`.

Native cancellation was also checked against the pinned RED4ext reflection enum
and retained CET receipts. `NotExecuting` is still an owned command, not a
terminal state. Movement and equipment now cancel NotExecuting/Enqueued and
stop Executing; only Cancelled/Interrupted/Success/Failure retire ownership.
Asynchronous equipment cancellation retains its handle too. The supplemental
92-check companion run uses actual CET enum strings; checkpoint `979a0a2`.

## Verification ledger

Targeted counts describe reported runs at their source checkpoints. Many share
test files; they are **not additive** and are not a substitute for the final
combined run. The final combined and installed results follow this lane-by-lane evidence.

| Lane | Reported verification | Remaining boundary |
| --- | --- | --- |
| Companion ownership/attachment | 107 checks, eight new reproducer cases; `b6c9c42` | Actual native cancellation semantics and broad animation |
| Battle/loot/lifecycle | 116 targeted checks | New exact-copy battle case audible in game |
| Phone/UI persistence | 171 checks plus installed-MCM check | Live reload persistence and rapid draft exit edge |
| Local voice lifecycle | 28 JS + three CPU-only mocked graph checks | Real hung process/driver, audio and VRAM |
| Bridge routes/retention/memory | 246 checks across thirteen suites, including five world-reader tests and actual bridge admission/startup fixtures | Real microphone/chat routes and provider memory behavior |
| F9 adapter | 48 focused deadline/group cases; transport reports 35 mocked checks including six transcript cases | Actual microphone recognition and audible group exchange deferred |
| Direct data collector/host | 20 collector checks and byte-identical replay; six focused host-route checks in a 59-check host/pool/party run | Client sender ownership and native audible playback |
| Quiet face correction | 24 checks; `5a81389` | New rendered facial result |
| Tooling | 25 checks, PowerShell syntax and real esbuild; `9feb8dd` | Actual install/start/stop after integration |
| Settings and close approach | Earlier user acceptance plus 40 manager/exit and 64 movement checks | Draft-modal and broader motion cases |
| World knowledge | 152 checks across nine suites; retained context-size replay | Fresh hash-bound decoded exports and granular live coverage |

### Final integration record

| Gate | Result |
| --- | --- |
| Source checkpoints | `5a81389`, `b6c9c42`, `cbc8f6e`, `9feb8dd`, `dfc6a77`, `1ca6ebe`, `0e77954`, `979a0a2`, `748511f` |
| Full Node suite | **1,159 passed, 0 failed, 0 skipped**, 23.73 seconds; installed `ModConfigurationMenuAPI` explicitly configured. `runtime/full-audit-final-tests.log` |
| Python research checks | Earlier audit run: 17 passed; three CPU-only graph checks also passed. This audit changed no Python production worker code. |
| Real production provider smoke | One complete 3.05-second PCM WAV, 183 frames at actual 60 FPS, original format retained, no mic/game output/player identity. Completed successfully; details above. |
| Browser freshness | Rebuilt at launch from current imports. Bundle SHA-256 `a4be1234276f37335cb2db306dedad1b02d5111010ce5589a1076beaa5c1c24e`, 1,300,706 bytes |
| Native manifest | Nine active scripts match installed source hashes; retired `KnowledgeState.reds` absent. No native edits, compile or game restart required. Lua-only installer itself makes no native qualification claim. |
| Installation | 42 Lua/catalogue files copied and hash verified; receipt complete. Backup: `backups/development-install-20260930-151122-bf3c5bbf054741d698b0b9de0ce12ed2/manifest.json` |
| Bridge | Graceful stop/start passed; hidden replacement PID 20892 reached ready with no startup errors. Immutable player identity anchor hash unchanged. |
| Game | Existing process remained running. User asked to use CET Reload All Mods once; activation not yet confirmed. |
| Audible/visual acceptance | Pending: F6 Judy with Convai voices, continuity, mouth motion and neutral cleanup. Source-byte and transport tests do not prove this. |
| Phone persistence acceptance | Source and failure-injection checks pass; the new live reload/history case remains pending. |

## Remaining backlog and bounded uncertainties

These must not be confused with already corrected defects or silently promoted
to completion by an automated pass:

- **User-deferred:** live F7/F9 microphone testing; solo-exploration comments
  unless reliable native provenance can be established; further voice datasets,
  training and production FP8/TensorRT work.
- **Installed audio follow-up:** check audible continuity/onset and quiet
  facial articulation in the game. Sender ownership, source-byte preservation
  and the real production transport are verified. Local and mixed-provider F8 listening are separate.
- **Memory:** natural recall across later conversations/load cycles, explicit
  user-chosen Forget acceptance, the unspawned-character picker/confirmation flow
  and all-channel live routing. Never run destructive clears simply to close a
  checklist item.
- **Motion/world:** larger parties and duplicate copies through obstacles,
  disconnected/elevated floors, save/death recovery, vehicles and fast travel.
  Managed-copy acceptance does not establish safe control of quest pedestrians.
- **Phone:** disappearing messages at an actual new game process, new contacts
  unlocked during a playthrough, normal Messages restoration and controller text
  entry. Rapid typing/paste immediately followed by leaving Chat may snapshot
  before queued glyph events drain; this is a source-derived race candidate,
  not a reproduced defect. Preserve the original contact's edits if fixing it.
- **Reactions:** combined battle/loot audible behavior, Legendary exception,
  storage silence and unqualified corpse loot-all/virtual pickup paths. A freshly
  invited copy must not inherit a dismissed copy's witness eligibility.
- **Content/features:** the 994 unmapped outcomes, newly pinned decoded-source
  exports for legacy evidence, broader character/model
  compatibility, emotional expressions, adjustable eye contact, interface
  languages, multilingual voices and save-verified relationship behavior.
- **Release:** dependency compatibility, distributable packaging, real install
  qualification and explicit intended publishing account. This audit authorizes
  no push, release or human-facing external message.

## Continuing verification without repeating the old test loop

Complete source integration and build once, preserve the current settings and
identity files, then use one combined activation when possible. Confirm the
loaded code/version before asking the user to repeat a game action. For audio,
record provider first packet, collection completion, native start and playback
end separately; retain the untouched WAV and indexed face receipt. For visual
behavior, inspect the whole transition rather than a settled frame.

Use the smallest live scenario that answers a remaining question: one prepared
Judy reply for the new Convai path, one phone conversation through a normal
reload for persistence, or one actual actor-command recovery when required.
Do not repeat accepted styling, basic invitations, minimap markers or ordinary
F6/F8 turns merely because another subsystem changed. Update the exact evidence
and limits in this document and `TODO.md`, then continue to the next requested
feature or stop when the user asks.
