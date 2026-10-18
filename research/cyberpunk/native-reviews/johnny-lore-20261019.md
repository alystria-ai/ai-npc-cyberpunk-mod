# Johnny Silverhand: the 2023 tower, Soulkiller and Alt, Spider Murphy (2026-10-19)

Pack: `research/cyberpunk/native-character-claims/johnny-silverhand.json` (24 claims and 21 sources before, 33 and 27 now). The nine new claims are topic material for one-to-one talk (audience `private-one-to-one`); none is public, so the compiled public profile is unchanged (12 claims, 330 verified references, same receipt revision). The 24 older claims and 21 older sources are byte-identical.
Selector: six new curated Johnny topic rows and the hash pin in `bridge/intrinsic-character-context.mjs`, with a test.
Compiler: one reviewed player-actor binding in `playerSubjectBindings` (`research/cyberpunk/scripts/intrinsic_character_claims.mjs`), with a test.
Also: Johnny's chrome arm corrected to the left in `characters/appearance.json`; roster row, profile text and build report regenerated.

## Evidence
- No new extraction: every scene was already serialized by the pinned WolvenKit CLI 9.0.1 (sha256 7ae9c308...) in an existing batch. Raw SHA-1, raw SHA-256 and JSON SHA-256 were rechecked against each batch's inventory, and all 27 sources of the pack against the installed archive directories (`basegame_4_gamedata.archive`, `ep1_2_gamedata.archive`, `lang_en_text.archive`; ep1 first): 27 of 27 match.
  - `firestorm`: `q101_06c_memories_p2` (the raid, Love Like Fire), batch `runtime/voice-cast/silverhand-cast/scenes/flashback-actors/`.
  - `firestorm-capture`: `q101_06c_memories_p3` (the capture) and `alt-aftermath`: `q108_21_finale` (his account after the 2013 memory), batch `research/cyberpunk/cache/game/scene-evidence/priority-endings-20261004-history/`.
  - Their English subtitle files from the installed-localization cache (`research/cyberpunk/cache/game/localization/raw/`).
  - Reused: `alt` (`q110_14_alt`), `codex-text` (base `onscreens_final.json`), `codex-journal` (cooked journal).
- Codex and journal entries cited: codex `johnny_silverhand` (LocKey 20851), `arasaka_tower` (21153), `atomic_explosion_in_night_city` (20616), shard `generic_arasaka_bombing_02` (7157), quest `q101_01_firestorm` (Love Like Fire, 8508) with its objective `follow_spider_murphy` (8513).
- Spider Murphy is identified by actor 7 (`netrunner_phone`, findInContext): record `Character.q101_spider_murphy`, display name LocKey 32275 ("Spider Murphy"), voice 1624173162010259956, and by the objective. The generic actor 5 is not used, as in `spider-murphy.json`.
- In the two 2023 memory scenes the player actor has record `Character.johnny_replacer` and voice 1103967280742240508 but the name `Johnny` (the 2013 memory scenes use `Player`), so the compiler gained that one binding; record, name and voice must all match.

