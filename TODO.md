# Cyberpunk Convai: TODO and captain's log

The single working document for development: open items first, then a dated log, then the standing facts every session needs. It replaces `HANDOFF_README.md` (removed October 5; still in git history). Earlier code and docs were written by a weaker model, so verify claims against code and data before relying on them.

## Open items

### In progress
- **Student distillation** (Kaggle kernel 137135141, `cp2077-full-a-student-114278c5e96c449e`, bucket run `full-a-student-20261005-114278c5`). Teacher: update 1,000 raw from the expanded run. It stops after two evaluations without held-out improvement (earliest 2,000 updates, cap 12,000). Next: pick the best checkpoint by held-out and speech evidence, produce listening samples, and install only with user approval. Check with `vendor/kaggle-env/Scripts/python.exe scripts/Pocket-FullAStudent.py stream --folder runtime/voice-data-expansion-20261005/full-a-student/<run>`.
- **Lip sync + facial expressions** (agent): all three routes, Convai emotion, and Convai audio-output start at turn start (~150–200 ms).
- **Quest outcomes** (agent with Sonnet helpers): review the pipeline, map every outcome that has a reliable native predicate, then merge and verify the pack.
- **Combat + loot comment queue and Legendary pickup comments** (agent).
- **Stale voice after reassign** (agent): retire a copy's in-flight private reply when its profile is reassigned.
- **Old test failures** (agent): 2 `manager.test.mjs` tests and 1 `invitation-readiness` test, judged out of date, real bug or broken setup.
- **Relationship routing review** (agent): verify Auto/On/Off routing and quest predicates for Judy, Panam, River, Kerry and Meredith, with tests.
- **22 old movement test failures** (agent): judged out of date, real bug or broken setup.
- **Group chat speed** (agent): request the next speaker as soon as the previous one's text is known, and prefetch its audio.

### Waiting for one combined install and in-game test
After the agents above finish:
- Restart the bridge, now via the auto-start supervisor, which loads the latency fixes and Pocket's 4 threads.
- First launch with auto-start: check `red4ext/plugins/CyberpunkConvaiLauncher/launcher.log`, talk without starting the bridge by hand, and confirm the bridge stops when the game exits.
- Memory picker messages ("…deleted nothing") and Fight / Distract actions (needs the "mark target for companions" binding set in CET) and the question-rule change in game.
- Lip sync, expressions, quest knowledge, duplicates, comments, group chat speed.

### Not yet tested in game
- Cars: fast-travel recovery, the "drive for me" chauffeur after today's changes, alternate owned cars, the boarding pause when V doesn't get in, overhead captions while boarding.
- Movement: the spawn-pocket placement fix (exit sweep) hasn't come up in play.
- Relationships: profile routing on a relevant save; natural recall of quest branches.

### Smaller gaps
- Install manifests are missing the quest-knowledge modules (`fact-identity*`, `knowledge-state`, `save-identity*`); add them with the quest agent's results.
- Convai test user `44634786-9337-4103-b8dd-dc553202563b` (on alex): `memory/list` returns HTTP 502, which looks like a Convai server fault. Remove the user when it's no longer needed (`memory/delete-all`, then the dashboard).

### Later
- Packaging a player release: ship the prebuilt voice client; use the auto-start supervisor instead of `packaging/runtime-bootstrap.mjs`; allow `red4ext/` paths in `release-plan.json`; first-run key setup; no keys, player data, audio or training data in the package.

### Dropped by the user
- Mixed voice providers in one group (and their cancellation).

## Captain's log

**2026-10-05: resumed session**
- Training: a fresh full A teacher ran on 8,140 clips / 79 voices. Throughput: staging ~19 min, latent preparation ~30 min, 1.8–2.1 s/update, ~44 min per 1,000 updates including evaluation and a 5 GB checkpoint upload. It **overfit**: held-out best at update 1,000 raw (0.3305), worse every checkpoint after; speech WER rose from 1.2% to 5.6%. It was stopped at 6,000 and update 1,000 selected. Session fixes: a 30-minute end-of-session save reserve, the 10-minute 5 GB local saves removed, and a resume launcher (`Pocket-FullATeacher.py resume`). Then the student run above, launched with held-out stopping.
- Movement (all confirmed in game unless noted):
  - Distant catch-up uses one native follow command instead of a fresh MoveTo every ~0.4 s.
  - False blocks at departure removed: player-crossing while V runs, sideways start-shuffle sweeps, checks of the volume the body already occupies, and vertical steps at the feet.
  - Pace: companions match V's speed while V runs and ramp up with distance, like vanilla followers' time dilation (capped at 1.6×), without overriding other dilation effects.
  - Recovery uses an owned `AITeleportCommand`: transform teleports were undone by the AI. It covers stranded companions (>30 m), gaps over 60 m out of view, and no native route at all (rejoin after 4 s out of view, or 12 s even if watched), always landing out of view.
  - Spawn placement requires a walkable exit (not yet seen in game).
