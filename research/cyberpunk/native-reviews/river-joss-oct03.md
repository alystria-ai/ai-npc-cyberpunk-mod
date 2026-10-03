# River and Joss: guarded native event history

Date: 2026-10-03. Source scope: installed Cyberpunk 2077 2.31 base and Phantom Liberty archive resources. This is local source qualification; no live-save alias acceptance, installation, provider profile write, or conversation-memory entry is claimed.

## Added coverage

Four rules in `native-rules/river-joss-oct03.json` add three previously unmapped outcomes and Joss's own follow-up perspective on the existing rescued-Randy outcome.

| Rule | Narrative outcome | Required observations | Knowledge limit |
| --- | --- | --- | --- |
| `jr-oct03.river-harris-killed-after-failure` | `judy-river.hunt.harris-afterward/killed-after-failure` | Positive `sq021_randy_kaputt=1`, `sq021_done=1`, and one of three exact revealed River reports | River reports the later killing and covered tracks. The message does not establish V witnessing it; Joss does not inherit this private report. |
| `jr-oct03.joss-abandonment-loss-report` | `judy-river.hunt.rescue/abandoned` | Revealed `contacts/joss/sq021/sq021_river_dead` | Joss was told the bodies were found and blames V. Her message is not an eyewitness account or physical death detection of a summoned copy. |
| `jr-oct03.joss-randy-recovery-report` | `judy-river.hunt.rescue/saved` | Positive rescued/completed facts and revealed `contacts/joss/sq029_joss_abt_randy/01_randy_status` | Her gradual-recovery assessment, gratitude and hope; no complete medical recovery, V reading, or V reply is inferred. |
| `jr-oct03.joss-family-visit-followup` | `judy-river.following.family-dinner/attended` | One exact after-visit thank-you and the separate children's rematch message | Shared family visit/game context. Hospitality and matchmaking do not establish River romance or his optional private disclosure. |

Each rule permits only its named speaker with V, through private or phone conversations. Group routes remain excluded even if V supplies a group disclosure. Joss's message about River cannot silently become River's own knowledge. These save-dependent reports are separate from Johnny/Jackie's personal-history topic cards and from universal intrinsic biography.

The positive saved, lost and abandoned rescue routes share a reviewed `randy.rescue_route` exclusive group. The Harris claim depends on the loss route and joins that same group. Contradictory positive rescue observations suppress the dependent later account as well as the rescue outcomes; unobserved competing facts stay unknown. This requires a narrow group addition to the two existing River rescue rules, without changing their predicates or source statements.

## Native identities and paths

The winning cooked journal contains typed `gameJournalContact` records `river_ward` and `joss`. Their installed name keys `10894` and `10862` resolve to River Ward and Joss Kutcher. Each selected child is a typed `gameJournalPhoneMessage` with `sender=NPC`, the exact child ID and exact localization key. Its activation writer names that same full contact path and native class.

The Harris alternatives are:

- `contacts/river_ward/sq021_bad_messages/16_roof_harris_killed`
- `contacts/river_ward/sq021_bad_messages/18_quest_ends_harris_killed`
- `contacts/river_ward/sq021_bad_messages/19_who_cares_harris_dead`

The distinct forgiveness message is excluded. A revenge intention, completed quest, generic failed-rescue flag or absence of a flag cannot prove the later act.

Joss's visit alternatives are `05_joss_thanks_coming_over` and `05_rom_joss_thanks_coming_over` under `contacts/joss/sq029_joss_abt_river`. Both require the separate `06_optional_thanks_kids` receipt. The message phase gates that latter activation with a positive `sq029_ar_kids_won=1` comparison; absence of that message does not prove the children lost or that V skipped the game.

## Source review and acquisition

