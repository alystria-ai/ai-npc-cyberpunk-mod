# Heywood native outcome review

Reviewed against the installed Cyberpunk 2077 **2.31** base/Phantom Liberty resource corpus, 2026-09-30.

## Qualification and delivered scope

- **29 executable source-verified rules**, covering **28 distinct narrative outcomes** across **18 decisions**.
- **29 native evidence records**, **41 binary-hash-pinned artifacts**, **777 verified JSON pointers**.
- Narrative research inventory remains **34 quest slices, 86 decisions, 129 outcomes**. **101 outcomes have no executable mapping in this lane**. The complete outcome gap matrix below makes that boundary explicit.
- Source verification covers the shipped graph/scene meaning and unchanged native resources. It does **not** claim in-game collection, a current save's state, audio/video observation, or production deployment.
- No saves, quest facts, archives, game requests, remote character profiles, or Git commits were changed by this mapping work.

The existing twelve dossier files supply original biographies, separate delivery descriptions and original sample dialogue. The two baseline stage leaks identified by the profile peer review were corrected: Fred no longer assumes championship attendance by Viktor, and Ozob no longer assumes a shared Tyger Claws driving job.

## Evidence method and release lineage

The machine-readable pack is `native-rules/heywood.json`. Every rule names an exact narrative `decisionId/outcomeKey`; evidence contains `jsonPath`, native binary SHA-256 and an exact JSON pointer. Scene actor indices and screenplay-to-English descriptor/payload joins are retained beside the relevant comparator/write.

The game-definition root explicitly declares `base\\quest\\cyberpunk2077.quest`. Its start node enters `cyberpunk2077.questphase`; the production minor/side/prologue dispatchers reference the reviewed phases. The common evidence `heywood-native-production-lineage` includes exact phase references and bounded control-socket paths into the actual scene inputs. These prove branch availability in the shipped graph, **not that a current save traversed a path**. Only separately captured, known facts/revealed journals can make a rule true.

Examples of inspected production inputs:

| Scene family | Production input / continuation |
| --- | --- |
| Jackie's destination | Garage graph scene106 `q005_14_elevator_in_lobby_in` -> `back_to_notell` -> scene98 `q005_14_back_to_motel_in` |
| Wilson | mq011 competition subgraph enters scene69 through `mq011_start_in`; the phone call is a separate `mq011_call_in` input |
| Jesse | Initial `mq012_00_stud_appear_in`, clinic `mq012_00_at_ripperdoc_in`, and delayed `mq012_00_holocall_in` are separate scene invocations |
| Dennis | Briefing `quest_begins` continues into village In1, then living extraction into ending In1/Start0; `quest_ends` is a different exit |
| Nix | Production Afterlife phase invokes the reviewed Spellbound/Kold Mirage return scenes |
| Ofrenda | sq018 production funeral phase invokes the ceremony scene; ceremony start and finish are different journal operations |

Standalone `mq033_tarot.quest` and `mq055.quest` contain body-route test writes but are absent from the base release reference closure. Their exact writer refs are retained as alternate-writer evidence, not treated as release entry points. EP1 initialization also writes the family route; the base root closure is not a complete expansion bootstrap graph. Such initialization can establish this save's default history, **not a human-selected conversation**. Body instructions are therefore phrased as save-established history and additionally require V's authored disclosure to each recipient.

The fact-assignment index was checked for all 18 allowlisted facts. It covers quest/phase resources; it is not an exhaustive export of every game scene. The fifteen bounded Heywood scene exports were independently inspected for scene writes and local branch semantics.

## Accepted semantics

### Jackie, Mama, Misty and the ofrenda

Destination choice952 distinguishes **family**, **wait here**, and **Viktor**. Its actual sections end in three distinct positive writes. V and Delamain are present; Mama, Misty and Viktor are not. The three rules use `told-by-v` and require an exact current-world disclosure receipt for the speaking recipient. Merely spawning a copy or reading a positive destination flag does not grant family members knowledge of the cab conversation.

The later disposition is intentionally separate. An instruction to wait does not itself prove eventual delivery; an instruction to Viktor does not itself prove Arasaka seized the body.