- Cars: the overflow convoy now follows V's car rather than the seated player puppet (confirmed).
- Phone: contact-list racing was a held key auto-repeating into the wrapping list, now fixed. The in-row "INVITE QUEUED - CLOSE PHONE" line is restored without moving the row (confirmed).
- Latency: six bridge fixes. Pocket text-to-audible went from ~1.0 s to ~0.6 s; Convai Enter-to-audible from ~2.3–3.1 s to ~2.1–2.8 s; Omni overlaps GPU rendering with lip analysis; a file-in-use error no longer cuts speech. Pocket default threads raised to 4. Applies at the next bridge restart.
- Bridge auto-start: a RED4ext plugin starts a Node supervisor with the game and stops it on exit (installed; first launch not yet checked).
- Conversation: the "always ask a follow-up question" rule is removed from prompts and all 84 profiles' speaking style, and re-pushed to Convai. The MCM toggle is gone.
- Actions: Fight and Distract are implemented (`docs/COMPANION_TACTICS.md`), not yet tried in game.
- Duplicate copies: phone dismiss now removes one copy by the character it speaks as, newest first, and skips a chauffeur driver if another copy can go (16 tests). Cars: dismissing one passenger no longer makes everyone re-board, and only the chauffeur driver leaving cancels a trip.
- Phone contacts: mapping covers all 102 catalog contacts every session, so mid-session unlocks already work for J-invites (test added). Memory picker now says nothing was deleted when backing out or cancelling.
- Housekeeping: `world-lifecycle` (15/15) and `knowledge-integration` (26/26) fixtures repaired, `movement-log.lua` added to the install manifests, UI catalog regenerated, retired follow-up strings removed.
- Docs: the voice cloning devslot moved out of the repo to `C:\Users\akshi\Downloads\convai voice cloning devslot` (technical cloning info only; no audio or checkpoints).
- Computer use can see the game, but can't drive it reliably. The user does the playing; I launch the game and ask what they saw.

## Standing facts

**Paths**
- Project: `C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod`
- Game: `E:\SteamLibrary\steamapps\common\Cyberpunk 2077` (2.31); CET mod at `bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai`
- Movement trace (Developer mode): `<mod>\runtime\movement-trace.ndjson` (+ `.previous`); read-only diagnostics via `<mod>\runtime\diagnostic-request.txt` (`companion-systems:<nonce>` reports the vehicle fleet).

**Never touch**
- `scripts/Test-GameInput.ps1`: don't read, run or stage it.
- `mod/diagnostics.lua`: don't edit or stage it.
- Credentials are under ignored `runtime/` and must never be printed or committed: `convai-key.txt`, `kaggle-access-token.txt`, `huggingface-checkpoint-token.txt`, `huggingface-token.txt`. Generated Kaggle notebooks embed a token; never stage them.

**Models**
- Runtime student: `runtime/kaggle-pocket-student-transfer-ddb133ba-output/student-transfer-results/distill/export/model.safetensors` (six layers, EMA 1,500, CPU FP32, CFG 1, one decode step, temperature 0.3, now 4 threads). Keep it until a replacement is approved by listening.
- Earlier accepted teacher: `runtime/kaggle-pocket-teacher-improve-retry-output/.../teacher/export/model.safetensors`.
- Private checkpoint bucket: `akshitireddy/cyberpunk-pocket-rolling-checkpoints` (three rotating slots per run).

**Decisions that stand**
- Voice condition A. No per-character models; one shared model plus a reference per voice.
- Preserve source audio: no added EQ, pitch, denoise or crossfades.
- Convai speech is one continuous stream; Pocket gets the full reply text once; Omni is phrase-scheduled.
- Shortcuts are the player's own CET bindings. There is no Apply button in settings. Esc from the manager returns to gameplay.
- No automatic companion respawn on save load, death, restart or CET reload; fast travel is the exception.
- Follow-ups are free (no forced questions). Group: the addressed character speaks first; duplicate copies don't multiply speakers.

**Working with the user**
- Ask with a multiple-choice question whenever the user needs to act or decide.
- For tests: launch the game myself (PowerShell `Start-Process` on `bin\x64\Cyberpunk2077.exe`), then give exact steps and observation options, then read the trace.
- Lua changes need CET → Reload All Mods; redscript or plugin changes need a game restart.
- Install by copying only the intended files (from git when other agents have uncommitted work), and compare afterwards.
- Subagents: Sonnet by default, Opus only for genuinely open-ended work. Tell them the same rule for their own helpers.
- Commits: local, focused, no AI attribution, never `git add .`.