## Claims
| Claim | Kind, mode | Cited lines |
| --- | --- | --- |
| `johnny.memory.tower-raid-plan` | uncertain-recollection, represented memory | firestorm 10, 22, 30 (news, Rogue), 37, 39, 50, 51 (Johnny) |
| `johnny.memory.tower-subnet-errand` | uncertain-recollection, represented memory | firestorm 54-62 (both wordings of the choice at node 961), plus the Spanish and Polish descriptors of 56 and 60 |
| `johnny.memory.tower-capture` | uncertain-recollection, represented memory | firestorm-capture 1, 9, 11, 12, 19 (interrogators, the widow, Saburo), 18, 21 (Johnny); none choice-gated |
| `johnny.history.codex-tower-death` | intrinsic, native codex | codex 20851 |
| `johnny.history.tower-records-disputed` | intrinsic, native codex (Johnny's entry as anchor) | codex 20851, 21153, 20616, shard 7157 |
| `johnny.history.tower-for-alt` | private-intrinsic, self-report | alt-aftermath 8, 21, 73, 83, 84 |
| `johnny.friends.alt-escape-account` | private-intrinsic, self-report | alt-aftermath 17, 19, 21, 47, 48, 69-71, 83, 84 |
| `johnny.friends.alt-soulkiller-blame` | private-intrinsic, self-report | alt 1 (unconditional opening line) |
| `johnny.friends.spider-murphy-netrunner` | uncertain-recollection, represented memory | firestorm 4-7, 70, 71, 73-75 (actor 7 and Johnny) + actor 7 record, objective |

The `alt-aftermath` lines are answers to optional questions (choices at nodes 147, 222 and 306); the claims and their limits say so and do not imply that V asked them. Every claim keeps "his memory", "his account" or "the records say": the memory, his later account and the in-world records disagree, and no claim picks one as history.

## Independent review (Sonnet helper, own verifier, no reuse of the author's; three rounds)
- A. Mechanical: PASS, 0 failures (final state). 27 sources (hashes, FNV path hash, installed winner archive and SHA-1, WolvenKit 9.0.1 / 2310 headers), 671 refs on the nine claims, 47 speaker rows (actor id to line speaker, one `en_us` descriptor per line, payload equal to the shipped subtitle, one emitting dialog event per line); receipt (1458 pointers) and the canonical source hash reproduce; both pins match; the 24 older claims and 21 older sources are byte-identical.
- C. Compile: PASS. Public compile 12 claims / 330 refs, `nativeIntrinsicRevision` unchanged; `verifyIntrinsicAttribution` passes on all nine. Round 1: 18 mutations all threw (wrong voicetag or record, a witness line on Johnny's actor, frame named `V`, V's record on a frame named `Johnny`, an uncited line, a line without a speaker row, a non-player memory frame, an intrinsic represented memory, a self-report spoken only by Alt, a moved codex subject, a scene row on a codex claim, flipped source hashes); rounds 2 and 3: 11 attribution and 5 document mutations still throw. The `Johnny` binding: accepted `Johnny` and `Player`, rejected `V`, `johnny`, `Jonny`.
- B. Semantics and D. Selector, round 1: 7 defects and smaller points, all fixed:
  1. `spider-murphy-netrunner` merged two moments (line 33 is actor 5 speaking to Rogue) and leaned on actor 5; it now uses only actor 7 and Johnny, with actor 7's record and display name cited.
  2. `tower-subnet-errand` said "girlfriend" for "groupie output", blurred who would not understand and called the two wordings identical; reworded, lines 58 and 62 added.
  3. Limits on `alt-escape-account`, `tower-for-alt` and `alt-soulkiller-blame` carried later-Alt content (and line 92, which needs two choices) into unconditional topics; they are now plain guards.
  4. `alt-escape-account` used line 21 without citing it and read as narration; cited, attributed per clause.
  5. Selector false positives (bare bomb, nuclear, captured, interrogate, Smasher, spider, Murphy); associations and a block list added.
  6. Selector misses (what happened to Alt, where Alt went, Alt got out, take down Arasaka Tower); fixed.
  7. Roster, profile text and build report were stale (old pack hash, right arm); regenerated.
  - Smaller: no "2023" in the memory claims (the scenes carry no date; `spider-murphy.json` makes the same point), the news line now used, the shard's "early August" against the codex's 20 August stated, V limits on every memory claim, `alt-soulkiller-blame` reworded away from the game line.
- Round 2 (re-check): fixes 1-4 and 7 held; the tighter selector then blocked present-day questions but also over-tightened (regret, guilt, plant the bomb, get the nukes, bomb's name, "were you captured"), and three wording points remained ("tells her" was ambiguous, "other subtitle languages" overstated the scene's Spanish and Polish lines, "a little after she was taken"). All fixed; the Spanish and Polish descriptors of lines 56 and 60 are now cited.
- Round 3 (re-check): the round-2 text fixes held; the present-day block list also silenced past questions ("What was the plan for the 2023 raid?", "Why did you storm Arasaka Tower?"). The block now applies only when the question has no past marker (2023, back then, was, were, did you), "breaking into" and "heist" were added, and `tower-death` ignores plans and Mikoshi; checked by the author with the reviewer's question list.
- Accepted limits of the shared question gate: "Is Alt still alive?", "Did Alt contact you?" and "Who killed you?" select nothing, because every topic needs a personal-question form.
- E. Arm: the reading holds (below). Caveat: indirect evidence; the forearm markings swap is the symmetric correction, not separately evidenced.
- Judgement calls kept: all nine private (the public profile stays as reviewed); the `Johnny` binding; both subnet wordings cited; Johnny's own codex entry as the anchor of the records claim; the conditional `johnny.memory.alt-identity-boundary` in no topic; his anger (`soulkiller-blame`) and his defence of her (`escape-account`) kept as separate attributed accounts.
- Noted, not changed: three older non-public claims (`johnny.memory.subjective-record`, `johnny.memory.alt-identity-boundary`, `johnny.music.early-gigs-corroboration`) fail today's `verifyIntrinsicAttribution` only for a missing `subjectConnection` field (their speaker and frame checks pass); the compiler hash-checks only sources used by public claims, so the private claims rely on this review and the selector's reference-shape checks.

## Arm side
`silverhand.app` (batch `silverhand-physical-appearance-20261002`): 36 of 37 appearances carry the base-body right-hand nail mesh `a0_000_ma_base__nails_r` and none the left one, although `a0_000_ma_base__nails_l` sits in the same `basegame_4_appearance.archive`; the 37th (`invisible`) has none. The left hand is the chrome one, as the dossier and profile already said. `characters/appearance.json` said right (most likely a mirrored or viewer-side reading of the source picture), so its sentence was swapped: left arm chrome, markings on the right forearm.

## Topics not covered
- Morgan Blackhand: no installed Johnny line, scene or codex text links him to Johnny. The eight English lines naming him are spoken by Jackie, Claire, Misty and Reed or come from the prologue and ambient chatter; Love Like Fire has no Blackhand. Recorded as an exclusion.
- Songbird: Johnny is not an actor in the fate scenes (`q304_07b_lab`, `q305_10_songbird_finale`, `q305_11_border_crossing`, `q306_10_finale`), so no audience additions. His view of her is spoken in `q305_12_johnny` and `q306_11_resolution` as answers to V's dialogue options, which no fact records; only `phantom.native.ncx.moon` (Johnny as participant) covers him. Lead: trace the option-independent lines of `q306_11_resolution` (section 425, "She made it") and a receipt that the `q305_12_johnny` talk played.
- Endings: already covered by the `priority-endings.johnny.*`, `sh5.*` and `silverhand.*` rules with Johnny as speaker; every opinion of his about an ending sits in a route-gated scene, so no intrinsic claim (exclusion added).

## Not done
- The Convai re-provision of Johnny's profile for the arm sentence (needs approval): `node scripts/Provision-Characters.mjs --apply --only johnny-silverhand`, then `node scripts/Create-MultilingualProfiles.mjs --apply --only johnny-silverhand`, then `node packaging/Refresh-ReleaseData.mjs`. No live call was made.
- `research/cyberpunk/generated/coverage.json`, `profile-plan.json` and `quest-catalog.json` were left as committed: a rebuild also rewrites unrelated characters' stale hashes there.
- Spider Murphy's own audience on `priority-endings.johnny.firestorm-memory` (told-by-V, like Santiago and Thompson) is a lead for her lane.