The funeral ceremony rule requires the positive **Succeeded** state of `03_take_part_in_ceremony`, written by scene314 after the toast. The earlier `sq018_ofrenda_ceremony` write means the ceremony started, so it is not used as completion. Likewise `sq018_03_speech_done` is written before the speech section and is not a finished-speech receipt.

Each of the four offerings has an item-specific positive write from its selected placement section, plus completed ceremony. Mama is a present witness. These writes are not confused with finding/picking up the objects in the garage.

The literal shipped reconciliation flag is **`sq108_03_mama_welles_misty_asked`**, including the unusual 108 spelling. It is written after V's request that Mama invite Misty to dinner. It proves the encouragement, not that the dinner happened or that Misty already heard about it.

The bike rule requires the positive key-acceptance write and completed ceremony. Declining the keys shares later journal completion, so that generic completion is insufficient. Package-only bike acquisition remains separate.

Misty's `sq018_03a_misty_invited` was inspected and correctly identified as an invitation. It is not silently promoted to attendance, nor is zero read as not invited.

### Nix

**Kold Mirage:** laptop success -> `mq016_hacked` occurs before recovery. Both rescue paths converge, then recovery dialogue explicitly branches on the hack. The later `mq016_saved_life` write and recovery objective Succeeded establish the surviving post-rescue conversation. The computer rule needs all three positive observations.

The power route additionally needs **known, present `mq016_hacked == 0`**, guarded by the completed recovery objective. If the collector only returns an ambiguous zero, this route correctly stays unknown. `mq016_fusebox_active` is written on the *computer* route and is not a safe power-shutdown marker.

**Spellbound:** accepted sale/payment branches converge through rewards and item-removal nodes100/106, then write `mq015_tablet_sold`. The inspected item operations remove the encrypted and decrypted tablet variants from V. This supports delivery, without inventing price, prior acquisition method or decryption. `mq015_05_rude_to_nix` appears on refusal routes too and cannot identify a negotiated bonus.

### Pepe and Cynthia

Cynthia's choice17 -> explanation section38 -> `mq040_wife_story_heard` records her explanation privately to V. It does not make Pepe present, prove an affair, or substitute for a paternity test.

Pepe's supportive report is the actual choice81 -> section87 -> positive `mq040_situation_defused` route. It means V encouraged forgiveness and Pepe agreed at that moment.

The two aftermaths require **the exact revealed Pepe message**, not a broad quest completion or the negation of the supportive flag. Cooked journal entries join installed onscreen keys18876/18877 to the distinct messages. Only Pepe receives that message-level private history; it is not automatically disclosed to Cynthia. The non-defused route combines several earlier responses, so it cannot name one particular negative advice choice.

The supported report/reconciled message and the separated message are in a reviewed mutually exclusive route group. Contradictory snapshots suppress that route's claims.

### Boxing and Ozob

Fred's actual acceptance write is `mq025_offer_yes`, after section270. `mq025_offer` only records hearing the proposal. An accepted offer plus a lost fight does not prove V intentionally threw it.

The Razor fight subgraph sends its objective to Succeeded when Razor reaches the loss threshold, or Failed when V does. The positive objective state is the rule gate; absence of a win flag is not defeat. Fred is the actual official. No optional Viktor advice is inferred from his greeting flag.

Ozob's win counter also increments when his nose grenade is destroyed. The living victory rule therefore requires the positive **talk_ozob Succeeded** receipt from the intact-nose aftermath and Ozob's conscious surrender/reward route. The grenade-destruction and win-counter nodes are retained in evidence.

Fred's two Pacifica messages use installed onscreen keys14518/14519. Their text says he **heard about** the result; he was not a witness. The fatal outcome is never inserted as Ozob's surviving personal memory. Living/dead routes use a shared exclusive group, so inconsistent observations suppress both.

### Wilson

The stopped shooting section performs score comparisons: >40 writes first place, otherwise >25 writes second place. Wilson's result sections explicitly read those placement flags. The rules require a positive placement plus completed competition journal.