- The released EP1 gamedef references the base quest, which references the base quest phase. Its sidequest and additional-game-elements branches reference `sq021`, `sq029`, and persistent content. The `sq029` phase explicitly invokes its messages phase. These are authored release reference closures, not proof of a current save executing the branches.
- Persistent content enters the bad-outcome branch after positive Randy-loss and quest-completion comparisons. The branch waits a game day and a content token; its actual journal writers activate the three reported-killing messages. The runtime retains independent positive loss/completion observations in addition to the receipt.
- Two `sq021` abandonment branches activate Joss's same loss report. Both use `questJournalEntry_NodeType`, while the later message phase uses `questJournalQuestEntry_NodeType`; the authored evidence checks the correct native type for each.
- Joss's recovery message follows the `sq029` messages entry, an eight-game-hour delay and an outside-family-area/content-token check. It precedes a photograph. That report is kept as her assessment, with the existing positive rescue/completion facts.
- The two thank-you branches differ in romance conditions. They are merged only as hospitality evidence. The children's rematch branch has its own positive game-result gate; no intimacy is inferred from Joss's encouragement.

Five bounded quest phases were freshly exported into ignored `cache/game/scene-evidence/river-joss-oct03` and `river-joss-release-oct03`. Their current archive-entry SHA-1 and raw SHA-256 were verified before pinned WolvenKit 9.0.1 serialization. Recorded JSON hashes bind the decoded bytes. Existing authenticated cooked-journal, English onscreen, release and rescue references retain their prior recorded hashes.

The ignored `runtime/knowledge-expansion-oct03/message-source-receipts.json` retains exact paths, localization joins, text digests and inspected message text for independent review. Runtime statements are original paraphrases; the shipped pack does not contain a copied dialogue collection.

## Export integrity correction

The bounded extractor previously omitted `jsonSha256` from its manifest. It now records that hash after serialization. Existing unbound JSON is freshly serialized before qualification, rather than being retroactively authenticated by today's hash. A changed previously qualified JSON is rejected, and its original manifest hash is preserved for investigation. The extractor additionally accepts explicit `.questphase` resources under the same bounded path/decode/cache checks.

## Verification and limits

The strict combined build passes with **195 enabled rules, 188 mapped outcomes, 972 unmapped outcomes, 402 cited artifacts and 5,402 hash-bound evidence pointers**, with no errors or legacy-unbound pointers. The researched total remains 1,160 outcomes. This batch does not turn the remaining 972 outcomes into executable knowledge.

The independent semantic review found and corrected a mismatched Harris topic, the dependent Harris account escaping a contradictory rescue route, and wording that incorrectly asserted V had not witnessed the offscreen act. The actual combined-pack regression now suppresses that dependent account when rescued/lost observations conflict, and keeps missing alternatives unknown. The [full topic audit](topic-identity-audit-oct03.md) additionally documents all 26 retained legacy aliases and the new compiler identity gate; no runtime topic rewrite was made.

The targeted resolver checks cover positive private/phone paths, missing and zero facts, intention versus completed action, unavailable/unrevealed/wrong-owner messages, incomplete visit evidence, wrong speaker/group privacy, contradictory positive Joss histories, unsupported versions, and a fresh rollback snapshot. The explicit local-source gate rejects swapped contact identities, wrong localization keys, wrong writer classes, and stale JSON hashes. Exporter regressions exercise fresh qualification, unchanged resume, unbound reserialization, rejection/preservation of altered qualified JSON, and raw/archive mismatch.

Final focused gate: **43 Node tests passed with the local native-provenance gate enabled, zero failures/skips; five exporter regressions passed**. The independent read-only review checked the native event meanings and all 26 actual topic alias pairs and found no remaining defect after the three scoped corrections. It did not claim live-save acceptance or repeat the full provenance build.

Sandra's respectful and runner-rapport outcomes remain unmapped: the inspected scene supplies access, combat and door flags, but no distinct persisted selector for those responses. No private autobiographical claim is added for another character without its own topic/disclosure selector. No memory is seeded for uncontacted characters.

Generated research outputs were rebuilt without `--apply`; `characters/world-knowledge.json` and the installed game were not changed. Root integration review and natural live-save alias checks remain separate gates. No facts were written to the game, no cloud calls were made, and no commit was created by this lane.
