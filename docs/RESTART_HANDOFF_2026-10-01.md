# Restart handoff — October 1, 2026

The user asked to raise Codex to **25 concurrent subagents**, then said they
would restart Codex. That setting is saved and validated. Research agents have
stopped at safe checkpoints; resume after the user returns.

## Latest user direction

- End additional UI polishing/testing. The interface seems fine to the user.
  The strange **UI layout check** heading was only our temporary diagnostic
  modal; it was cancelled and the installed probe was removed. Do not reopen it.
- Preserve native blinking: the user confirmed it works. Preserve accepted eye
  contact, companion movement and lip sync; do not restart their calibration.
- Knowledge expansion covers **all supported characters**. Major characters
  warrant more depth; one-off quest characters can have limited, well-supported
  knowledge. Do not pad them with invented history or omniscience.
- Extend reference-based cloned voices to the wider cast where correctly
  attributed, suitable dialogue exists. This supersedes the earlier
  Johnny/Judy/Panam-only local-voice scope. It does not ask for per-character
  model training. Keep one shared model and bounded GPU inference; parallelize
  research/reference selection where useful.
- Subagents inherit the current parent's model and reasoning. Do not pin them
  to a model from an earlier session.

## Codex configuration change

File: `C:\Users\akshi\.codex\config.toml`

```toml
[agents]
max_concurrent_threads_per_session = 25
```

Only this value changed (20 → 25). Parsed before/after TOML compared equal after
accounting for that value. Default subagent model/reasoning fields remain absent,
preserving inheritance. Desktop CLI `0.159.2` loaded the updated configuration
successfully with `features list`.

Backup: `C:\Users\akshi\.codex\config.toml.before-agents25-20261001-125726.backup`.
Official configuration reference confirms this excludes the primary thread:
https://learn.chatgpt.com/docs/config-file/config-reference

The running turn still had its old tool capacity; inspect the new session's
reported capacity after restart before claiming 25 agents are active.

## Installed mod checkpoint

- Branch `main`, local only. Latest runtime fixes: `49607d0` (live phone and
  composer widget resolution), preceded by `a315445` (native fonts) and
  `c03fdcb` (ten interface languages).
- All ten Settings languages were captured and inspected. Japanese selection
  before Apply, phone glyphs and normal caret behavior were checked. The user
  ended further UI work. See `INTERFACE_LANGUAGES.md` for exact coverage/limits.
- Full font-stage suite: 1,432 passed, no failures/skips. Final observed-widget
  corrections: 35 focused checks passed. Do not repeat these without a new bug.
- Current saved settings restored to **Auto/English**, **hybrid Omni + Convai**,
  **32 steps**. The unsent test draft was cleared; no diagnostic dialogue was sent.
- Original installed `diagnostics.lua` restored and hash checked; temporary
  installed `runtime/ui-language-check.lua` removed. No capture worker remains.
- Last observed game PID/window: `17832` / `656748`. Resolve again before use.
  Conversation bridge PID was `11680`; product game/voice service were left
  running. No game restart is needed for the next research work.

## Knowledge expansion checkpoints

Production/generated knowledge remains at **172 enabled rules linked to 166 of
1,160 researched outcomes**. All 79 baseline character dossiers are authored and
reviewed. The new work below is not integrated or installed. Do not update counts
or run `build_native_pack.mjs --apply` until independent review and resolver
scenarios pass.

### Panam / Aldecaldos

- Source file changed: `research/cyberpunk/native-rules/aldecaldos.json`, revision2.
  It now has22 source-verified rules and100 unmapped entries.
- Six additions: Nash assistance after tunnel objective success; separate-bed
  motel sharing; completed motel flirt; farmhouse support for Panam; support
  for Saul; private farmhouse flirt.
- Review: `research/cyberpunk/native-reviews/aldecaldos-oct01.md`.
- Author's per-pack verifier passed:122 rules,30 evidence records,53 native files.
  Review includes18-file binary/JSON hash evidence and writer/entry analysis.
- **Still pending:** root's independent semantic review, eight resolver scenario
  groups, merged strict hash verification, runtime rollout. A tunnel completion
  can include defeated/unconscious enemies; it must not claim Nash died.

### Judy / River

- Existing native-rules/judy-river.json is unchanged (16 enabled rules).
- Review: `research/cyberpunk/native-reviews/judy-river-oct01.md`.
- Disabled WIP: `runtime/judy-expansion-oct01/checkpoint.json`.
- Four proposals: Evelyn extracted; Judy's burial SMS confirming death;
  overnight rest at Judy's via morning SMS; completed Laguna Bend dive.
- Author checked21 artifacts,110 exact pointers with binary/JSON hashes and14
  matching installed dialogue joins. Final writer/initializer/async route audit,
  executable assembly and resolver scenarios remain.