Debug force inputs reside in the separate `chicken_in` entry. The runtime does not read those flags or infer a score from them. It also does not use the raw hit counter, which can reset. Below-second placement remains unknown without a positive selected terminal receipt. Wilson's optional business discussion can be skipped before shared completion.

### Dennis and Jesse

Dennis's accepted option has a distinct `quest_begins` exit. Its production continuation activates the fishing-village objective; active/succeeded revealed state is sufficient to remember the accepted instructions.

For delivered-alive, the ending scene includes Dennis acknowledging success and **Haruyoshi speaking**. Its End0 continuation marks the cargo conversation Succeeded. That receipt does not require the optional surgeon-history choice. Consequently the secret admission and actual katana pickup remain separate gaps.

Jesse's accepted-help options directly mark the help objective Succeeded. An initial refusal can loop back; generic quest failure has other causes and is not treated as final refusal.

For payment, successful native holo start grants the named quest reward, Jesse confirms the transfer in section232, and only the completed callback output enters the quest's Succeeded socket. The mapped receipt is that completed callback, not generic `mq012_done`, a car-state latch or a requested call. No failure is turned into a surviving memory of Jesse dying.

## Localization review

The additional range scene's 73 English descriptors matched installed subtitles. The three small-job scenes had 139 English descriptors, with no text conflicts; the three absent subtitle IDs are Jesse descriptors218–220. They are **not** used by the acceptance or completed-payment rules (the latter cites245 and249).

The initial Heywood batch contained 36 scene/subtitle differences and one absent ID. The inspected differences affecting this lane were formatting, punctuation, or wording variants rather than contradictory branch meanings. Supporting evidence retains exact scene joins; installed subtitle text takes precedence if meaning conflicts. No imported transcript or long dialogue excerpt is placed into runtime statements.

## Runtime and memory constraints

- Zero/missing/hidden observations remain unknown. The guarded Nix zero route still requires independently established presence.
- Revealed journal aliases resolve exact native path and class; no guessed journal hashes.
- Rules are private/phone scoped to actual involved characters. Body-route disclosure requires an authored V receipt. There is no wildcard party knowledge.
- The stable flag describes historical events; it is not permission to reuse a stale snapshot or carry them across save branches.
- Only the coordinator's verified user/playthrough/branch/checkpoint identity can promote selected stable outcomes to memory candidates. A common Convai account/session ID is insufficient.
- Successful source checks are not live acceptance. Mod overlays, another game version, unobserved state, unresolved journal paths, missing disclosure receipts and contradictory outcomes must fail closed.

## Validation

Read-only validation completed for this exact pack:

```text
review_native_rules verify: ok; 29 rules; 29 evidence; 41 native files
verifyNativeEvidence: errors=[]; 777 pointers; 129 narrative outcomes
28 outcomes mapped; 101 outcomes unmapped
```

The second check imported the compiler's verifier, used the winning base/scene/localization inventories, compared actual binary hashes and all native pointers/types/values, and checked narrative links against this lane's quest map. It did not run the compiler's generated-file/apply entry point. The independent semantic review confirmed all 29 rules, including the final body-instruction, Wilson, Jesse and Dennis additions, with no semantic blocker found. A final wording audit narrowed the Razor victory statement to the result itself: the success state precedes Fred's announcement, so the rule does not claim the announcement has already occurred.

## Complete narrative outcome gap matrix

“Mapped” means an executable rule exists in this lane; it does not mean it is true for any current save. Other lanes may independently cover related events under their own narrative keys.

