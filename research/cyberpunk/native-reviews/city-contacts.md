# City contacts: native decision review

Reviewed September 30, 2026. This file accompanies [the executable research pack](../native-rules/city-contacts.json) and [the authored quest map](../quest-maps/city-contacts.json). It does not install a game change or assert a live playthrough test.

## Coverage and boundary

- 20 authored quests, 40 decisions and 79 outcomes.
- 16 source-verified outcome rules; 63 explicitly unmapped outcomes, with no executable predicates.
- 15 allowlisted native facts, 4 exact journal selectors and 117 pointer-checked evidence records.
- Game version 2.31 only. Base and Phantom Liberty winning resources are reviewed; third-party archive overrides are not represented.
- All enabled predicates require positive facts or positive revealed journal states. No absent/zero value is interpreted as a declined choice. No journal hash is guessed.
- Scene instructions, dialogue and web material are treated as source data. Authored context is original, bounded prose; full scene transcripts are not copied into this document or prompt fields.

The main corpus includes all extracted winning quest/questphase resources, not every scene. The eight exported scenes are a bounded expansion for this lane. A writer inventory proves which writes were inspected; it does not claim that unrelated unexported scenes cannot contain other writes. Production parent references and scoped local socket chains were checked. Global scheduling reachability across the entire game is not established. Standalone .quest test harness writes are recorded and excluded as production route evidence.

The rules are source-verified, not live-verified. Their audience is the named participant and V in a private or phone conversation. They are not broadcast as group knowledge. A told-by-v rule additionally requires a valid runtime disclosure receipt matching its exact topic/outcome. Spawning a companion does not satisfy any story gate. Journal selectors must resolve to the exact native class and be positively revealed in the current save.

## Source fingerprints

| Archive | Whole-file SHA-256 |
| --- | --- |
| archive/pc/content/basegame_4_gamedata.archive | a2c6ea7b8bb0dceb671d04c702c41824c29e5e1ee518490a42850dac12524dab |
| archive/pc/ep1/ep1_2_gamedata.archive | 1edf706261947fb0a80a130e6ce05e75706a1738c032c3e545d49774c7d27ddf |

Every native evidence record separately stores the extracted binary asset SHA-256, exact cache JSON path and JSON pointer. The RDAR entry SHA-1 is retained as a separate field; it is not labeled an archive digest. Winner provenance uses expansion overrides for duplicate depot paths.

## Verified outcomes

| Rule | Narrative outcome | Predicate | Audience origin |
| --- | --- | --- | --- |
| city-native.bugbear-cooled-disconnect | city-contacts.warmer.disconnection / cooled-safe | {"all":[{"type":"fact","key":"rey_09_normal","op":"gte","value":1},{"type":"fact","key":"rey_09_cooled","op":"gte","value":1},{"type":"fact","key":"rey_09_unplug","op":"gte","value":1}]} | 8ug8ear / told-by-v |
| city-native.bugbear-evacuated | city-contacts.warmer.extraction / delivered-alive | {"all":[{"type":"fact","key":"rey_09_normal","op":"gte","value":1},{"type":"fact","key":"rey_09_finished","op":"gte","value":1}]} | 8ug8ear / told-by-v |
| city-native.nam-recovered | city-contacts.nam.recovery / recovered | {"type":"fact","key":"jpn_05_nam_endings","op":"gte","value":1} | chang-hoon-nam / participant |
| city-native.iris-car-returned | city-contacts.iris.vehicle / recovered | {"all":[{"type":"fact","key":"ina_06_car_delivered","op":"gte","value":1},{"type":"fact","key":"ina_06_iris_hired","op":"gte","value":1}]} | iris-tanner / participant |
| city-native.iris-safe-arrival | city-contacts.iris.extraction / safe-arrival | {"type":"fact","key":"ina_06_iris_hired","op":"gte","value":1} | iris-tanner / participant |
| city-native.jake-pickup-returned | city-contacts.jake.pickup / returned | {"type":"fact","key":"gle_06_succeed","op":"gte","value":1} | jake-estevez / participant |
| city-native.jake-gift-offered | city-contacts.jake.quadra-gift / jake-invitation | {"all":[{"type":"fact","key":"gle_06_succeed","op":"gte","value":1},{"type":"journal","key":"city.jake.gift-invitation","op":"in","value":["active","succeeded"]}]} | jake-estevez / participant |
| city-native.jake-gift-collected | city-contacts.jake.quadra-gift / jake-gift-claimed | {"all":[{"type":"fact","key":"gle_06_succeed","op":"gte","value":1},{"type":"fact","key":"mq044_done","op":"gte","value":1},{"type":"journal","key":"city.jake.gift-invitation","op":"in","value":["active","succeeded"]},{"type":"journal","key":"city.jake.gift-debrief","op":"in","value":["active","succeeded"]}]} | jake-estevez / participant |
| city-native.lizzy-truth-disclosed | city-contacts.violence.disclosure / truth | {"type":"fact","key":"mq019_05_recording_sent","op":"gte","value":1} | lizzy-wizzy / participant |
| city-native.lizzy-affair-cover | city-contacts.violence.disclosure / affair-cover | {"type":"fact","key":"mq019_05_didnt_tell_lizzy","op":"gte","value":1} | lizzy-wizzy / participant |
| city-native.liam-paid-v | city-contacts.violence.bribe / accepted | {"type":"fact","key":"mq019_04_bribed","op":"gte","value":1} | liam-northom / participant |
| city-native.lizzy-body-disposed | city-contacts.violence.disposal / body-hidden | {"type":"journal","key":"city.lizzy.body-disposal","op":"eq","value":"succeeded"} | lizzy-wizzy / participant |
| city-native.rachel-success-report | city-contacts.rachel.production-result / successful-report | {"type":"fact","key":"sq023_show_is_hit","op":"gte","value":1} | rachel-casich / participant |
| city-native.rachel-failed-report | city-contacts.rachel.production-result / failed-report | {"type":"fact","key":"sq023_show_is_shit","op":"gte","value":1} | rachel-casich / participant |
| city-native.blue-safe-report | city-contacts.blue.protection / safe-debrief | {"type":"journal","key":"city.blue.safe-report","op":"in","value":["active","succeeded"]} | blue-moon / participant |
| city-native.blue-actual-culprit | city-contacts.blue.stalker-neutralization / actual-neutralized | {"type":"fact","key":"mq028_right_target","op":"gte","value":1} | blue-moon / told-by-v |

### city-native.bugbear-cooled-disconnect