- `gameJournalPhoneMessage` and `gameJournalQuest` selectors are required.
  Shared Judy-knows-Johnny flags cannot identify which disclosure occurred;
  Revolution refusal can also mark the quest succeeded. Preserve those exclusions.

### Phantom Liberty

- Existing native-rules/phantom.json is unchanged; no new rules enabled.
- Review: `research/cyberpunk/native-reviews/phantom-oct01.md` and its linked
  ignored WIP/evidence.
- Three candidates: Alex first meeting, completed living farewell, coin gift.
- Fresh shipped `ep1\quest\ep1.gamedef` schedules both base and EP1 quests.
  `ep1_standalone.gamedef` is distinct. Do not use a base-only release closure
  to qualify or reject PL assets.
- Dance flag resets to zero, so it is not durable history. Postcard reading
  needs a `gameJournalOnscreen` visited receipt; the runtime schema currently
  rejects that class. The review records a possible bounded extension rather
  than weakening the condition to spawned/available.
- Evidence serialization, final verification and resolver scenarios remain.

### Johnny / Rogue / Kerry

- Existing native-rules/silverhand.json unchanged; no new rules enabled.
- Ignored checkpoint: `runtime/silverhand-oct01/HANDOFF.md`.
- Isolated batch:22 artifacts (7 scenes,12 graph exports,3 subtitle resources).
- Six candidates: three Swedenborg machine choices with completion gate;
  bot identified; truth reported to Nancy; actual Porsche recovery through
  EnablePlayerVehicle. Writer snapshot spans30 indexes, but bounded corpus is
  not proof of all possible writers.
- Normal-entry/persistent route review, winner recheck for copied inputs,
  exact reference assembly and resolver scenarios remain. Dog-tags/control
  agreement/Archangel transfer remain unknown rather than using completion alone.

All four lane agents reported no remaining owned process. No game fact writes,
cloud character edits, synthetic conversations or memory requests occurred.

## Research tools and integration

- `research/cyberpunk/scripts/plan_native_gaps.mjs` is a new read-only planner.
  Default scope is all authored outcomes; `--characters` narrows a review.
  It reports mappings from source parts, which can be ahead of installed data.
- Native cache: `research/cyberpunk/cache/game/`, ignored. Existing inventory,
  raw exports, scene-evidence folders and index JSONL contain the exact sources.
- `review_native_rules.mjs verify <pack>` checks the authored part read-only.
- `build_native_pack.mjs --require-json-hashes` writes shared generated outputs;
  run only after lane files are stable. Add `--apply` only after review to update
  `characters/world-knowledge.json`. Nothing new has been deployed yet.
- Positive source conditions, normal reachability, all writer/initializer paths,
  stage gates, correct participant knowledge and listener privacy are required.
  Zero/absent is unknown. Keep source verification distinct from live acceptance.

## Voice profile expansion facts

Current configuration: ignored `runtime/local-voices.json`. Shared weights:
`vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots/c5fdb5ccb189668d56333f77ba2629f4cd7535f4`.

- Shared model/tokenizer:3,267,470,260 bytes (3.04 GiB on disk).
- Three reference clips:3,226,982 bytes total (3.08 MiB).
- Warm32-step worker:1,969.81 MiB allocated /2,046 MiB reserved on CUDA,
  `torch.float16`.16/32 use the same weights. No TensorRT is active.
- Python/CUDA/browser dependencies add disk size. This is not a measured ZIP.
- Wider-cast work must make the currently three-profile routing/preparation
  data-driven, audit native speaker attribution, select clean clips, cache
  conditioning safely and qualify representative voices. Do not launch25
  simultaneous GPU voice workers merely because25 research agents are allowed.
- Existing resources: `docs/LOCAL_VOICES.md`, `docs/PACKAGING.md`,
  `scripts/Prepare-LocalVoices.py`, `bridge/resident-voice.mjs`, VoiceStudio adapter.

## Standing constraints

- Never read/edit/execute/stage/delete/move/inspect the contents of
  `scripts/Test-GameInput.ps1`; it is unrelated user-owned untracked work.
- Keep local Git rollback checkpoints. No push, publish, release or human-facing
  external messages without authorization.
- Keep helpers hidden. User-authorized game-window screenshots are available,
  but current instructions end additional UI testing. No input/focus automation.
- Maintain one Convai player ID across characters/saves; no synthetic memory
  seeding. Invite prepares the selected character before spawning; contact
  memory grows through real conversations.
- User authorizes GPU use despite the old gpu use.txt file. Tell them before
  Balanced is needed for meaningful voice/performance work.
- Microphone tests, speculative exploration reactions and more UI/lip/gaze
  calibration are user-deferred. Preserve accepted behavior.
