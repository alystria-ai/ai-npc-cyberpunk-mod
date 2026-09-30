# Deep quest and character knowledge work

User request: research the supplied transcript and quest sites and other sources,
build individual biographies/speaking styles/original sample dialogue, granular
quest/decision mappings from game variables, dynamic context and per-user durable
memory. Include scripts and a dedicated research folder. No shortcut or blanket
claims of full coverage.

## Current player-memory policy

The user's latest decision is **one persistent player ID for every character and
save**, natural memory from actual conversations, and deliberate Forget controls.
The current bridge has no ledger/archive or native save-identity dependency.
See `../../docs/PLAYER_MEMORY.md` and `PLAYER_MEMORY_API.md` for the current flow.

- [x] Implement durable single-ID storage, exact current-world/audience routing,
  conversation-only activation and confirmed character/all clears in source.
- [x] Implement native MCM memory picker and inline Confirm/Cancel with exact
  command/result ownership. Installed-framework tests passed; rendered acceptance
  remains separate.
- [x] Observe a real `OnGameRestored` callback with zero fact writes, and verify
  real Lua lifecycle cancellation/token rotation through executable tests.
- [x] Finish coordinated verification: 926 tests passed with zero failures or
  skips, including the real Lua lifecycle and installed MCM framework. Rebuild
  the browser bundle and confirm Judy's live profile schema read-only.
- [x] Install and hash-verify the Lua/catalogue update, start the bridge with a
  matching single-ID anchor and ready Memory status, and launch Cyberpunk.
- [ ] Qualify actual conversations, memory recall and deliberate clears. Keep
  the same ID across all those actions.

## Research and earlier implementation evidence

- [x] Audit the initial implementation: revealed tracked journal per turn, no
  explicit end-user identity, and character-only phone sessions. See
  `MEMORY_API_AUDIT.md`; this describes the starting state.
- [x] Establish shared authoring and native-evidence contracts in `FORMAT.md`
  and `RUNTIME_CONTRACT.md`.
- [x] Provide bounded, repeatable public collection and native resource
  extraction with provenance, blocked-source reporting and ignored raw caches.
  This does not claim an exhaustive copy of every website or game scene.
- [x] Author and cross-reference all 79 character dossiers and related quest
  branches. Current generated corpus: 253 distinct quest keys, 704 decisions,
  1,160 outcomes, with zero schema/reference errors or warnings.
- [x] Complete independent static review of all 79 profiles and 618 original
  examples across `PROFILE_CROSS_REVIEW.md` and `CITY_PROFILE_PEER_REVIEW.md`.
  All 16 reported findings are resolved, including separate fields, audience
  boundaries, historical models and exact example speaker attribution.
- [x] Compile and source-verify the current native pack: 172 enabled rules,
  166 distinct linked outcomes, 271 cited artifacts and 3,467 checked pointers.
  This is source qualification, not live acceptance of all rules.
- [ ] Extend exact native mapping for the 994 explicitly unmapped outcomes.
  Keep those outcomes excluded until their meaning, positive condition,
  audience and provenance are established; never fill gaps from a fact name.
- [x] Implement bounded resolution and context ownership. The earlier ledger and
  explicit memory transport are historical prototypes, outside production routing.
- [x] Qualify explicit Convai memory ownership on one disposable profile with
  two registered users: independent add/list/get, cross-user denial, empty
  cleanup lists and verified character deletion. See `MEMORY_QUALIFICATION.md`.
- Native save identity is superseded. The class that caused startup failure
  stays quarantined; no native or fact-based identity is installed by this update.
- [x] Run the read-only facts probe: 43 reads returned zero, current world scope
  was accepted and the restore observer registered. This does not prove callback
  delivery, an unused fact namespace, persistence or a restored identity.
- Provider-ID pools, anonymous/manual REST archives and quest-memory seeding
  are superseded. Preserve their qualification receipts as historical evidence;
  no further archive probes or `/memory/add` worker are part of the current task.
- [x] Apply the researched baseline profiles through the three separate Core
  API fields: all 79 profiles' exact field hashes and selected model verified
  by readback, preserving existing IDs and voice assignments.