| Decision | Mapped outcomes | Remaining outcomes | Limit or proof still required |
| --- | --- | --- | --- |
| `heywood.origin.nomad-partnership` | — | `completed` | Lifepath and common quest completion do not establish all optional partnership dialogue; no native receipt authored here. |
| `heywood.pepe.debt-help` | — | `attempted` | Separate Pepe's debt request/attempt from the Jackie encounter; exact conversation receipts remain unverified here. |
| `heywood.origin.streetkid-partnership` | — | `completed` | Separate Pepe's debt request/attempt from the Jackie encounter; exact conversation receipts remain unverified here. |
| `heywood.origin.corpo-support` | — | `completed` | Existing friendship, dismissal and support require their own event and disclosure receipts. |
| `heywood.jackie.early-partnership` | — | `established` | Shared quest progress is not evidence of each individual's conscious witnessing or exact handoff. |
| `heywood.rescue.sandra` | — | `handed-to-trauma-team` | Shared quest progress is not evidence of each individual's conscious witnessing or exact handoff. |
| `heywood.vik.debt-at-install` | — | `on-credit`, `paid-upfront` | Upfront payment versus credit and Jackie's Dexter conversation require distinct native choice receipts. |
| `heywood.jackie.dex-introduction` | — | `discussed` | Upfront payment versus credit and Jackie's Dexter conversation require distinct native choice receipts. |
| `heywood.jackie.konpeki-witness` | — | `witnessed` | No individual witnessed-heist receipt authored in this lane; a spawned Jackie copy does not establish it. |
| `heywood.jackie.death` | — | `reported-to-family` | Funeral availability is not the exact family-notification conversation receipt. |
| `heywood.jackie.body-instruction` | `family`, `wait`, `viktor` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.jackie.body-disposition` | — | `family-received`, `clinic-seized` | Cab destination instruction is not delivery or Arasaka seizure. Need the actual family/clinic receipt and a role-appropriate disclosure. |
| `heywood.heroes.funeral` | `full-ofrenda` | `package-only` | Package-only receipt has not been semantically verified; full-ofrenda has its own positive completed ceremony objective. |
| `heywood.heroes.misty-attendance` | — | `attended`, `not-invited` | sq018_03a_misty_invited proves invitation; attendance and a negative not-invited receipt need separate positive evidence. Missing/zero invitation is not refusal. |
| `heywood.heroes.reconciliation` | `encouraged` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.heroes.offering` | `book`, `basketball`, `tequila`, `belt` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.heroes.motorcycle` | `accepted` | `declined` | Only in-person acceptance after completed ofrenda is mapped. Decline and package acquisition need distinct receipts. |
| `heywood.vik.relic-diagnosis` | — | `explained` | Diagnosis, home care and V recounting final moments are separate disclosures, not one completion fact. |
| `heywood.misty.home-care` | — | `delivered` | Diagnosis, home care and V recounting final moments are separate disclosures, not one completion fact. |
| `heywood.misty.jackie-disclosure` | — | `v-recounted-final-moments` | Diagnosis, home care and V recounting final moments are separate disclosures, not one completion fact. |
| `heywood.vik.debt-repayment` | — | `paid` | Debt repayment receipt is not yet native-mapped in this lane. |
| `heywood.tarot.misty-consultation` | — | `discussed` | Collection, reading, consultation and reward acquisition must remain separate; no inferred consultation from collection flags. |
| `heywood.tarot.vik-consultation` | — | `discussed` | Collection, reading, consultation and reward acquisition must remain separate; no inferred consultation from collection flags. |
| `heywood.tarot.city-collection` | — | `collected`, `reading-completed` | Collection, reading, consultation and reward acquisition must remain separate; no inferred consultation from collection flags. |
| `heywood.tarot.dreamcatcher` | — | `received` | Collection, reading, consultation and reward acquisition must remain separate; no inferred consultation from collection flags. |
| `heywood.tarot.king-cups` | — | `discovered` | The four discoveries and Misty's final reading need separate revealed objective/scene receipts. |
| `heywood.tarot.king-pentacles` | — | `discovered` | The four discoveries and Misty's final reading need separate revealed objective/scene receipts. |
| `heywood.tarot.king-wands` | — | `discovered` | The four discoveries and Misty's final reading need separate revealed objective/scene receipts. |
| `heywood.tarot.king-swords` | — | `discovered` | The four discoveries and Misty's final reading need separate revealed objective/scene receipts. |
| `heywood.tarot.kings-reading` | — | `completed` | The four discoveries and Misty's final reading need separate revealed objective/scene receipts. |
| `heywood.nocturne.final-triage` | — | `treated` | Treatment, rooftop guidance and chosen sendoff are separate events; no broad ending-completion inference. |
| `heywood.nocturne.rooftop` | — | `guided` | Treatment, rooftop guidance and chosen sendoff are separate events; no broad ending-completion inference. |
| `heywood.nocturne.misty-sendoff` | — | `arasaka-disclosed`, `panam-arrived` | Treatment, rooftop guidance and chosen sendoff are separate events; no broad ending-completion inference. |
| `heywood.tower.vik-call` | — | `connected` | 2029 phone contact, examination and Misty reunion require separate delivered-event receipts. |
| `heywood.tower.vik-exam` | — | `confirmed` | 2029 phone contact, examination and Misty reunion require separate delivered-event receipts. |
| `heywood.tower.misty-reunion` | — | `farewell` | 2029 phone contact, examination and Misty reunion require separate delivered-event receipts. |
| `heywood.vik.upgrade-u` | — | `completed` | Migration-only tutorial completion needs verified objective semantics; level/version alone is insufficient. |
| `heywood.vik.tool-consultation` | — | `advice-sent` | Actual advice message delivery required; merely having Viktor as a contact is insufficient. |
| `heywood.jackie.remains-disclosure` | — | `heard` | Fan transcript labels its remains conversation placement reconstructed/unverified. It cannot determine an exact native disclosure gate. |
| `heywood.jackie.construct-encounter` | — | `damaged-construct`, `necklace` | Construct encounter versus symbolic necklace depends on actual ending scene outcome and character disclosure, not the body instruction alone. |
| `heywood.boxing.training` | — | `won` | Training outcome needs its own selected positive receipt. |
| `heywood.boxing.final-offer` | `accepted` | `rejected` | mq025_offer records hearing the proposal, not rejection. No positive rejection receipt retained. |
| `heywood.boxing.razor-advice` | — | `heard` | mq025_talked_victor is written after a greeting and does not prove the specific Razor weakness advice. |
| `heywood.boxing.final-result` | `victory`, `defeat` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.boxing.final-fixed-loss` | — | `confirmed` | Accepted offer plus eventual loss does not prove intentional throwing. Fred's interpretation must not become V's unobserved motive. |
| `heywood.boxing.kabuki-result` | — | `victory`, `defeat` | Exact bout/rematch result and Fred's actual knowledge channel not reviewed here. |
| `heywood.boxing.arroyo-wager` | — | `cash`, `rifle` | Wager, bout outcome and post-bout hostility are independent; no shared quest-done shortcut. |
| `heywood.boxing.arroyo-result` | — | `victory`, `defeat` | Wager, bout outcome and post-bout hostility are independent; no shared quest-done shortcut. |
| `heywood.boxing.arroyo-aftermath` | — | `hostility`, `departed` | Wager, bout outcome and post-bout hostility are independent; no shared quest-done shortcut. |
| `heywood.boxing.glen-result` | — | `victory`, `defeat` | Victory, four concession alternatives and later family message need individual receipts. |
| `heywood.boxing.glen-concession` | — | `kept-both`, `car-only`, `money-only`, `left-both` | Victory, four concession alternatives and later family message need individual receipts. |
| `heywood.boxing.glen-family-message` | — | `received` | Victory, four concession alternatives and later family message need individual receipts. |
| `heywood.boxing.rancho-resolution` | — | `bout-victory`, `bout-defeat`, `combat-bypass` | Sanctioned bout outcomes must be distinguished from open-combat bypass. |
| `heywood.ozob.nose-disclosure` | — | `explained` | Ozob's nose story is optional; delivery does not imply hearing it. Native receipts not authored here. |
| `heywood.ozob.delivery` | — | `completed` | Ozob's nose story is optional; delivery does not imply hearing it. Native receipts not authored here. |
| `heywood.boxing.pacifica-result` | `v-won-ozob-alive`, `ozob-killed` | `v-lost` | A lost attempt can be followed by a rematch; no durable isolated loss receipt was selected. Win counter also includes grenade destruction. |
| `heywood.fred.aaron-referral` | — | `sent` | Fred's referral and delivered outcome messages require exact message IDs and recipient scope. |
| `heywood.fred.aaron-update` | — | `death-reported`, `help-failed-reported` | Fred's referral and delivered outcome messages require exact message IDs and recipient scope. |
| `heywood.pepe.bar-intervention` | — | `intimidated`, `fought` | Exact intimidated-versus-fought intervention receipts were not authored from the bar scene. |
| `heywood.pepe.investigation` | — | `commissioned` | Need the commission's own received objective/scene receipt rather than inferred access to a later route. |
| `heywood.cynthia.disclosure` | `explained` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.pepe.report` | `supported-marriage` | `advised-separation` | The non-defused aftermath is shared by multiple reports. It cannot identify the particular advised-separation option. |
| `heywood.pepe.marriage-followup` | `reconciled`, `separated` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.cynthia.ncx-help` | — | `provided` | Cynthia's help and memorial are conditional, private outcomes; ambient presence/combat alone is insufficient. |
| `heywood.cynthia.ncx-aftermath` | — | `memorial-visited` | Cynthia's help and memorial are conditional, private outcomes; ambient presence/combat alone is insufficient. |
| `heywood.wilson.pistol` | — | `collected` | A free pistol offer and actual pickup are different; ownership/item collection receipt remains unverified. |
| `heywood.wilson.competition` | — | `participated` | Placing rules already imply participation, but no separate all-results participation receipt is emitted. |
| `heywood.wilson.result` | `first`, `second` | `other` | The below-second route has no selected positive terminal marker. Both placement flags absent is unknown. |
| `heywood.wilson.business-talk` | — | `discussed` | Wilson's optional business conversation can be skipped before the shared completion objective. |
| `heywood.dennis.offer` | `accepted` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.dennis.package` | — | `discovered` | Dennis was not physically at the fridge; any discovery knowledge for him must follow the actual call/disclosure. |
| `heywood.dennis.extraction` | `delivered-alive` | `died-before-delivery` | Only living handoff acknowledgement is enabled. The failure graph needs exact death/cause and Dennis-notification proof. |
| `heywood.dennis.surgeon-story` | — | `heard` | Optional choice38->section37 is skippable. Successful delivery and payment do not establish hearing the admission. |
| `heywood.dennis.reward` | — | `collected` | Quest completion/payment offer does not prove inventory acquisition of the katana. Scene222 item operation needs a collection receipt. |
| `heywood.nix.spellbook-acquisition` | — | `purchased`, `corpo-discount`, `laptop` | Return sale does not identify V's purchase, Corpo discount, or laptop acquisition branch; Nix was not at R3n0's meeting. |
| `heywood.nix.r3n0-discovery` | — | `read` | Reading optional correspondence is distinct from acquiring or selling the tablet. |
| `heywood.nix.spellbook-decryption` | — | `decrypted` | Sale removes both encrypted/decrypted item variants. Sale alone cannot prove decryption. |
| `heywood.nix.spellbook-handoff` | `delivered` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
| `heywood.nix.spellbook-payment` | — | `standard`, `bonus-negotiated` | rude_to_nix also occurs on refusals; it is not a negotiated-bonus marker. No specific payment branch emitted. |
| `heywood.nix.deck-recovery` | — | `recovered` | Nix was not at the dump; deck possession is not shared witness memory. |
| `heywood.nix.deck-decryption` | — | `deferred`, `started` | Start/defer choice needs its own receipt; rescue is separately gated after recovery conversation. |
| `heywood.nix.rescue` | `power-shutdown`, `computer-breach` | `died` | Only recovered survivors are mapped. No rule turns Nix's death into his surviving personal memory. |
| `heywood.nix.maxtac-favor` | — | `requested`, `data-delivered` | Request and delivery of Nix's MaxTac information require the exact favor/message branch. |
| `heywood.jesse.help` | `accepted` | `refused` | The failed quest has other causes. First refusal can return to the choice, so failed/zero values cannot mean the final refusal. |
| `heywood.jesse.transport` | — | `arrived`, `died` | Car-arrival latch can change/reset, and V reaching the trigger alone is not a final safe-delivery receipt. Callback is independently mapped. |
| `heywood.jesse.callback` | `paid` | — | Exact source-backed rules above; runtime observation and audience gates still apply. |
