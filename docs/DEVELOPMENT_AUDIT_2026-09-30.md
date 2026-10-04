# Development audit — September 30, 2026

This document records the development methods, defects found, corrections and
remaining verification limits for the Cyberpunk Convai overhaul. It covers the
current runtime and its development tools, not just the latest visible feature.
The [consolidated handoff](../HANDOFF_README.md#11-remaining-work-in-practical-order-after-resumption) now holds the requested-feature and acceptance backlog; the former TODO was merged there.

**Initial audit checkpoint:** locally committed and installed; **1,159 / 1,159**
Node checks passed with installed MCM and no failures/skips. The user activated
the update and confirmed smooth Convai voice. Lip sync and onset were still
unsatisfactory. The continuous-playback follow-up below supersedes the initial
complete-WAV design; its source, installation and live evidence are recorded
separately.

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
  player ID; a confirmed clear also resets the corresponding local chat history.
  Provider extraction has no documented flush
  guarantee, so an empty readback is not a promise about unfinished server work.
- Keep the accepted native MCM page: default-red labels on a common left edge,
  white section headings with cyan rules, cyan option controls, a separate Memory page, and accepted Esc
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
  microphone testing is user-deferred. Game checks use user input or explicitly
  authorized computer control. `scripts/Test-GameInput.ps1` is user-owned and is
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
| Game | Existing process remained running. User completed the CET reload and Judy F6 check. |
| Audible/visual acceptance | User confirms smooth Convai voice. Lip sync remains unaccepted: mouth shapes look too simple or barely open. Latest receipt confirms one 7.417-second clip, 289 facial applications and neutral cleanup. |
| Phone persistence acceptance | Source and failure-injection checks pass; the new live reload/history case remains pending. |

## Continuous playback follow-up

### Evidence driving the change

The user's smooth-voice acceptance applies to a complete native WAV. Its latest
warm request received first PCM at 2.398 s, completed collection at 7.851 s and
started native playback at approximately 8.67 s. Collecting the whole file
added most of the delay after the first source audio. These are software clock
measurements from one reply, not microphone measurements or a general service
latency guarantee.

Official Convai documentation permits original audio packets and timed facial
data. Dawnwalker v0.5.6 was inspected at an exact remote commit for its live
track and queued group-playback designs. The installed Audioware API lacks an
append-PCM interface. The chosen implementation therefore feeds original
Convai packets into one continuous hidden-browser AudioWorklet and retains
native Audioware playback for Omni phrases. Source links and the complete
protocol are in [CONVAI_AUDIO_STREAMING.md](CONVAI_AUDIO_STREAMING.md).

### Implemented separation and recovery

- Remote Convai sends one turn and plays original PCM. Local Omni divides only
  its own synthesis text and generates subsequent phrases during playback.
- An explicit game admission contains request, generation, actor and UUID.
  A sequence heartbeat carries pause, native volume and spatial position. Old
  actors/turns cannot authorize new audio. No new player identity is created.
- A 400 ms startup buffer can begin before source EOF. Pause or underrun holds
  the source cursor; a device-correlated clock drives faces and subtitles.
- Exact final byte totals, clean provider completion, final text and audible
  drain are distinct gates. Only actual drain advances a group or produces a
  delivered receipt. Cancelled partial speech cannot become a complete memory
  delivery or trigger whole-file replay.
- The first F9 reply carries the recognized microphone prompt. Its quest
  context can refresh while the submitted memory receipt retains its original
  owner. Review reproduced and corrected both integration omissions before
  installation; microphone listening remains user-deferred.
- The complete-file adapter remains compatible with an older running Lua
  session until CET reload advertises the new controller. The new controller
  never creates native speech-slot files for successful remote replies.

### Facial correction and limits

The provider's indexed 61-value frames already contain richer articulation.
The native mapping suppressed much of its intermediate jaw motion. The
`arkit61-open-v3` curve increases quiet/intermediate opening without raising the
maximum or overriding full mouth closure. A retained source replay changed
median jaw weight from .0413 to .0740 and p95 from .1297 to .1916. Actual cadence
up to 60 Hz retains peaks previously lost at 30 Hz. Upper-lip/corner mappings
are unchanged by this adjustment, preserving the earlier distortion controls.
Growing timelines have one owned native feature and use the heard source
clock. These numerical results cannot establish natural-looking lips in-game.

### Verification method

Independent agents owned the PCM renderer, SDK transport, game adapter, face
mapping, delivery receipts and packaging inventory. Root integrated their
contracts and reviewed lifecycle boundaries. Tests run real production
functions or Lua modules with controlled ownership/timing, and an explicitly
muted headless Edge test exercises the actual AudioWorklet. A first full run
passed 1,250 of 1,252 checks and exposed a browser clock fault under load plus a
host test integration mismatch; those failures were retained for diagnosis,
not counted as acceptance. The host fixture was corrected; at that checkpoint
the real clock fault remained unreproduced, with no claimed fix. Strict continuity checks
and bounded numeric diagnostics remain armed. Three isolated lifecycle reruns,
one diagnostic full run, the retained-packet replay, and eight further muted
browser checks did not reproduce it. The last eight ran concurrently with one
full suite; that exceeded the intended test concurrency and will not be the
routine test method. No game or bridge process was stopped by those tests.

The final combined source run passed **1,266 / 1,266**, no failures/skips,
including installed MCM and the real muted browser test, in 23.90 seconds:
`runtime/continuous-final-tests.log`. A source-executed receipt race regression
confirms already-heard group speech is recorded before cancellation retires the
old request, with exact ownership, completion and concurrent-poll guards.

`runtime/continuous-pcm-replay.json` replays 31 retained provider packets with
their original timing. The browser first rendered at 537 ms and its heard clock
advanced at 573 ms, before the final packet at 1,197 ms. It drained 73,200 frames
(3.05 seconds) with zero underruns; the pure core restored every PCM byte.
Those times begin at the offline replay, not at a new player request. Output was
explicitly muted and no provider/microphone/game action occurred. This is queue
evidence, not an audible game acceptance or a new API latency benchmark.

The final diagnostic-only client follow-up passed **55 targeted checks**. It
preserves only eight finite numeric clock fields through append/collection
failure and page disposal; unknown keys, strings, Infinity and oversized values
are excluded. This adds one test after the 1,266-check combined run; it does not
claim a second full run or a resolved cause for the rare clock discontinuity.

### Installed continuous-playback checkpoint

| Gate | Result |
| --- | --- |
| Local commits | `a55c178` continuous speech/face/receipts; `dafe04d` package proposal |
| Lua/catalogue install | **43 files hash verified**, receipt complete; `backups/development-install-20260930-155654-25e364c0a22f4b1789e30239dd7d2416/manifest.json` |
| Native components | Nine source/installed redscript hashes match; no native change or game restart |
| Browser build | 1,323,992 bytes; SHA-256 `831edead8961e07ba4595a45926ca565f874f7ad2e424795247a28213ce0e455` |
| Bridge restart | Graceful release, fresh hidden PID 33996, zero startup stderr; waiting for requests |
| Identity | Persistent player identity anchor hash unchanged across restart |
| Game | Existing PID 28320 remained running |
| Activation and live quality | CET activation confirmed. First live F6 check failed: the user saw text but heard no voice and saw no lip sync. See the diagnosed causes below. |

### First live failure and corrections

The first continuous reply advanced its software cursor to 6.626 seconds of a
6.783-second source with zero buffer underruns, then stopped. This was **not**
evidence of audible delivery. Three independent issues were identified:

1. **Muted output:** saved native Master Volume was 100 and Dialogue Volume 0.
   The new renderer followed those settings and was silent. The user chose to
   correct the game setting; no companion volume slider or automatic change to
   their native settings was made.
2. **Facial ownership mismatch:** `buildProviderFacialTimeline` omitted
   `generation`, while the Lua adapter required it. Standalone fixtures had
   supplied the missing field and concealed the boundary defect. The producer
   now emits a validated generation. An actual publisher → JavaScript builder
   → Lua playback test reproduced `Facial timeline belongs to another reply`
   before the correction and applies the pose afterward. Seventy focused checks
   passed; Lua's ownership checks were not loosened.
3. **Repeated browser render timestamp:** the live numeric diagnostic showed
   two successive quanta at `6.810666666666667..6.816000000000001`, while source
   frames remained contiguous (`161280..161408`, then `161408..161536`). This
   identifies duplicated context timing rather than dropped or repeated PCM.
   The correction gives every callback a distinct mapped quantum using integer
   `currentFrame`, bounded below by the previous mapped quantum's end. A later
   browser catch-up removes the temporary lead. PCM remains untouched; source
   discontinuity and backwards raw clocks still fail. An exact numerical
   regression preserves all samples across the observed duplicate.

The software onset estimate was about 3.06 seconds after request admission in
this silent trial, versus 8.67 seconds for the earlier complete-file request.
The prompts and generated responses differ, and output was muted, so this is
not an audible A/B result or a latency promise.

After correcting Dialogue Volume, the user reported **latency is good now**,
while lip sync remained absent on the still-running old builder. That reply
drained all 3.4 seconds with zero underruns and a `continuous-playback` receipt.
Its software onset estimate was 3.291 seconds after admission; first provider
PCM was 2.199 seconds after submission, with a reused connection. The exact
facial rejection above remained visible, with zero native face applications.

**Corrective checkpoint `7baf303`:** ninety focused renderer/facial/publisher/Lua
checks passed, including the actual muted browser and production-to-Lua facial
contract. Only the bridge was restarted; CET and the game remained running.
Fresh bundle: 1,324,103 bytes, SHA-256
`a0ceb191d4251ffa3efbcfa9df4f65f1fc60ac4ee6ddfb4aef4e35a9abd52d33`.
Hidden bridge PID 25820 started with no stderr, and Judy's connection reached
ready before the next requested F6 check. Corrected rendered movement remains
pending that check; the full 1,266 run predates these targeted corrections.

Packaging is documented in [PACKAGING.md](PACKAGING.md) and a checked
machine-readable proposal: 39 Lua files in Scripts; catalogs, native components
and portable voice runtime in Runtime. No ZIP or release is claimed complete.
Relocatable Python/browser startup, reference preparation, dependency/license
inventory, compressed size and GitHub asset limits remain concrete release work.

## Remaining backlog and bounded uncertainties

These must not be confused with already corrected defects or silently promoted
to completion by an automated pass:

- **User-deferred:** live F7/F9 microphone testing; solo-exploration comments
  unless reliable native provenance can be established; further voice datasets,
  training and production FP8/TensorRT work.
- **Installed audio follow-up:** the earlier single-WAV Convai playback is audibly accepted.
  Onset and facial articulation remain open: the user reports excessive delay
  and simple/small mouth shapes. The latest warm request had first PCM at
  2.398 s, collection complete at 7.851 s and estimated native onset at 8.67 s.
  Waiting for the whole clip is the main delay after first audio. These are
  one installed request's timestamps, not an acoustic benchmark. Local and
  mixed-provider F8 listening are separate.
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
and limits in this document and the current handoff, then continue to the next requested
feature or stop when the user asks.

## Later September 30: native lip-sync deep dive

The user accepts the corrected continuous voice latency but rejects the mouth as
wooden and barely moving. This became a native retarget/calibration investigation,
documented in [LIPSYNC_DEEP_DIVE_2026-09-30.md](LIPSYNC_DEEP_DIVE_2026-09-30.md).

The method separates provider facial generation, target mapping, heard-clock
sampling and native bone deformation. Research checked current Convai profiles
and mapping guidance, Cyberpunk/JALI publications, maintained WolvenKit native
solver code, Rhubarb and optional neural alternatives. Another GPU model is not
the first correction: it would feed the same native renderer and add resource
and distribution costs.

The real Lua controller/speech/face replay reproduced a cadence bottleneck:
40 ms file polling reset its remainder and suppressed pose sampling on all
other game frames. At 60 FPS it applied only 40 poses in two seconds. Preserving
the remainder and sampling a bounded confirmed-past cursor raises this to 115
applications, with ordinary past lag about 37 ms and no sample ahead of known
heard audio. A float tolerance fixes roundoff at 1/60 second; continuous timeline
republication no longer bypasses the 60 Hz limit. Pauses, stalls, actor loss,
unload, final drain and native Omni phrase behavior retain focused tests.

Actual Judy rig/facialsetup resources were separately extracted into ignored
runtime files and evaluated on CPU with the reconstructed native solver.
That analysis distinguishes real corner stretch from the weaker inner-lip
stretch shape, and identifies a suitable native lower-roll pose. The controlled
`arkit61-native-v4` change splits the existing stretch budget between those
targets and preserves a small source-driven lower roll. It keeps jaw/aperture
limits and zeroed individual upper raisers for this comparison. No PCM samples,
source timestamps, provider arrays, gaze or movement were altered.

Native idle-pose influence and jaw/lip closure combinations remain calibration
questions. Rig reference weights and successful feature calls do not establish
the animated baseline or visible quality. Focused source checks, installation
and live acceptance are recorded in the deep dive; the visual item stays open
in the current handoff until the user accepts the actual speaking face.

## October 1: rendered facial calibration and development method

The user clarified that jaw opening is sufficient. A passive game trace then
isolated slow browser snapshot serialization rather than source-frame scarcity.
The exact same nested data takes 315 ms median through the old browser transfer
and 13 ms as one bounded JSON string. Actual game observation after activation
improves to 160 native poses during four seconds of speech; the user accepts
the smoothness but still finds the articulation too dominated by the jaw.

For the next comparison, capture Cyberpunk's verified HWND directly with Windows
Graphics Capture. The desktop capture tool returned primary-display pixels for
this second-monitor window, so those images were not treated as game evidence.
The helper captures only the game surface, sends no input, retains original
timestamped PNGs, and stops after a bounded reply/probe. Inspection crops do not
replace those originals. See `docs/GAME_WINDOW_CAPTURE.md`.

Calibrate fixed-jaw native shapes before changing production transfer curves.
High-LOD captures resolve distinct round/wide lip poses, gentle upper lift, and
clean contact at a separately calibrated 0.85 together weight. Replay original
provider frames and combined/asymmetric cases on both Judy and Johnny before
installation; use exact native controls, not an assumed generic morph range.
V6 is user-reported better, not fully accepted. V7 adds contact/upper lift with
78 focused checks and bounded geometry. Its captured reply shows visible lip
contact and final reset; the user says "not bad, keep improving," so overall
naturalness remains open.

Checkpoint `a4e04c6` preserves this candidate. Its Lua adapter is selectively
backed up, copied and hash checked, then activated through `speech-install` while
speech is idle. The bridge restarts hidden to load the host mapping. The game
stays running, the persistent identity compares unchanged, and unrelated gaze
modules stay at the currently accepted live version. No provider test dialogue
or new player identity is created by this installation.

The next bounded v8 comparison restores source upper-lip roll. Ninety-seven
facial/replay checks pass. A short frozen native WAV/provider-timeline pair
replays both v7/v8 through the real game adapter while the bridge is stopped;
335/337 native applications and both final resets are observed. The visual
change is restrained, with no obvious distortion in the retained view. Overall
naturalness remains open; neither CPU geometry nor sparse window frames prove
all-character quality. The bridge is restored on v8 afterward, and no capture
worker remains running. The new replay module is registered in both development
and proposed release manifests, excluding its private fixtures and recordings.

Further hierarchy-based inspection identified native lower_raise controls as
actual downward/backward lower-lip motion, despite their names. V9 maps each
provider LowerDown signal independently and reduces duplicate aperture motion.
V10 removes the jaw's MouthClose multiplier after a native 0.14–0.40 jaw/0.85
contact sweep visibly seals and resets. Thus lip contact can retain its native
jaw-dependent correctives. Both same-audio voiced comparisons complete with
normal resets; the source/audio path and accepted jaw ceiling remain unchanged.
The 100-check focused set passes, and the normal bridge is restored on v10.

The screenshot helper now supports a bounded exact face-region crop and fixed
sampling buckets. Observed capture rises from roughly 6.5 FPS to 24–28 FPS in the
latest comparisons, with retained original timestamps. PNG context is saved
before readiness, avoiding a first-frame encoding delay. No synthetic frames,
player input or desktop fallback are used. Broad naturalness, expression blend
and other characters' actual rendering remain open; numeric and sampled visual
evidence are not blanket acceptance of every face.

## October 1: Omni parity after Convai acceptance

The user accepted Convai v10, then explicitly requested the corresponding Omni
fixes. `coarticulated-v5` changes the phonetic table/trajectory only: pressed lip
contact over an open jaw, contextual short bilabials, stronger mouth corners,
budgeted upper/lower lift, correct F/V lower-lip direction and adequate L opening.
X/rest and the existing quiet-cue, timing, original-audio and ownership behavior
remain. The accepted Convai comparison is exactly unchanged across 446 frames.

117 focused checks pass, including the actual phonetic builder-to-native Lua
path and local stream/delivery behavior. CPU review covers both native rigs;
the real Judy pose sweep and paired saved OmniVoice 32 replay complete with
normal resets. Native slot 7 is restored and the normal bridge runs the new
mapping. No new voice inference, memory request, game restart or CET reload was
needed. Dark capture detail limits an exact F/V tooth-contact/tongue judgment;
the port does not imply full-cast visual acceptance or neural facial precision.

## October 1: independent interface languages

Added Auto/manual selection for ten interface languages. The locale core reads
only Cyberpunk's on-screen language from top-level update, including zero-delta
menu frames. Cached exact-source lookups and named tokens keep native hooks
small and preserve typed content, names, IDs, dialogue, voices and memory.
Atomic settings persistence precedes selection; MCM refresh waits for drafts.
Phone/world composers change only their owned presentation and keep input text.

Review found a shared-HUD boundary issue: a provider error ending with an invite
queue suffix could look like authored phone feedback. Translation now requires
the actual native `ConvaiPhoneQueue` call scope and releases that scope even on
exceptions. Known model-browser errors, unnamed models, memory selection and
no-target feedback were also covered with explicit source keys/templates.

The nine Lua dictionaries cover the 383-key developer catalog. The full suite
passed 1,407 checks, and the final focused language/manager/phone/lifecycle set
passed 97. Both manifests explicitly include all runtime dictionaries in the
Scripts package. Source tests do not qualify native fonts or layout: live glyph
checks remain. Framework-owned controls retain their framework/game language.
See `docs/INTERFACE_LANGUAGES.md` for scope, methods and verification limits.

The first actual manual-language check exposed a native-font gap: Japanese
lost glyphs and Chinese text was blank under the English game. Changing 91
owned inkTextWidget descendants to the installed Japanese family restored the
labels. Native script aliases and redscript signatures were insufficient API
proof: CET's resource wrapper converts directly through `ResRef.ToString`,
while `ResourceAsyncRef.GetPath(script_ref<...>)` rejects that wrapper.

The resulting font layer snapshots original path/style/lock/hash as plain Lua
values, selects verified built-in fonts and restores through ink's setter. Its
MCM coordinator queues ownership events and paints only from top-level update;
shared descriptions restore on foreign hover, the translated sidebar stays
owned, selector autonyms render before Apply, and late labels/large-page cleanup
are bounded. Codeware inputs pair visible/hidden measurement fonts only while
fresh; used inputs defer until recreation to preserve glyph-cache/caret state.
The production update passed 1,432 checks and all ten Settings languages were
visually inspected in-game. A phone-specific follow-up found the popup at
controller 132, outside the original 128-controller scan, plus private widget
references unavailable through CET. The bounded scan and inspected subtree
fallbacks now cover it. An unresolved notification child path may return the
root canvas rather than nil; validate type before calling text methods.
Thirty-five focused follow-up checks cover these observed failures.

The user confirmed Japanese phone typing/caret behavior; the unsent draft
survived returning to Auto. The temporary test modal, draft and installed
diagnostic hook were cleaned up. The user asked to end additional UI polishing
and preserve native blinking. Accepted eyes/lip sync/UI are no longer calibration
tasks; broader device/controller qualification stays a release concern.

## October 2: conversation actions, native values and overhead captions

Three installed failures exposed boundaries that integer-only fixtures and
source signatures did not qualify:

- Convai's legacy driving proposal omitted its optional target. A request-bound
  nonce is now part of the advertised action name; only the current exact name
  or the base action with its exact target can authorize the frozen native
  offer. The provider, participant, reliability, expiry and one-use checks stay
  in place. Live counters confirmed actual targetless delivery and publication.
- CET's own JSON round trip changed all three native waypoint coordinates.
  Native capture now freezes the bounded wire representation before sending
  it. Exact receipt equality remains, and the fleet rechecks fresh native
  actor/car/seat/route state. Fractional-coordinate regressions accompany the
  read-only installed round-trip receipt.
- A selected route's native road endpoint changed by hundreds of metres when
  V boarded, while its Quest mappin identity stayed the same. The route lease
  must distinguish selected destination identity from the engine's computed
  road endpoint. Manual pins keep their original marker location; Quest
  objectives may move. Departure and arrival still require actual native
  execution evidence.

The first overhead-stability patch reused one caption, avoided duration-only
recreation, and concealed the exact root before delayed cleanup. Its initial
visibility guard introduced a live regression: a dynamic `CName.new` widget
name had equal native hashes but no interned text. `NameToString` returned an
empty string, so text-based ownership failed and the caption stayed hidden.
The installed active preview proved native equality while the text comparison
failed. Native CName equality and a bounded frame-driven reveal are the
appropriate correction; namespace text must not be assumed to be interned.

Development method: trace each transfer boundary using enumerated counters and
matching booleans, then make one bounded native/read-only experiment. Keep
credentials, player/provider/session IDs and conversation text out of diagnostic
output. Separate parser acceptance, file publication, native queue admission,
mount animation completion, AutoDrive enablement, and visible/audible output.
Inspect lifetime ownership in the installed version before changing it; chatter
duration is not a plain-text expiry timer in the inspected 2.31 script route.

Local commits and hash-verified install receipts retain rollback points.
Combine Lua changes for CET reloads and reserve game restarts for native startup
code. A compiled or green source test is never the installed motion/visibility
acceptance gate. These new driving and caption checks remain open until the
running game confirms them; see the detailed chauffeur/subtitle documents and
ignored local TODO for the current evidence.

## October 2: shared CPU voice adaptation and runtime paths

The Pocket TTS research follows teacher adaptation and depth distillation using
pinned upstream source and separately staged private audio/model inputs. Source
attribution, waveform integrity, scene separation and original-reference fences
precede training. Model helpers operate independently of the game and reply bridge.

Review identified three accumulation defects before the long run: latent
calibration updated per microbatch, the precision probe could skip JVP, and
per-utterance loss means differed from the official pooled frame denominators.
The corrected runner freezes released calibration, forces both probe branches
with RNG restoration, and uses global flow/EOS denominators. Actual two-process
CPU tests cover unequal-length batches; an isolated two-T4 run then exercises
real FP32/FP16 gradients, optimizer updates, checkpoint selection and export.
Preserve the distinction between numerical checks and audible improvement.

Model selection uses fixed development data and EMA weights. Test scenes do not
choose checkpoints. Sessions preserve optimizer/scaler/RNG state and stop before
their time and disk limits; mixed precision can fall back to FP32. These are
execution controls for an experiment, not a production Pocket provider.

The release inventory now explicitly includes the bridge's required quest
catalog and partitions approved dependency Lua into Scripts. Runtime boundaries
accept absolute Python/browser executable and prebuilt-client asset paths while
retaining hidden child ownership, loopback Host checks and the existing asset
allowlist. Relocation hooks have focused source/loopback coverage. A portable
Python bundle, player reference extraction and release bootstrap remain pending.

The resumed Johnny driving test exposed a targeting omission before departure:
a ready managed Johnny stood 1.31 metres away, visibly in front of V, while the
native NPC target-parts query returned an empty array. His native Head transform
was available; raw MountingInfo had a defined zero parent and empty seat. Live
raycasts to torso and head returned Boolean no-hit for all six scenery/vehicle
groups. The target selector now includes verified owned on-foot copies omitted
by the native query, retains torso and close-face Head aim, and checks visibility
through the shared query budget. Ordinary native and same-car seated selection
retain their existing behavior. Source regressions and native input measurements
precede activation. The resumed live test accepted private chat, driver-seat
boarding, and actual vehicle movement with the managed Johnny copy.

## October 2: Johnny's seated hologram material

The driver became blue and speckled when V looked toward him. A bounded
read-only camera/state trace showed that the managed copy's phantom component
remained disabled and its appearance remained `silverhand_default`. The ambient
car scene was inactive; both the canonical Johnny reference and the scene's
typed `a_thepassenger_Johnny` reference resolved to no actor. The earlier
ambient-passenger overlap is a separate problem.

The live phantom component explicitly maps `silverhand_default` to
`silverhand_riot__not_blendable`. Applying that mapping to the exact owned copy
removed the hologram speckling in same-view game-window captures. The user also
confirmed that looking away and back no longer turns him into a hologram.
Disabling the controller alone had left the blendable materials active.

Spawn preparation now reads the attached template's mapping, disables its
phantom controllers, and queues the matching solid appearance once. It leaves
unmapped and already solid outfits alone; conflicting mappings fail before any
appearance mutation. Shared records and original story actors are not targets.
The 29 focused behavior/record checks cover this contract. The current copy has
rendered before/after evidence; a fresh spawn after the combined Lua reload is
the remaining activation check.

Method: distinguish entity ownership, controller enablement, current appearance,
and rendered materials rather than treating all four as one visibility flag.
Use one reversible native change on the measured copy, inspect the actual game
window, and keep the correction at spawn preparation rather than enforcing an
appearance every frame. Temporary state readers are bounded and restored after
the investigation.

The separate ambient-car overlap has a generated native candidate. The reviewed
2.31 `thepassenger.questphase` starts its Active scene after V mounts a nonstolen
car without requiring the driver seat, while the scene's exit condition treats
V becoming a passenger as an exit. The candidate appends the explicit player
Driver condition to that existing Active eligibility AND. It does not write
quest facts, assign story tags to copies, cancel existing scenes, or modify the
DelamainTaxi branch.

The builder rejects a changed installed source fingerprint, round-trips through
the pinned native serializer, compares the entire graph after normalizing
handle numbers, and verifies that the archive decodes to exactly the one edited
resource. Eleven structural tests and fourteen packaging/development-tool
checks pass. Optional staging copies only the verified generated archive into
the project's development inputs; installation remains behind the existing
game-closed native installer. A fresh vehicle entry after the combined restart
is still required to validate the native eligibility behavior.

## October 2: native chauffeur command and retained stop ownership

The bounded native trial moved the borrowed car 175.654 m in 30 seconds. Its
copied command initially exposed the unassigned ID `4294967295`; only the
post-submission ID can authorize later updates or retirement. Live reflection
resolved `AIDriveToPointAutonomousUpdate`, which differs from the source alias.
The trial retired its exact command and applied brakes at the deadline; the
resulting native Failure was intentional cancellation, not a failed route.

Production now submits that NPC driving command instead of enabling AutoDrive.
The initial conversation offer remains immutable, while later map changes
advance the current trip's destination revision. Handleless destination updates
require a freshly matched command ID, vehicle and actual driver/passenger seats.
Arrival needs native Success plus a stopped car near the current destination.

Independent review caught two cleanup defects before installation. A terminal
command must retain its fixed-car stop obligation while V is a passenger, and
a false/throwing cancellation call must permit bounded exact-ID retries.
Separate intent, submission acknowledgment and terminal state now preserve
both conditions. Reload receipts retire the car command independently of the
driver's mount command and never reconstruct a trip or destination.

The final combined source gate passed 277 checks with one optional installed
subtitle-source check skipped. The facial native source separately compiled
successfully and its staged source hash matches. New regression cases include
map changes at completion, missing passengers, refused cancellation, coasting,
foreign control and retained-driver reload cleanup. Full production driving,
retargeting, arrival and the repaired seated face remain the combined live gate.

## October 3: accepted exit handoff and subtitle continuity

The complete chauffeur-trip check now has user acceptance for walking after exit:
V left normally, walked away and glanced back; Johnny approached and settled.
The matched bounded movement trace records the catch-up and final standing gap.
That evidence closes the reproduced post-exit defect. Ordinary following remains
the accepted baseline; the newly reported door-approach pause is investigated
through the chauffeur's actual mount and native move state.

The user also reported an overhead driving reply replaying in the cinematic HUD
on boarding. Source inspection located the unconditional same-page `showPage()`
at the renderer transition; the existing regression incorrectly expected it.
The correction retains a Unicode read frontier and the playback/read cursor.
Unread continuation owns the utterance even while its widget is retired, so group
turns and automatic comments wait for completion. New replies reset that frontier.
The 113 focused source checks pass with one optional installed-source skip;
live boarding presentation still needs the user's check.

Method: reproduce the reported transition, distinguish widget visibility from
utterance ownership, add regressions that fail on the measured cause, and review
the callers that use that ownership. Record installed hashes and an explicit
live result separately from fixture passes. Packaging is paused until Pocket TTS
integration; teacher/student experiments preserve the accepted fallback exports.

## October 3: Pocket producer/consumer qualification

The approved small Pocket student replaced the local Omni provider. Native CPU
worker checks verified streaming, reference reuse, cancellation and shutdown.
The combined muted Edge/Rhubarb check verified one acknowledged sample clock
and facial prefixes. Independent review then caught an obsolete invitation
provider allowlist and an upstream-error decoder lifetime; both gained causal
producer-to-consumer regressions before installation.

The first game reply exposed a further consumer mismatch: audio played, but the
continuous Lua facial updater accepted only the Convai source. Actual Pocket
FacialStream JSON now passes through the Lua updater in the regression, including
envelope-to-phonetic upgrade and final reset. A late renderer control also raced
natural drain; the fake seam and real browser reproduced that exact failure.
The corrections are installed in 6863401; visual game acceptance remains pending.

Method: qualify the actual boundary on both sides. A working generator, muted
browser clock and face-data producer do not establish the game's consumer
admission or rendered mouth movement. Keep source, installed and observed
results separate; preserve defaults and exact actor/request ownership while
correcting the reproduced incompatibility.

## October 3: four voice options and production inference parity

The global selector now exposes Pocket TTS (default), OmniVoice 16, OmniVoice 32
and Convai. Pocket and Omni have separate configuration/reference registries and
one local worker runs at a time. Omni quality changes reuse its model/cache.
Draft warm-up keeps the committed route until Apply and waits for an owned reply
and confirmed worker retirement before replacing the backend.

Independent lifecycle review reproduced two remaining defects: an unavailable
Omni draft retired valid Pocket and caused a resolved-promise readiness loop;
a failed/closing Omni worker retained stale speaker readiness. Both gained
actual-class regressions and were corrected before activation. A stable unloaded
startup now rejects instead of spinning. The combined source gate passed 161
checks; the UI/preview gates cover selection, migration and arrow direction.
These checks overlap and are not summed into a new all-mod test count.

The inference audit checked the actual approved EMA1500 student, all four export
assets, tokenizer/calibration and pinned source. It found no hidden precision
reduction or wrong-character cache alias. Earlier listening WAVs use the training
generator, whereas production uses the public streaming API with its own
reference preparation, text grouping and EOS defaults. Ten new recordings for
Johnny, Judy, Panam, Jackie and Evelyn now use the exact production Windows
worker, CPU FP32, two threads and unchanged generation settings. Original float
PCM, WAV containers, offsets and file hashes were verified.

First playable source PCM at Node was 189.8–300.3 ms; the first 400 ms prefix
arrived in 375.1–532.3 ms. Startup was separately 18.71 seconds. These observations
include native worker/IPC costs with the game running and exclude Convai,
browser/game dispatch and audible device onset. They do not establish complete
conversation latency or voice likeness for every character. The portable
listening table is in the voice-cloning handoff's FINDINGS.md.

Method: compare exact model/reference/code identities, then exercise the real
public producer contract. Keep research-generator samples accurately labeled,
separate process-cold startup from warm first PCM, and preserve the original
audio rather than normalizing or processing comparison clips.

## October 3: Pocket-specific facial timing

Whole-WAV Omni timing assumptions did not transfer to Pocket's short continuous
PCM packets. The previous stream independently normalized every 80 ms packet:
the same quiet passage produced jaw 0.3455 instead of whole-WAV 0.1038. Continuous
audio-clock RMS bins and prefix-based calibration now match 0.1038 exactly,
including irregular and short final packets. The original renderer PCM is
unchanged.

A second defect marked the entire stream phonetic after any analysis finished,
even when its covered speech had already played. The stream now records covered
intervals at the actual audible cursor, discards fully late analysis and bounds
work to one job with acoustic context. Four causal regressions failed before the
patch; 71 focused checks passed. Natural drain, cancellation, owner/clock and
neutral-reset behavior remain covered.

Actual replay of the ten production-timed recordings exposed the remaining
recognizer limit: batch Rhubarb supplied varied controls at only 0–21.3 percent
of sampled audible speech positions. A persistent allphone decoder prototype
using the same acoustic assets improved timely control availability and is being
qualified separately. Timely controls are not proof of natural animation or
accurate phonemes; native visual acceptance remains a distinct check. See
POCKET_STREAM_LIPSYNC.md for the installed correction and its residual limits.

Method: measure analysis completion against what the player is hearing, inspect
non-jaw controls at that time, and test packet boundaries with identical audio.
A completed final timeline or green envelope test cannot close lip quality.

## October 3: source expansion and data admission

The expanded source plan covers 93 identities in 23 lanes, with 24 Tier 1,
37 Tier 2 and 32 Tier 3 voices. It keeps a broad authentic raw archive and controls
speaker exposure in the later curated mixture. Indexed lines, native joins,
decoded recordings, independent wording, word/cut alignment and actual latent
cache qualification are separate stages. A raw transcriptAgreement flag means
native-caption equality; it is not caption-free recognition evidence.

Collectors preserve exact scene/actor/acquisition/voice/localization/gender/WEM
joins and actual archive winners. Transformed Alex, Blackwall Songbird and
unrelated Kurt/Stephen voices were quarantined. Main and alternate voice banks,
missing embedded localization and scoped generic aliases receive explicit
source review instead of silent rejection or broad identity exceptions.

Scene/WEM/PCM/caption connected components fence current references and protected
evaluation before train selection. New conditioning-reference proposals carry a
separate later-train exclusion overlay; frozen inputs and old evidence remain
unchanged. Native serializers and decoders share two slots, with short source
turns followed by actual PCM collection to prevent starvation. ASR never silently
rewrites native captions, and supplied-text alignment cannot substitute for an
independent wording check. New teacher/student jobs require qualified data and
full source/configuration identities before launch.