- [x] Record the prompting pilot's 36 measured text replies in 18 two-turn
  exchanges for Johnny, Judy and Panam. See `dialogue-style/RESULTS.md`.
- [x] Complete independent blinded prompt evaluation: model-authored means are
  baseline 72.29/100, added directions 66.46, and directions plus native examples
  68.44. This small run does not justify a broad style change; the baseline stays.
- [ ] Follow up promising individual behaviors with repeated, fresh scenarios
  and user conversation/listening checks. Text timing and model-authored scores
  do not establish voice latency or human preference.
- [x] Checkpoint the researched knowledge work (`857af7c`) and Convai streaming
  (`27d6c55`), and install the combined new Lua/context/audio files while keeping
  the quarantined native class excluded.
- [ ] Complete live checks of granular current-world context across private text,
  phone, groups and microphone. The new runtime is active; source
  routing/ownership checks and the earlier read-only capture are narrower results.
- [x] Complete one live streamed Convai reply in eight chunks. Warm connection:
  first provider audio about 2.16 s, request to estimated native speech 5.05 s.
  The user still reports slow response; this is not latency acceptance.
- [x] User accepted improved response timing after the raw-input guard removed
  repeated 515 KB parsing. Observed onset estimates: 5.05 s before, 4.06/3.70 s
  afterward. This was not a controlled provider benchmark.
- [ ] Broader audible continuity, subtitle/face timing and cancellation checks.

Research counts are from generated reports at 2026-09-29 22:40 UTC
(September 30 locally); rollout and qualification status includes the later
Core readback, live streamed reply, read-only probe and reviewed prompting pilot. These statuses do
not mark unqualified live work complete. No quest flags or external save files
are changed by the research/capture tools. The native identity installation
attempt failed startup; removing that component restored the prior game path.

## Checkpoints and present evidence

- `99fc59a`: research schema and character-field compiler checks.
- `522e638`: bounded native capture and pure outcome resolver; live read-only
  snapshot passed the bridge parser on Cyberpunk 2.31.
- `586ff8b`: end-user/audience transport isolation and identified-prefetch guard.
- `857af7c`: reviewed character dossiers and native quest mappings.
- `27d6c55`: Convai streaming and continuous facial playback source checkpoint.
- New persistent native identity code compiled in isolation but failed installed
  startup qualification. Removing only `KnowledgeState.reds` restored startup
  and loading the same save. Dump analysis implicates native Codeware system-map
  initialization; the exact competing writer/cause is not proven. The component
  remains excluded from both normal and Lua-only installs. See `SAVE_IDENTITY.md`.
- The full native inventory has 4,573 winning quest/journal resources and 13,805
  fact symbols. These counts are not claims of interpreted branch coverage.
- `generated/native-coverage.json` records 172 source-verified rules covering
  166 of 1,160 researched outcomes. The remaining 994 are listed explicitly,
  not converted into plausible guesses. Source qualification does not establish
  native execution or the current save's decision.
- The Lua world token proves current lifecycle ownership and cancels prior work.
  It is separate from the one persistent bridge-owned player ID.
- The installed fact-identity probe is read-only: 43 zero-valued reads and
  observer registration succeeded in the current world. A later actual restore
  was observed, still with zero fact writes. These facts are historical evidence,
  not a durable save identity. See `../../docs/SAVE_IDENTITY_ALTERNATIVES.md`.
- One persistent player ID now serves all characters and saves. Natural extraction
  belongs to actual conversations; inactive archive prototypes remain disabled.
- The disposable API A/B receipt is scoped to explicit REST ownership for the
  selected account/model. No production character's memory was enabled by that
  probe; automatic extraction, cancellation exclusion and conversational recall
  remain unqualified.
- Convai streaming now has source/offline evidence for early PCM publication,
  unchanged reconstructed samples and bounded request ownership. The first
  eight-chunk live reply completed, but the user found its response slow.
  The user later accepted better timing after the guard correction;
  broader audible continuity and facial timing remain open. See
  `../../docs/CONVAI_AUDIO_STREAMING.md`.
