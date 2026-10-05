# Cyberpunk Convai: TODO and captain's log

The single working document for development: open items first, then a dated log, then the standing facts every session needs. It replaces `HANDOFF_README.md` (removed October 5; still in git history). Earlier code and docs were written by a weaker model, so verify claims against code and data before relying on them.

## Open items

### In progress
- **Student distillation** (Kaggle kernel 137135141, `cp2077-full-a-student-114278c5e96c449e`, bucket run `full-a-student-20261005-114278c5`). Teacher: update 1,000 raw from the expanded run. It stops after two evaluations without held-out improvement (earliest 2,000 updates, cap 12,000). Next: pick the best checkpoint by held-out and speech evidence, produce listening samples, and install only with user approval. Check with `vendor/kaggle-env/Scripts/python.exe scripts/Pocket-FullAStudent.py stream --folder runtime/voice-data-expansion-20261005/full-a-student/<run>`.
- **Teacher listening samples** (agent): blind A/B page in `runtime/listening-20261005/` comparing teacher 1,000 raw, teacher 6,000, the current student and a real reference clip, for Evelyn, Jackie and the lowest-clip voices. The user judges by character likeness, not WER.
- **Loot setting text + dead code** (agent): new help text in all 10 locales; remove `loot.capture({forBattle=true})`.
- **Lip sync + facial expressions** (agent): all three routes, Convai emotion, and Convai audio-output start at turn start (~150–200 ms).

### Waiting for one combined install and in-game test
After the agents above finish:
- Install order for lip sync: install the new `facial-playback.lua` before (or together with) the model weights in `runtime/lipsync-model/face-model.*`. Old Lua rejects the new timelines, so the mouth would stay idle.
- Restart the bridge, now via the auto-start supervisor, which loads the latency fixes and Pocket's 4 threads.
- First launch with auto-start: check `red4ext/plugins/CyberpunkConvaiLauncher/launcher.log`, talk without starting the bridge by hand, and confirm the bridge stops when the game exits.
- Memory picker messages ("…deleted nothing") and Fight / Distract actions (needs the "mark target for companions" binding set in CET) and the question-rule change in game.
- Quest knowledge on the current save: Johnny on Songbird at Cynosure and on Judy; Regina on the Monster Hunt; Reed on before the stadium.
- Lip sync, expressions, quest knowledge, duplicates, comments, group chat speed.
- Help page (Settings → Help → Help and support): open it with the service running and then with it stopped, press Generate report, and check the path in the banner and page, the popup after Esc, Copy report path and that the zip holds no key or chat text. Install `support-report.lua` and the updated `mcm.lua`/locales (CET reload); the bridge restart adds the report service and `runtime/support-paths.json`.

### Not yet tested in game
- Cars: fast-travel recovery, the "drive for me" chauffeur after today's changes, alternate owned cars, the boarding pause when V doesn't get in, overhead captions while boarding.
- Movement: the spawn-pocket placement fix (exit sweep) hasn't come up in play.
- Relationships: profile routing on a relevant save; natural recall of quest branches.

### Smaller gaps
- Install manifests are missing the quest-knowledge modules (`fact-identity*`, `knowledge-state`, `save-identity*`); add them with the quest agent's results.
- Convai test user `44634786-9337-4103-b8dd-dc553202563b` (on alex): `memory/list` returns HTTP 502, which looks like a Convai server fault. Remove the user when it's no longer needed (`memory/delete-all`, then the dashboard).
- After all agents finish: run the full `npm test` and triage what fails. Last seen: 12 failures, including missing `pwsh.exe`, two GPU browser tests, the bridge-import allowlist, installer and binding setup; `group-lookahead-bridge` and `bridge-startup` pass alone.
- Convai early audio-player open (latency item A): not done. The player fails with "admission expired" if no control arrives within 2 s of opening, so opening it at turn start would break slow Convai turns. Needs a different design (for example, open early with a longer or renewable admission window).
- `packaging/runtime-bootstrap.test.mjs` fails: its allowlist lacks newer bridge modules (`analysis-pcm`, `distraction-context`, `jali-face*` and others). Fix it once the lip-sync and actions modules are final. `bridge-startup.test.mjs` times out under full-suite load but passes alone.
- Movement design questions from the test triage: (1) a follow blocked beyond 6 m can still enter the "advance" detour mode (`block()` in `companion-actuator.lua`), but no current test reaches it. Decide whether to keep it for follow, and test it if so. (2) Initial follow admissions skip the 2-member planning turn, so each one costs one native navigation query (8 at once costs 8). The 192 physics-query cap still holds. Treated as intended.

### Later
- Packaging a player release: ship the prebuilt voice client; use the auto-start supervisor instead of `packaging/runtime-bootstrap.mjs`; allow `red4ext/` paths in `release-plan.json`; first-run key setup; no keys, player data, audio or training data in the package.

### Dropped by the user
- Mixed voice providers in one group (and their cancellation).

## Captain's log

