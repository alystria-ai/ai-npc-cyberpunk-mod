# Deep quest and character knowledge work

User request: research the supplied transcript and quest sites and other sources,
build individual biographies/speaking styles/original sample dialogue, granular
quest/decision mappings from game variables, dynamic context and per-user durable
memory. Include scripts and a dedicated research folder. No shortcut or blanket
claims of full coverage.

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
- [x] Compile and source-verify the current native pack: 165 enabled rules,
  160 distinct linked outcomes, 259 cited artifacts and 3,154 checked pointers.
  This is source qualification, not live acceptance of all rules.
- [ ] Extend exact native mapping for the 1,000 explicitly unmapped outcomes.
  Keep those outcomes excluded until their meaning, positive condition,
  audience and provenance are established; never fill gaps from a fact name.
- [x] Implement bounded resolution, context ownership, local ledger and memory
  transport in source with focused controlled tests. This closes source work
  only; the installation and native-restore gates remain open below.
- [x] Qualify explicit Convai memory ownership on one disposable profile with
  two registered users: independent add/list/get, cross-user denial, empty
  cleanup lists and verified character deletion. See `MEMORY_QUALIFICATION.md`.
- [ ] Repair and qualify native save identity. The new native component caused
  a startup regression and remains quarantined. A compile pass is insufficient;
  startup, save/load, earlier-save branching and stale-callback checks are required.
- [ ] Enable production durable memory only after native identity and the
  remaining extraction/recall gates pass. Production memory is **OFF**; the
  disposable REST test did not prove automatic extraction or live recall.
- [ ] Install and live-check the new granular anonymous current-world context
  across private text, phone, groups and microphone. Source routing/ownership
  checks are complete; the initial read-only capture is a narrower live result.
- [ ] Apply the expanded researched profiles through the three separate Core
  API fields and verify exact readback, preserving IDs/model/voices/settings.
  The earlier field-separation repair is not this new content rollout.
- [ ] Install and audibly qualify the new Convai PCM streaming source, including
  initial playback latency, continuity, subtitle/face timing and cancellation.
  Source and offline checks are ready; the change is not installed.
- [ ] Checkpoint and install the qualified subset with minimal disruption,
  keeping the quarantined native identity component excluded.

These statuses are based on generated reports at 2026-09-29 22:30 UTC
(September 30 locally) and the independently rechecked profile builder. They do
not mark unqualified live work complete. No quest flags or external save files
are changed by the research/capture tools. The native identity installation
attempt failed startup; removing that component restored the prior game path.

## Checkpoints and present evidence

- `99fc59a`: research schema and character-field compiler checks.
- `522e638`: bounded native capture and pure outcome resolver; live read-only
  snapshot passed the bridge parser on Cyberpunk 2.31.
- `586ff8b`: end-user/audience transport isolation and identified-prefetch guard.
- New persistent native identity code compiled in isolation but failed installed
  startup qualification. Removing only `KnowledgeState.reds` restored startup
  and loading the same save. Dump analysis implicates native Codeware system-map
  initialization; the exact competing writer/cause is not proven. The component
  remains excluded from both normal and Lua-only installs. See `SAVE_IDENTITY.md`.
- The full native inventory has 4,573 winning quest/journal resources and 13,805
  fact symbols. These counts are not claims of interpreted branch coverage.
- `generated/native-coverage.json` records 165 source-verified rules covering
  160 of 1,160 researched outcomes. The remaining 1,000 are listed explicitly,
  not converted into plausible guesses. Source qualification does not establish
  native execution or the current save's decision.
- The native-identity-free Lua world token provides anonymous lifecycle scope,
  not a durable campaign or branch ID. It cannot authorize remote memory promotion.
- The disposable API A/B receipt is scoped to explicit REST ownership for the
  selected account/model. No production character's memory was enabled by that
  probe; automatic extraction, cancellation exclusion and conversational recall
  remain unqualified.
- Convai streaming now has source/offline evidence for early PCM publication,
  unchanged reconstructed samples and bounded request ownership. Installation
  and audible in-game latency/seamlessness remain separate open steps. See
  `../../docs/CONVAI_AUDIO_STREAMING.md`.