Personal-link device chain 91→97→92→94→90 writes unplug; waiter74 and cooled>=1 condition86 True reach normal=1. Cooling scene End_cooled writes cooled=1. Scene actor is explicitly 8ug8ear. No inference from generic completion. Details are admitted only after V explicitly shares them because 8ug8ear was unconscious.

Bounded context: V used coolant before completing the disconnection that released 8ug8ear safely from her netrunning chair. This establishes the treatment she underwent; it does not give her a conscious recollection of being carried afterward.

Evidence: city-native-evidence-004, city-native-evidence-005, city-native-evidence-006, city-native-evidence-007, city-native-evidence-008, city-native-evidence-009, city-native-evidence-010, city-native-evidence-011, city-native-evidence-001, city-native-evidence-002, city-native-evidence-003.

Narrative sources: [city-warmer](https://cyberpunk.fandom.com/wiki/Gig%3A_Getting_Warmer...).

### city-native.bugbear-evacuated

Transport condition87 checks rey_09_target inside rey_09_van; its output succeeds bring_tobias, then the completion delay leads to the main quest Succeeded socket and finished=1. Adds positive safe-disconnection evidence; never uses finished alone as a survival inference. The unconscious journey requires V disclosure before becoming personal knowledge.

Bounded context: After the safe disconnection, V handed the unconscious 8ug8ear to Wakako’s extraction transport. She can acknowledge the rescue but cannot recount the unconscious journey as something she watched.

Evidence: city-native-evidence-013, city-native-evidence-014, city-native-evidence-015, city-native-evidence-016, city-native-evidence-007, city-native-evidence-017, city-native-evidence-018, city-native-evidence-019, city-native-evidence-001, city-native-evidence-012.

Narrative sources: [city-warmer](https://cyberpunk.fandom.com/wiki/Gig%3A_Getting_Warmer...).

### city-native.nam-recovered

Scene section158 explicitly exchanges the rescue acknowledgement and invitation (English screenplay items2817–4097) before node128 increments nam_endings. This is recovery, not proof a vendor transaction occurred.

Bounded context: V brought Chang Hoon Nam out of his trapped netrunning state for Wakako. After recovering, Nam recognized Wakako’s involvement and offered to show V some netrunning techniques.

Evidence: city-native-evidence-021, city-native-evidence-022, city-native-evidence-023, city-native-evidence-024, city-native-evidence-020.

Narrative sources: [city-wakako-favorite](https://www.powerpyx.com/cyberpunk-2077-wakakos-favorite-gig-walkthrough/), [city-nam](https://cyberpunk.fandom.com/wiki/Chang-Hoon_Nam).

### city-native.iris-car-returned

Named hostage-community car entering ina_06_tr_stop_car_garage triggers locked interactions, invulnerability and brake, then delivered +=1 and park_car_in_garage Succeeded. Also requires the independent positive rescue completion. Not vehicle destruction, generic quest done or spawn state.

Bounded context: V returned Iris Tanner’s vehicle to Dakota’s garage. This is the recovered-car outcome, separate from merely bringing Iris to safety.

Evidence: city-native-evidence-028, city-native-evidence-029, city-native-evidence-030, city-native-evidence-031, city-native-evidence-032, city-native-evidence-033, city-native-evidence-034, city-native-evidence-025, city-native-evidence-026, city-native-evidence-027.

Narrative sources: [city-no-fixers](https://cyberpunk.fandom.com/wiki/Gig%3A_No_Fixers).

### city-native.iris-safe-arrival

Both hired +=1 writers are retained: base completion follows phase/quest Succeeded; optional vehicle-reward branch follows completion reward and token cleanup. The failed/abandoned cleanup has iris_gone/left_alone instead. Narrative statement is bounded to rescue, not employment terms.

Bounded context: V got Iris Tanner back to Dakota’s operation after the Wraith captivity. The vehicle recovery remains a separate question.

Evidence: city-native-evidence-035, city-native-evidence-036, city-native-evidence-037, city-native-evidence-038, city-native-evidence-039, city-native-evidence-040, city-native-evidence-033, city-native-evidence-034, city-native-evidence-026, city-native-evidence-027.

Narrative sources: [city-no-fixers](https://cyberpunk.fandom.com/wiki/Gig%3A_No_Fixers).

### city-native.jake-pickup-returned

Release cleanup tests the actual Life’s Work journal Succeeded at node24; only True gives completion reward and succeed=1. Bugfix writes the same fact only after a journal Succeeded gate. Generic finished/complete and kill_all are not used. The mq044.quest occurrence is a standalone harness initializer, not the production main-quest route.

Bounded context: V completed the recovery of Jake Estevez’s pickup for him. This does not establish whether V used stealth or fought at the shop.

Evidence: city-native-evidence-044, city-native-evidence-045, city-native-evidence-046, city-native-evidence-047, city-native-evidence-048, city-native-evidence-049, city-native-evidence-050, city-native-evidence-041, city-native-evidence-042, city-native-evidence-043.

Narrative sources: [city-life-work](https://cyberpunk.fandom.com/wiki/Gig%3A_Life%27s_Work).

### city-native.jake-gift-offered

Main setup distinguishes positive Life’s Work success: True activates Jake’s vehicle message; False activates Muamar’s alternate vehicle_info message. Requires Jake’s exact revealed SMS path. Never infer gift provenance from car ownership.

Bounded context: Jake sent V an invitation to collect the car he set aside as a thank-you. The invitation itself does not mean V has collected it.

Evidence: city-native-evidence-052, city-native-evidence-053, city-native-evidence-054, city-native-evidence-041, city-native-evidence-042, city-native-evidence-043, city-native-evidence-051.

Narrative sources: [city-sex-wheels](https://cyberpunk.fandom.com/wiki/Sex_On_Wheels).

### city-native.jake-gift-collected

Vehicle-specific OnMount plus leaving the garage area succeeds leave_area. Positive prior success chooses Jake’s debrief path; completion then sets done=1 and enables the Quadra. Positive success plus Jake’s exact invitation AND debrief receipts prevent retroactively classifying an earlier alternate acquisition as Jake’s gift.

Bounded context: V collected the Quadra associated with Jake’s thank-you gift. Jake receives the quest’s corresponding debrief message; this is the Jake route, not simply ownership of an identical vehicle.

Evidence: city-native-evidence-057, city-native-evidence-058, city-native-evidence-059, city-native-evidence-060, city-native-evidence-061, city-native-evidence-062, city-native-evidence-063, city-native-evidence-064, city-native-evidence-054, city-native-evidence-041, city-native-evidence-042, city-native-evidence-043, city-native-evidence-055, city-native-evidence-051, city-native-evidence-056.

Narrative sources: [city-sex-wheels](https://cyberpunk.fandom.com/wiki/Sex_On_Wheels).

### city-native.lizzy-truth-disclosed

Holocall records the send_data objective and Lizzy’s reaction before the positive recording_sent increment. This is an actual disclosure receipt in the native story, unlike V-only full_story or software evidence.

Bounded context: V sent Lizzy the recording exposing Liam’s plan to make an engram of her and discussed the danger behind it. Lizzy has received that evidence; this does not establish that any engram was actually produced.

Evidence: city-native-evidence-066, city-native-evidence-067, city-native-evidence-068, city-native-evidence-069, city-native-evidence-070, city-native-evidence-071, city-native-evidence-072, city-native-evidence-065.

Narrative sources: [city-violence-guide](https://video-game-guide-walkthrough.supersoluce.com/solution/cyberpunk-2077-guide-walkthrough/cyberpunk-2077-side-jobs/violence/).

### city-native.lizzy-affair-cover

Choice136 cheating ordinal0 → section159 (English lines2561/2817/3073) → write214. The other option sends evidence. Uses a positive report-specific fact; never infers this branch from recording_sent=0.

Bounded context: V reported to Lizzy that Liam appeared to be having an affair. This is V’s claim, not independent confirmation of an actual affair.

Evidence: city-native-evidence-066, city-native-evidence-074, city-native-evidence-075, city-native-evidence-070, city-native-evidence-071, city-native-evidence-072, city-native-evidence-073.

Narrative sources: [city-violence-guide](https://video-game-guide-walkthrough.supersoluce.com/solution/cyberpunk-2077-guide-walkthrough/cyberpunk-2077-side-jobs/violence/).

### city-native.liam-paid-v

Section128 contains V accepting the money and Liam confirming transfer, followed by exact bribed=1. Bounded to Liam and V, with no private Lizzy disclosure leaked to him.

Bounded context: Liam paid V after V accepted his offer of money during the Riot confrontation. He can remember that agreement; it does not establish what V later told Lizzy.

Evidence: city-native-evidence-077, city-native-evidence-078, city-native-evidence-079, city-native-evidence-080, city-native-evidence-081, city-native-evidence-082, city-native-evidence-076.

Narrative sources: [city-violence-guide](https://video-game-guide-walkthrough.supersoluce.com/solution/cyberpunk-2077-guide-walkthrough/cyberpunk-2077-side-jobs/violence/).

### city-native.lizzy-body-disposed

The disposal phase waits for positive mq019_liam_disposed then CutControl18 directs its objective Succeeded. Walking outside instead sends Failed and disposed_failed=1. Rule uses the exact successful objective, not merely agreeing to help, entering room, or generic mq019_done.

Bounded context: V completed the task of disposing of Liam’s body for Lizzy after the motel death.

Evidence: city-native-evidence-084, city-native-evidence-085, city-native-evidence-086, city-native-evidence-087, city-native-evidence-088, city-native-evidence-083.

Narrative sources: [city-violence-guide](https://video-game-guide-walkthrough.supersoluce.com/solution/cyberpunk-2077-guide-walkthrough/cyberpunk-2077-side-jobs/violence/).

### city-native.rachel-success-report

Two exact writers: Rachel’s voiced favourable call after scene section279, or the rejected-call fallback activating her hit message after doubting<4. Cleanup checks hit==1 for bonus reward. Do not recreate the outcome from a guessed doubt total; consume actual explicit result.

Bounded context: Rachel reported that the Joshua braindance production was a success and offered V a bonus. This is her production assessment, not proof of a particular religious experience or every prior choice.

Evidence: city-native-evidence-091, city-native-evidence-092, city-native-evidence-093, city-native-evidence-094, city-native-evidence-095, city-native-evidence-096, city-native-evidence-097, city-native-evidence-098, city-native-evidence-099, city-native-evidence-089, city-native-evidence-090.

Narrative sources: [city-rachel](https://cyberpunk.fandom.com/wiki/Rachel_Casich).

### city-native.rachel-failed-report

Two exact writers: Rachel’s hostile voiced call after section280, or fallback message on doubting>=4. Cleanup checks this positive result for basic pay. If both hit and shit are ever observed, resolver topic conflict suppresses both.

Bounded context: Rachel blamed V for damaging the Joshua braindance production and reacted angrily. This is her hostile production assessment, not objective evidence about Joshua’s faith.

Evidence: city-native-evidence-102, city-native-evidence-103, city-native-evidence-093, city-native-evidence-094, city-native-evidence-104, city-native-evidence-105, city-native-evidence-106, city-native-evidence-107, city-native-evidence-099, city-native-evidence-100, city-native-evidence-101.

Narrative sources: [city-rachel](https://cyberpunk.fandom.com/wiki/Rachel_Casich).

### city-native.blue-safe-report

Only the exact positive Blue Moon safety SMS qualifies. mq028_done also covers incorrect-target endings; right_target alone can be written at neutralization before final debrief. The false branch sends Red Menace death messages instead. No missing-zero assumption.

Bounded context: Blue Moon survived V’s protection job and later sent V a message saying she was safe and thanking V. This records her reported safety at that time, not an unlimited guarantee about her current life.

Evidence: city-native-evidence-109, city-native-evidence-110, city-native-evidence-111, city-native-evidence-112, city-native-evidence-113, city-native-evidence-108.

Narrative sources: [city-breath](https://www.powerpyx.com/cyberpunk-2077-every-breath-you-take-walkthrough/).

### city-native.blue-actual-culprit

Positive right_target is written only after the Herring_Girl killed/defeated/unconscious condition. It does not prove whether she was killed, whether Blue Moon survived, or whether the name Griselda was learned. A V disclosure receipt is required, because this flag does not establish Blue Moon witnessed the neutralization.

Bounded context: V neutralized the woman who was actually stalking Blue Moon. This does not establish whether she was killed or whether Blue Moon witnessed it. Blue Moon may discuss V’s account after V shares it.

Evidence: city-native-evidence-115, city-native-evidence-116, city-native-evidence-112, city-native-evidence-117, city-native-evidence-114.

Narrative sources: [city-breath](https://www.powerpyx.com/cyberpunk-2077-every-breath-you-take-walkthrough/), [city-stalker](https://www.gosunoob.com/cyberpunk-2077/every-breath-you-take-find-the-stalker/).

## Critical interpretations

1. **8ug8ear was unconscious.** Safe coolant/disconnection and extraction are distinct positive paths. Being carried is not a conscious first-person recollection. An unreviewed death marker cannot identify unsafe disconnection as the cause.
2. **Nam recovery is not a later vendor purchase.** The accepted marker follows his recovery conversation. The later Phantom Liberty intrusion and aphasia are separate, unmapped choices.
3. **Iris rescue and vehicle retrieval are separate.** The car predicate requires the named car reaching the garage. The rescue predicate follows successful completion; its internal hired name is not interpreted as employment terms.
4. **Jake gift provenance is not vehicle ownership.** Life's Work success is guarded by its successful journal result; its generic finished/complete markers also service failure cleanup. The Quadra invitation and collection are separate topics so both can coexist. The alternate Muamar route is not inferred from a zero success flag.
5. **The actor named Stalker is misleading.** In the Blue Moon park scene, mq028_stalker_killed belongs to a different community actor. The actual threat is the Herring_Girl entry. Its neutralization condition accepts killed, defeated or unconscious, so right_target does not decide lethal versus nonlethal. It also does not prove Blue Moon saw the event or learned the culprit's legal name.
6. **Blue Moon completion is not survival.** An incorrect accusation can still lead to completion and a later death report. Only her exact positive safety SMS is admitted for the safe-debrief outcome. It establishes a report at that time, not permanent immunity or current actor existence.
7. **Lizzy knowledge follows disclosure.** V-only full_story is not fed to her. The true and affair-cover reports use their explicit positive scene writes and share a conflict topic. The affair report remains V's claim, never confirmation of an actual affair.
8. **Liam knows his payment, not Lizzy's later conversations.** His private payment receipt is bounded to Liam and V. Neither an engram plan nor a summoned model proves an engram was made or the story Liam survived.
9. **Disposed is not merely agreed.** Lizzy's exact disposal objective must have succeeded. Walking away can fail it after agreement, so that failure does not prove an explicit refusal.
10. **Rachel's assessment is not reconstructed from doubt counts.** Both voiced and rejected-call message paths explicitly write successful or failed production reports. The result does not identify V's individual religious comments or execution role. Contradictory positive reports suppress their shared topic.
11. **Tiny cameos stay bounded.** Jim, Life Coach, R3n0, Sergei, Bana and Shank retain researched narrative dossiers but no unproven native rule. In particular, Bana's impersonation and death cannot become memories of a living summoned copy.

## Journal selectors

| Stable alias | Native path | Class | Required positive state |
| --- | --- | --- | --- |
| city.jake.gift-invitation | contacts/jake_estevez/mq044/vehicle | gameJournalPhoneMessage | ["active","succeeded"]; ["active","succeeded"] |
| city.jake.gift-debrief | contacts/jake_estevez/mq044/debrief | gameJournalPhoneMessage | ["active","succeeded"] |
| city.lizzy.body-disposal | quests/minor_quest/mq019_paparazzi/06_finale/04_move_body | gameJournalQuestObjective | "succeeded" |
| city.blue.safe-report | contacts/blue_moon/mq028_thanks/mq028_thanks_02_safe | gameJournalPhoneMessage | ["active","succeeded"] |

Lookup uses GetEntryByString for the exact path/class. The collector retains the observed native hash as capture evidence. The alias is a reviewed selector key, not a fabricated game hash. The source path alone never establishes a revealed journal state.

## Unmapped outcomes

Each row is explicitly non-executable. Narrative research remains available without pretending these choices can already be selected from a save.

| Decision / outcome | Remaining proof |
| --- | --- |
| city-contacts.warmer.disconnection / fatal-disconnection | The unsafe-route death marker can also be written for other harm. The exported graph proves the safe branch, but an ordered positive unsafe-disconnect path and unambiguous failed outcome still need review. Generic death or missing cooling values are insufficient. |
| city-contacts.nam.recovery / vendor-established | Recovery dialogue is verified, but later quickhack-vendor availability and an observed vendor transaction are separate states. No reviewed vendor-state selector has been authored. |
| city-contacts.nam.maxtac-job / engaged | The Phantom Liberty recruitment, completed MaxTac intrusion and resulting aphasia require the exact q305 conversation and follow-up disclosures. Earlier rescue and a netrunner contact do not prove this later employment or injury. |
| city-contacts.nam.maxtac-job / data-delivered-injured | The Phantom Liberty recruitment, completed MaxTac intrusion and resulting aphasia require the exact q305 conversation and follow-up disclosures. Earlier rescue and a netrunner contact do not prove this later employment or injury. |
| city-contacts.nam.maxtac-job / departure-discussed | The Phantom Liberty recruitment, completed MaxTac intrusion and resulting aphasia require the exact q305 conversation and follow-up disclosures. Earlier rescue and a netrunner contact do not prove this later employment or injury. |
| city-contacts.iris.vehicle / left-behind | The positive car-delivery branch is reviewed. Absence of that marker cannot establish the optional vehicle was left behind; a successful rescue plus positive omitted-vehicle branch still requires a separate reviewed predicate. |
| city-contacts.jake.shop-violence / violent-approach | Shop hostility/kill cleanup does not prove V chose an attack or who witnessed it. The participant-specific combat/recognition scene and disclosure boundary have not been fully reviewed. |
| city-contacts.jake.quadra-gift / alternate-acquisition | The alternate Muamar message route is visible in the graph, but a zero prior-success read is not admissible proof. Need its exact positively revealed message and acquisition outcome, with a disclosure receipt before Jake knows V used that route. |
| city-contacts.blue.band-resolution / reconciled | The Kerry/Us Cracks confrontation belongs to the sq017 relationship arc. The two band resolutions are authored from narrative evidence but their exact decision scenes have not been verified in this lane. |
| city-contacts.blue.band-resolution / coerced | The Kerry/Us Cracks confrontation belongs to the sq017 relationship arc. The two band resolutions are authored from narrative evidence but their exact decision scenes have not been verified in this lane. |
| city-contacts.blue.stalker-identification / griselda-confirmed | Actual neutralization is separately mapped without a legal name. Neither that marker nor generic completion proves V learned Griselda or Green Cloud as an identity. Correct identifying evidence and wrong-person accusation require their exact playable disclosure scenes; debug-adjacent wrong-target wiring needs further review. |
| city-contacts.blue.stalker-identification / wrong-person-reported | Actual neutralization is separately mapped without a legal name. Neither that marker nor generic completion proves V learned Griselda or Green Cloud as an identity. Correct identifying evidence and wrong-person accusation require their exact playable disclosure scenes; debug-adjacent wrong-target wiring needs further review. |
| city-contacts.blue.protection / killed-on-route | Generic mq028 completion can follow an incorrect accusation and later death. Each death, abandonment or failure needs its own positive final report and an appropriate living observer; a summoned Blue Moon copy does not establish survival. |
| city-contacts.blue.protection / later-death-reported | Generic mq028 completion can follow an incorrect accusation and later death. Each death, abandonment or failure needs its own positive final report and an appropriate living observer; a summoned Blue Moon copy does not establish survival. |
| city-contacts.blue.protection / operation-abandoned | Generic mq028 completion can follow an incorrect accusation and later death. Each death, abandonment or failure needs its own positive final report and an appropriate living observer; a summoned Blue Moon copy does not establish survival. |
| city-contacts.blue.stalker-disposition / nonlethal | The reviewed right_target predicate accepts killed, defeated OR unconscious. The suggestively named stalker_killed belongs to a different actor. No separate confirmed-culprit lethal/nonlethal predicate has been admitted. |
| city-contacts.blue.stalker-disposition / lethal | The reviewed right_target predicate accepts killed, defeated OR unconscious. The suggestively named stalker_killed belongs to a different actor. No separate confirmed-culprit lethal/nonlethal predicate has been admitted. |
| city-contacts.violence.evidence / copy-plot-heard | The full_story scene fact identifies information V learned, not information Lizzy learned. The exact evidence-acquisition stage and disclosure audience still need a separate reviewed rule; absence of full_story is not an affair conclusion. |
| city-contacts.violence.evidence / affair-assumed | The full_story scene fact identifies information V learned, not information Lizzy learned. The exact evidence-acquisition stage and disclosure audience still need a separate reviewed rule; absence of full_story is not an affair conclusion. |
| city-contacts.violence.bribe / not-accepted | Positive payment acceptance is reviewed. Refusal needs its own explicit choice path; bribed=0 cannot prove a refusal, because V may never have met Liam. |
| city-contacts.violence.motel-death / body-discovered | The motel corpse appearance and first V observation need an exact revealed stage. Generic quest completion or a spawned Liam model does not establish who saw the body or that Liam survived. |
| city-contacts.violence.disposal / help-refused | The failed disposal objective also covers leaving after agreeing to help. It cannot establish the specific refusal choice. Only successful disposal is enabled; the refusal conversation path remains unmapped. |
| city-contacts.violence.public-bd / broadcast-observed | A world TV segment existing or being enabled is not proof the player watched the Frac-Sure Enough report. No positive broadcast-observation receipt is available. |
| city-contacts.lizzy.black-sapphire / cordial | The q303 Black Sapphire encounter, remembered disposal outcome and actual headgear handover need direct scene/event verification. Narrative availability alone is not a verified cordial/rebuffed interaction or item gift. |
| city-contacts.lizzy.black-sapphire / rebuffed | The q303 Black Sapphire encounter, remembered disposal outcome and actual headgear handover need direct scene/event verification. Narrative availability alone is not a verified cordial/rebuffed interaction or item gift. |
| city-contacts.lizzy.black-sapphire / headgear-gift | The q303 Black Sapphire encounter, remembered disposal outcome and actual headgear handover need direct scene/event verification. Narrative availability alone is not a verified cordial/rebuffed interaction or item gift. |
| city-contacts.reno.transaction / paid-asking | The R3n0 sale, Corpo negotiation and coordinate theft require the exact Spellbound scene/payment paths. A quest completion or an owned shard does not distinguish those transactions. |
| city-contacts.reno.transaction / negotiated-corpo | The R3n0 sale, Corpo negotiation and coordinate theft require the exact Spellbound scene/payment paths. A quest completion or an owned shard does not distinguish those transactions. |
| city-contacts.reno.transaction / coordinates-stolen | The R3n0 sale, Corpo negotiation and coordinate theft require the exact Spellbound scene/payment paths. A quest completion or an owned shard does not distinguish those transactions. |
| city-contacts.reno.fate / incapacitated | Neutralized and killed must remain distinct, including unconscious story actors. No actor-specific post-event death or incapacitation predicate has been reviewed. |
| city-contacts.reno.fate / dead | Neutralized and killed must remain distinct, including unconscious story actors. No actor-specific post-event death or incapacitation predicate has been reviewed. |
| city-contacts.rachel.sinnerman-entry / joined | The opening pursuit and Joshua meeting require explicit join/decline/neutralization paths with Rachel as a verified observer. Later production results cannot reconstruct those individual choices. |
| city-contacts.rachel.sinnerman-entry / joshua-neutralized | The opening pursuit and Joshua meeting require explicit join/decline/neutralization paths with Rachel as a verified observer. Later production results cannot reconstruct those individual choices. |
| city-contacts.rachel.sinnerman-entry / left | The opening pursuit and Joshua meeting require explicit join/decline/neutralization paths with Rachel as a verified observer. Later production results cannot reconstruct those individual choices. |
| city-contacts.rachel.buyout / accepted | The offer and accepted/refused dialogue must be proven with the actual payment and departure paths. The cumulative doubt state is not a buyout decision. |
| city-contacts.rachel.buyout / refused | The offer and accepted/refused dialogue must be proven with the actual payment and departure paths. The cumulative doubt state is not a buyout decision. |
| city-contacts.rachel.joshua-influence / supported | Cumulative conviction/doubt counters combine several lines and cannot identify one exact statement or prove Rachel heard it. Individual support/challenge receipts remain unmapped. |
| city-contacts.rachel.joshua-influence / challenged | Cumulative conviction/doubt counters combine several lines and cannot identify one exact statement or prove Rachel heard it. Individual support/challenge receipts remain unmapped. |
| city-contacts.rachel.final-participation / performed | Production success is reviewed separately. It does not establish whether V performed the execution, only observed it, or departed; those exact studio scene choices still need native review. |
| city-contacts.rachel.final-participation / observed | Production success is reviewed separately. It does not establish whether V performed the execution, only observed it, or departed; those exact studio scene choices still need native review. |
| city-contacts.rachel.final-participation / departed | Production success is reviewed separately. It does not establish whether V performed the execution, only observed it, or departed; those exact studio scene choices still need native review. |
| city-contacts.sergei.captive / delivered | The delivery versus release paths in Olive Branch require the named car, captive and resolved objective/scene. A completed gig or vehicle ownership cannot discriminate the choices. |
| city-contacts.sergei.captive / released | The delivery versus release paths in Olive Branch require the named car, captive and resolved objective/scene. A completed gig or vehicle ownership cannot discriminate the choices. |
| city-contacts.sergei.aftermath / sergei-body-found | Encounter availability is not proof V found the relevant body. Both later discoveries require location-specific observed actor/scene evidence, and knowledge must reach a surviving recipient. |
| city-contacts.sergei.aftermath / alex-body-found | Encounter availability is not proof V found the relevant body. Both later discoveries require location-specific observed actor/scene evidence, and knowledge must reach a surviving recipient. |
| city-contacts.jim.race-access / invited | Repeat-race unlock or prior Claire progress is not the actual Jim invitation or V acceptance. The SMS/call entry and chosen response require positive selectors. |
| city-contacts.jim.race-access / accepted | Repeat-race unlock or prior Claire progress is not the actual Jim invitation or V acceptance. The SMS/call entry and chosen response require positive selectors. |
| city-contacts.jim.race-result / won | Repeatable races need a distinct run identity and place at its finish. A cumulative win count or generic race completion cannot identify a particular remembered race. |
| city-contacts.jim.race-result / completed-other-place | Repeatable races need a distinct run identity and place at its finish. A cumulative win count or generic race completion cannot identify a particular remembered race. |
| city-contacts.coach.intro-call / answered | A Corpo lifepath does not prove V answered the AV-flight call. The exact call-played/answered receipt has not been reviewed. |
| city-contacts.bana.identity-reveal / katya-revealed | The museum caller is Katya impersonating the deceased Bana. The exact identity disclosure scene must be selected; a contact entry or summoned Bana model cannot authorize the reveal. |
| city-contacts.bana.katya-fate / spared | The interrogation aftermath must distinguish alive release, incapacitation and confirmed death. No exact actor-specific chosen branch has been reviewed. |
| city-contacts.bana.katya-fate / killed | The interrogation aftermath must distinguish alive release, incapacitation and confirmed death. No exact actor-specific chosen branch has been reviewed. |
| city-contacts.bana.evidence / given-ana | Ana handover, destruction and Steven drop-point delivery need separate resolved transaction/objective evidence. Generic Spy in the Jungle completion does not identify evidence disposition. |
| city-contacts.bana.evidence / destroyed | Ana handover, destruction and Steven drop-point delivery need separate resolved transaction/objective evidence. Generic Spy in the Jungle completion does not identify evidence disposition. |
| city-contacts.bana.evidence / drop-point | Ana handover, destruction and Steven drop-point delivery need separate resolved transaction/objective evidence. Generic Spy in the Jungle completion does not identify evidence disposition. |
| city-contacts.bana.aftermath-report / steven-report | A later Steven encounter existing is not V having heard his account. Needs the played report and disclosure gating; Bana cannot automatically remember posthumous events. |
| city-contacts.shank.tool-treatment / letter-recovery | Tool letter recovery, sister performance and clone performance are mutually distinct scene directions. Do not read theatrical dialogue as literal family/clone origin or infer direction from gig completion. |
| city-contacts.shank.tool-treatment / sister-performance | Tool letter recovery, sister performance and clone performance are mutually distinct scene directions. Do not read theatrical dialogue as literal family/clone origin or infer direction from gig completion. |
| city-contacts.shank.tool-treatment / clone-performance | Tool letter recovery, sister performance and clone performance are mutually distinct scene directions. Do not read theatrical dialogue as literal family/clone origin or infer direction from gig completion. |
| city-contacts.shank.rachel-contact / offer-received | Rachel receiving a lead or an offer being enabled does not prove her actual contact, hostile response or a signed contract. Exact incoming message and its prior-production branch require review. |
| city-contacts.shank.rachel-contact / hostile-contact | Rachel receiving a lead or an offer being enabled does not prove her actual contact, hostile response or a signed contract. Exact incoming message and its prior-production branch require review. |
| city-contacts.jake.recognition / recognized-later | The bounded Stadium Love association is supported narratively, but a shop combat marker alone does not prove the later participant recognized V. Jake was not the participant; require the specific later recognition scene plus disclosure. |

## Native evidence index

The JSON pack contains the complete archive/resource digests, source IDs, types and review notes. Pointers below are relative to the named decoded cache file, not guessed engine addresses.

| Evidence | Cache JSON and exact pointer | Type |
| --- | --- | --- |
| city-native-evidence-001 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_combat.questphase.json#/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/4/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-002 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_combat.questphase.json#/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/2/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-003 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_combat.questphase.json#/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/8/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-004 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_combat.questphase.json#/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/6/Data | questPauseConditionNodeDefinition |
| city-native-evidence-005 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_combat.questphase.json#/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/7/Data | questConditionNodeDefinition |
| city-native-evidence-006 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_combat.questphase.json#/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/11/Data | questInteractiveObjectManagerNodeDefinition |
| city-native-evidence-007 | scene-evidence/city-contacts-extra/raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/scenes/sts_hey_rey_09_04_tobias.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-008 | scene-evidence/city-contacts-extra/raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/scenes/sts_hey_rey_09_04_tobias.scene.json#/Data/RootChunk/sceneGraph/Data/graph/16/Data | scnQuestNode |
| city-native-evidence-009 | raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_japantown.questphase.json#/Data/RootChunk/inplacePhases/7 | untyped value/container |
| city-native-evidence-010 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseResource | untyped value/container |
| city-native-evidence-011 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_vista_del_rey.questphase.json#/Data/RootChunk/inplacePhases/11 | untyped value/container |
| city-native-evidence-012 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/38/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-013 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/11/Data | questPauseConditionNodeDefinition |
| city-native-evidence-014 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/9/Data | questJournalNodeDefinition |
| city-native-evidence-015 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/17/Data | questPauseConditionNodeDefinition |
| city-native-evidence-016 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/10/Data | questJournalNodeDefinition |
| city-native-evidence-017 | raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_japantown.questphase.json#/Data/RootChunk/inplacePhases/18 | untyped value/container |
| city-native-evidence-018 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_rey_09/phases/sts_hey_rey_09.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseResource | untyped value/container |
| city-native-evidence-019 | raw/base/base/open_world/street_stories/heywood/vista_del_rey/sts_hey_vista_del_rey.questphase.json#/Data/RootChunk/inplacePhases/1 | untyped value/container |
| city-native-evidence-020 | scene-evidence/city-contacts/raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_05/scenes/sts_wbr_jpn_05_ren_cheng.scene.json#/Data/RootChunk/sceneGraph/Data/graph/5/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-021 | scene-evidence/city-contacts/raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_05/scenes/sts_wbr_jpn_05_ren_cheng.scene.json#/Data/RootChunk/sceneGraph/Data/graph/8/Data | scnSectionNode |
| city-native-evidence-022 | scene-evidence/city-contacts/raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_05/scenes/sts_wbr_jpn_05_ren_cheng.scene.json#/Data/RootChunk/sceneGraph/Data/graph/5/Data | scnQuestNode |
| city-native-evidence-023 | scene-evidence/city-contacts/raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_05/scenes/sts_wbr_jpn_05_ren_cheng.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-024 | raw/base/base/open_world/street_stories/westbrook/japantown/sts_wbr_jpn_05/phases/sts_wbr_jpn_05_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/sceneFile | untyped value/container |
| city-native-evidence-025 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/12/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-026 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/72/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-027 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/88/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-028 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/21/Data | questPauseConditionNodeDefinition |
| city-native-evidence-029 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/8/Data | questJournalNodeDefinition |
| city-native-evidence-030 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/11/Data | questVehicleNodeDefinition |
| city-native-evidence-031 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/12/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-032 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/19/Data | questJournalNodeDefinition |
| city-native-evidence-033 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseResource | untyped value/container |
| city-native-evidence-034 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json#/Data/RootChunk/inplacePhases/23 | untyped value/container |
| city-native-evidence-035 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/74/Data | questJournalNodeDefinition |
| city-native-evidence-036 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/75/Data | questJournalNodeDefinition |
| city-native-evidence-037 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/72/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-038 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/91/Data | questDeletionMarkerNodeDefinition |
| city-native-evidence-039 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/89/Data | questGameManagerNodeDefinition |
| city-native-evidence-040 | raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/88/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-041 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/30/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-042 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_bugfixing.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/2/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-043 | raw/base/base/quest/minor_quests/mq044/mq044.quest.json#/Data/RootChunk/graph/Data/nodes/3/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-044 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/18/Data | questConditionNodeDefinition |
| city-native-evidence-045 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/5/Data | questRewardManagerNodeDefinition |
| city-native-evidence-046 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_openworld.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/30/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-047 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_bugfixing.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/3/Data | questPauseConditionNodeDefinition |
| city-native-evidence-048 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06_phase.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseResource | untyped value/container |
| city-native-evidence-049 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_gle_06/phase/sts_hey_gle_06.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseResource | untyped value/container |
| city-native-evidence-050 | raw/base/base/open_world/street_stories/heywood/glenn/sts_hey_glenn.questphase.json#/Data/RootChunk/inplacePhases/11 | untyped value/container |
| city-native-evidence-051 | raw/ep1/base/journal/cooked_journal.journal.json#/Data/RootChunk/entry/Data/entries/3/Data/entries/78/Data/entries/1/Data/entries/0/Data | gameJournalPhoneMessage |
| city-native-evidence-052 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/3/Data | questConditionNodeDefinition |
| city-native-evidence-053 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/23/Data | questJournalNodeDefinition |
| city-native-evidence-054 | raw/base/base/quest/minor_quests/mq044/phases/mq044.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/phaseResource | untyped value/container |
| city-native-evidence-055 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/12/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-056 | raw/ep1/base/journal/cooked_journal.journal.json#/Data/RootChunk/entry/Data/entries/3/Data/entries/78/Data/entries/1/Data/entries/1/Data | gameJournalPhoneMessage |
| city-native-evidence-057 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/9/Data | questPauseConditionNodeDefinition |
| city-native-evidence-058 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/10/Data | questJournalNodeDefinition |
| city-native-evidence-059 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/17/Data | questConditionNodeDefinition |
| city-native-evidence-060 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/15/Data | questJournalNodeDefinition |
| city-native-evidence-061 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/11/Data | questJournalNodeDefinition |
| city-native-evidence-062 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/23/Data | questCharacterManagerNodeDefinition |
| city-native-evidence-063 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/12/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-064 | raw/base/base/quest/minor_quests/mq044/phases/mq044_main.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/20/Data | questVehicleNodeDefinition |
| city-native-evidence-065 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/26/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-066 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/14/Data | scnChoiceNode |
| city-native-evidence-067 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/7/Data | scnQuestNode |
| city-native-evidence-068 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/21/Data | scnSectionNode |
| city-native-evidence-069 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/26/Data | scnQuestNode |
| city-native-evidence-070 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-071 | raw/base/base/quest/minor_quests/mq019/phases/mq019_05_holocall.questphase.json#/Data/RootChunk/graph/Data/nodes/5/Data/sceneFile | untyped value/container |
| city-native-evidence-072 | raw/base/base/quest/minor_quests/mq019/phases/mq019_05_holocall.questphase.json#/Data/RootChunk/graph/Data/nodes/11/Data/sceneFile | untyped value/container |
| city-native-evidence-073 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/25/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-074 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/18/Data | scnSectionNode |
| city-native-evidence-075 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_05_holocall.scene.json#/Data/RootChunk/sceneGraph/Data/graph/25/Data | scnQuestNode |
| city-native-evidence-076 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_04_manager.scene.json#/Data/RootChunk/sceneGraph/Data/graph/29/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-077 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_04_manager.scene.json#/Data/RootChunk/sceneGraph/Data/graph/27/Data | scnSectionNode |
| city-native-evidence-078 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_04_manager.scene.json#/Data/RootChunk/sceneGraph/Data/graph/29/Data | scnQuestNode |
| city-native-evidence-079 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_04_manager.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-080 | raw/base/base/quest/minor_quests/mq019/phases/mq019_03_night_club.questphase.json#/Data/RootChunk/graph/Data/nodes/10/Data/sceneFile | untyped value/container |
| city-native-evidence-081 | raw/base/base/quest/minor_quests/mq019/phases/mq019_03_night_club.questphase.json#/Data/RootChunk/graph/Data/nodes/15/Data/phaseGraph/Data/nodes/7/Data/sceneFile | untyped value/container |
| city-native-evidence-082 | raw/base/base/quest/minor_quests/mq019/phases/mq019_03_night_club.questphase.json#/Data/RootChunk/graph/Data/nodes/17/Data/phaseGraph/Data/nodes/2/Data/sceneFile | untyped value/container |
| city-native-evidence-083 | raw/ep1/base/journal/cooked_journal.journal.json#/Data/RootChunk/entry/Data/entries/0/Data/entries/4/Data/entries/53/Data/entries/4/Data/entries/3/Data | gameJournalQuestObjective |
| city-native-evidence-084 | raw/base/base/quest/minor_quests/mq019/phases/mq019_06_finale.questphase.json#/Data/RootChunk/graph/Data/nodes/12/Data/phaseGraph/Data/nodes/3/Data | questPauseConditionNodeDefinition |
| city-native-evidence-085 | raw/base/base/quest/minor_quests/mq019/phases/mq019_06_finale.questphase.json#/Data/RootChunk/graph/Data/nodes/12/Data/phaseGraph/Data/nodes/6/Data | questCutControlNodeDefinition |
| city-native-evidence-086 | raw/base/base/quest/minor_quests/mq019/phases/mq019_06_finale.questphase.json#/Data/RootChunk/graph/Data/nodes/12/Data/phaseGraph/Data/nodes/2/Data | questJournalNodeDefinition |
| city-native-evidence-087 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq019/scenes/mq019_06_finale.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-088 | raw/base/base/quest/minor_quests/mq019/mq019_paparazzi.questphase.json#/Data/RootChunk/graph/Data/nodes/7/Data/phaseResource | untyped value/container |
| city-native-evidence-089 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/14/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-090 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/sceneGraph/Data/graph/54/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-091 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/sceneGraph/Data/graph/52/Data | scnSectionNode |
| city-native-evidence-092 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/sceneGraph/Data/graph/54/Data | scnQuestNode |
| city-native-evidence-093 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-094 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/11/Data | questConditionNodeDefinition |
| city-native-evidence-095 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/12/Data | questJournalNodeDefinition |
| city-native-evidence-096 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/14/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-097 | raw/base/base/quest/side_quests/sq023/phases/sq023_cleanup_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/4/Data | questConditionNodeDefinition |
| city-native-evidence-098 | raw/base/base/quest/side_quests/sq023/phases/sq023_cleanup_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/5/Data | questRewardManagerNodeDefinition |
| city-native-evidence-099 | raw/base/base/quest/side_quests/sq023/sq023.questphase.json#/Data/RootChunk/graph/Data/nodes/10/Data/phaseResource | untyped value/container |
| city-native-evidence-100 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/15/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-101 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/sceneGraph/Data/graph/55/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-102 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/sceneGraph/Data/graph/53/Data | scnSectionNode |
| city-native-evidence-103 | scene-evidence/city-contacts-extra/raw/base/base/quest/side_quests/sq023/scenes/sq023_03_call.scene.json#/Data/RootChunk/sceneGraph/Data/graph/55/Data | scnQuestNode |
| city-native-evidence-104 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/13/Data | questJournalNodeDefinition |
| city-native-evidence-105 | raw/base/base/quest/side_quests/sq023/phases/sq023_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/15/Data | questFactsDBManagerNodeDefinition |
| city-native-evidence-106 | raw/base/base/quest/side_quests/sq023/phases/sq023_cleanup_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/6/Data | questConditionNodeDefinition |
| city-native-evidence-107 | raw/base/base/quest/side_quests/sq023/phases/sq023_cleanup_aftermath.questphase.json#/Data/RootChunk/graph/Data/nodes/7/Data | questRewardManagerNodeDefinition |
| city-native-evidence-108 | raw/ep1/base/journal/cooked_journal.journal.json#/Data/RootChunk/entry/Data/entries/3/Data/entries/122/Data/entries/0/Data/entries/1/Data | gameJournalPhoneMessage |
| city-native-evidence-109 | raw/base/base/quest/minor_quests/mq028/phases/mq028_finished.questphase.json#/Data/RootChunk/graph/Data/nodes/3/Data | questConditionNodeDefinition |
| city-native-evidence-110 | raw/base/base/quest/minor_quests/mq028/phases/mq028_finished.questphase.json#/Data/RootChunk/graph/Data/nodes/5/Data | questJournalNodeDefinition |
| city-native-evidence-111 | raw/base/base/quest/minor_quests/mq028/phases/mq028_finished.questphase.json#/Data/RootChunk/graph/Data/nodes/7/Data | questJournalNodeDefinition |
| city-native-evidence-112 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq028/scenes/mq028_02_park.scene.json#/Data/RootChunk/actors | untyped value/container |
| city-native-evidence-113 | raw/base/base/quest/persistent_content.questphase.json#/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/7/Data/phaseResource | untyped value/container |
| city-native-evidence-114 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq028/scenes/mq028_02_park.scene.json#/Data/RootChunk/sceneGraph/Data/graph/297/Data/questNode/Data/type/Data | questSetVar_NodeType |
| city-native-evidence-115 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq028/scenes/mq028_02_park.scene.json#/Data/RootChunk/sceneGraph/Data/graph/35/Data | scnQuestNode |
| city-native-evidence-116 | scene-evidence/city-contacts/raw/base/base/quest/minor_quests/mq028/scenes/mq028_02_park.scene.json#/Data/RootChunk/sceneGraph/Data/graph/297/Data | scnQuestNode |
| city-native-evidence-117 | raw/base/base/quest/minor_quests/mq028/phases/mq028_02_park.questphase.json#/Data/RootChunk/graph/Data/nodes/2/Data/sceneFile | untyped value/container |

## Validation performed

- Parsed every authored native reference and verified its exact JSON pointer exists. Type names, when available, are read from the actual object.
- Resolved every source-verified and unmapped rule to the exact authored decision/outcome.
- Checked every authored outcome has exactly one coverage record.
- Checked the pack with bridge/world-knowledge.mjs validateKnowledgePack.
- No live branch save was loaded, no quest fact was changed, and no game installation was modified for this research. Archive pointers establish native source evidence; live acceptance remains separate.

## Structural and localization cross-check

The game-root reference closure was compared against all 35 cited native assets. Every enabled quest phase has a rooted structural anchor; all seven scene files actually used by executable rules are referenced from rooted phases. The eighth exported resolution scene was inspected but is not a rule dependency. The standalone mq044.quest initialization is retained only for the writer audit. An older Life's Work wrapper outside the root closure is a local reference, not an independent production anchor. The cooked journal is data rather than a scheduled phase. These checks establish structural reference provenance, not runtime execution of every socket or scheduling branch. The pack records the per-source classification.

Installed English subtitle joins were checked for the eight exported scenes. The city batch has five non-identical manager-scene variants (tense, interjection, spelling and punctuation) and four null-filled Blue Moon choice labels with no subtitle match. They do not change the bounded rule meanings. Installed display text is preferred wherever wording differs; the blank Blue Moon labels are not used as evidence. The extra batch's 8ug8ear and Rachel result scenes match the installed English subtitle payloads. No long transcript is copied into an authored context field.

## Resolver checks

Twelve focused synthetic cases passed: alternate-car temporal contamination; complete Jake invitation/debrief provenance; hidden journal rejection; Lizzy cover-report secrecy; contradictory Lizzy disclosures; Blue Moon disclosure requirement; no legal-name leakage from neutralization; no unconscious rescue recollection; no witnessed-by claim from a told rescue; Iris rescue/vehicle separation; contradictory Rachel assessments; and unknown-version rejection. These exercise the actual pure resolver with this pack. They are not live gameplay acceptance.

The compiler's exported evidence verifier also returned zero errors for all 117 native pointers across 35 binary-hash-checked assets and all 79 narrative outcome links. No shared generated pack or production code was written by these checks.