**2026-10-05: resumed session**
- Help page and support report: Settings now ends with Help → Help and support. It explains what to do, shows the service state, lists absolute log paths (mod `runtime`, service logs, launcher, CET, redscript, RED4ext, reports) and has Generate report, Last report and Copy report path. Generate writes `runtime/report-request.json`; the bridge (`bridge/support-report.mjs`) builds a redacted `runtime/reports/convai-report-*.zip` (versions, status, settings, party, provider per companion, recent errors, the last 2,000 lines / 1 MiB of each log), newest 5 kept, and answers in `report-result.json`. If the service is stopped or silent, `mod/support-report.lua` writes a short text report itself. Keys, tokens, audio, chat and transcripts never enter it; IDs are hashed; planted-secret tests cover both writers. Docs: `docs/MANAGER_UI.md`. Not yet tested in game.
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
- Phone Chat tab icon: the 11-rectangle bubble is replaced by the game's own `mappin_icons.inkatlas` `talk` glyph (36 px, tinted red/blue like the label), in `PhoneChatTabs.reds`. Compiles; needs a game restart; size and alignment not yet seen in game. If it looks poor in game, have an agent make a custom chat asset.
- Invitation notices: routine invite progress popups (manager and phone) now appear only in Developer mode; driving popups were already gated. Failures, "joined", "dismissed" and driving errors always show. Revised the same day at the user's request: preparing memory, connecting, joined and the "ready" lines that tell the player to act always show. "Joining", the phone acknowledgement and a successful "dismissed" are Developer mode only. A failure first seen while paused posts exactly once when gameplay resumes; the phone's immediate duplicate is gone. The Developer mode description is reworded in all 10 locales (9 hand-translated, unreviewed). Not tested in game.
- Combat and loot follow-up (user request): after a fight, pickups made before the closing request is written (mid-fight ones too) are folded into one reply from one speaker, at most 2 sentences. The closing waits up to 14 s for a pickup still being collected. A later pickup gets its own comment; carried pickups start the cooldown. Every pickup now gives the item's name, type, quality and tooltip description (`LocalizedDescription`, cleaned, max 280 chars). The "say it's Legendary" instruction is gone, and quality only drives the 2-minute cooldown. The description read hasn't been verified live.
- Help page: Settings → Help → Help and support (MCM), with log locations (real paths via the bridge's `runtime/support-paths.json`), Generate report (a redacted zip in `<mod>/runtime/reports/`, newest 5 kept; a Lua-only `.txt` when the bridge is down or silent) and Copy report path (`ImGui.SetClipboardText`). Redaction covers keys, tokens, IDs (hashed), the Windows name and chat text, tested with planted values. Limit: the Lua-only fallback can't scrub a bare key with no recognisable pattern.
- Stale voice after reassign: reassigning a copy's profile now retires that copy's in-flight private reply: text, voice, automatic comment or distraction line, whether still generating, speaking or showing captions. It goes through a new `companions.onProfileChanged` hook, `microphone.revoke`, and removing `last-input.json` (the bridge aborts with no playback). Other copies, group rounds and delivered replies are untouched. 9 tests; not tested in game.
- Combat and loot comments: a pickup made within about 2 s after a fight used to speak before the combat closing. It now waits up to about 8 s for the closing, but only while a witness could actually speak it. Loot taken mid-fight still goes first. Legendary pickups (Legendary, + and ++, any category) now get a prompt to say it's Legendary and name the item or its type. One unreadable inventory event no longer disables new-equipment detection for the session. The 2-minute Legendary cooldown is kept. Eleven fixture failures were fixed (stubs for `canDeliver`, `fileIdentity` and `RequestFileOwner`). Not tested in game; the real native Legendary path has never run.
- Quest outcomes: the pipeline already worked end to end; a new offline save reader (`research/cyberpunk/scripts/save_snapshot.mjs`) agrees with the live capture 527/527. Coverage went from 382 to 749 of 1,162 outcomes (768 rules). Capture limits were raised from 512 to 1,024 entries per list, and the read-cycle window from 3 s to 5 s, so the bigger pack isn't silently dropped. Five wrong rules: four fixed (NetWatch deal ×2, Judy's and Panam's Sun goodbyes), Jesse's call disabled. Relevance ranking fixed. Johnny is now a co-witness of what V lived through from the Relic to Mikoshi (`native-cowitness.json`; the user chose to keep it), so he goes from 22 to 293 true outcomes on the current save. The 413 unmapped outcomes have reasons in `native-reviews/*-20261005.md`. Write-up: `docs/QUEST_OUTCOME_COVERAGE_2026-10-05.md`. Risk: each read cycle is now 993 entries; if replies say world knowledge is unavailable, the cycle is too slow. Install `world-knowledge.lua` and `.json`, then CET reload and a bridge restart.
- Group chat speed: the bridge now runs the predicted next speaker's turn while the current one is still speaking and holds its audio until the game claims it (`bridge/group-lookahead.mjs`; no Lua change). The gap between speakers dropped from a median ~3.0 s to ~0.8 s with live Convai, and from ~1.9 s to ~0.3 s in fixtures. It cancels on interrupt, dismissal or audience change. Limit: if V interrupts, Convai may already remember the unheard held reply. Needs a bridge restart and an in-game check (steps in `docs/GROUP_VOICE.md`).
- 22 old movement test failures: all were out of date or fixture faults; no production bug. The fixes put follow-projection scenarios inside the 6 m horizon, used dense routes for the query budget, raised step stubs above the new first-point allowance (.35–.65 m), counted retargeted waypoint goals, and added a `GetEntity` stub. The `companion*` suite now passes 508/508 (commits 3b83300–84d7c38).
- Old manager/invitation test failures: all three were out of date after commit 986ad09 (failure latch); tests aligned, no production change.
- Relationship routing review: all five Auto predicates re-checked against the extracted quest graphs (single production writers, no breakup writers, decline outcomes write other facts; `docs/RELATIONSHIP_PROFILES.md`). One fix: Judy's Auto now keys on `sq030_judy_lover` alone, since `sq030_romance` waits for the clothes pickup after the romance exit. New `bridge/relationship-channels.test.mjs` (Auto true/false/unknown, On, Off for all five; private, microphone, comment, group, phone; mid-session switch; reassigned copy; invitation route; Lua capture parity). New `runtime/relationship-routing.json` shows each character's current decision. Needs a bridge restart; no Lua change. In-game check still outstanding.
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
