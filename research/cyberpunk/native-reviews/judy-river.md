# Judy / River lane: native mapping review

Reviewed 2026-09-30 against the installed Cyberpunk 2077 **2.31** assets.

## Qualification and scope

This pack is **source verified, not live verified**. It interprets positive fact reads and one revealed native phone message. It does not establish that this save contains those observations, nor that any character currently survives or has been summoned. No game state, cloud character or Convai memory was changed.

The narrative research covers 9 individual dossiers, 32 public quest keys, 67 decisions and 132 outcomes. This native pack currently enables **16 specific outcomes**, using **22 fact names** and **1 journal alias**. Other outcomes retain their explicit unmapped status in the research layer. Native rules from other packs, including the reviewed Judy Pyramid Song romance/friendship rules, can augment this coverage.

All enabled conditions require a positive known fact or a revealed journal entry. No absent/zero fact is interpreted as a declined choice or survival. Every executable rule has exact native JSON pointers, asset SHA-256 values, story sources and exact narrative decision/outcome links.

## Enabled outcomes

| Rule suffix | Narrative outcome | Runtime evidence | Meaning / audience limit |
| --- | --- | --- | --- |
| dream-truth | dream.jefferson-disclosure / truth | truth_hurts >= 1 + sq006_done >= 1 | Jefferson heard the mind-alteration disclosure; mastermind remains unknown. |
| dream-cover-story | dream.jefferson-disclosure / cover-story | fake_just_as_good >= 1 + sq006_done >= 1 | Jefferson received the Holt/SSI explanation. Private concealed findings are not given to him. |
| hunt-randy-saved | hunt.rescue / saved | sq021_randy_saved = 1 + sq021_done = 1 | Randy survived; River participated in the rescue. |
| hunt-randy-too-late | hunt.rescue / too-late | sq021_randy_kaputt = 1 + sq021_done = 1 | The wrong-farm route reached Randy too late; no Harris revenge outcome is inferred. |
| river-relationship-committed | following.relationship / committed | sq029_river_lover = 1 + sq029_done = 1 | Historical morning commitment; later relationship state remains separate. |
| sandra-admitted-reading | disclosure.reading / read | mq024_admit_that_looked >= 1 + mq024_done = 1 | Sandra knows V inspected her databank. Does not select a later trust response. |
| sandra-blackmail | disclosure.response / blackmail | mq024_combat_sandra = 1 + mq024_done = 1 | Threat of exposure for money provoked hostility; Sandra's death is not implied. |
| ana-heard-revelation | spy.revelation / revelation | ana_gave_kill_order = 1 + sts_ep1_08_done = 1 | Ana heard Katya's account and gave an order; neither truth of the account nor obedience is inferred. |
| ana-monitor-delivered | spy.biomonitor / delivered-to-ana | biomonitor_ana = 1 + sts_ep1_08_done = 1 | Monitor left with Ana. Later public outcome/imprisonment remains unknown. |
| pisces-maiko-installed | pisces.control / maiko-installed | sq026_side_maiko = 1 + sq026_04_done = 1 | Maiko arrangement and Judy's completed debrief; permanent freedom is not claimed. |
| pisces-payment-accepted | pisces.payment / accepted | sq026_13_maiko_money = 1 + sq026_04_done = 1 | Judy learned V took the money and withdrew in anger. |
| pisces-maiko-killed | pisces.maiko-fate / killed | sq026_maiko_dead = 1 + sq026_side_judy = 1 + sq026_04_done = 1 | Actual death-only predicate and Judy debrief. Death is separate from the payment choice. |
| claire-race-first-promise | santo.promise / race-first | sq024_claire_spares_sampson >= 1 | Earlier refusal to promise execution, not the final survival result. |
| claire-sampson-spared | beast.sampson-fate / spared | revealed Sampson thanks message | Positive post-confrontation survival receipt; Claire knows her own earlier action. |
| claire-cthulhu-offer | beast.cthulhu-gift / cthulhu-promised | same revealed message + exact told-by-v receipt | Claire receives the private car-offer detail only after V tells her. |
| claire-sampson-dead | beast.sampson-fate / killed | sq024_sampson_dead = 1 + sq024_done = 1 | Resolved confrontation death; does not claim V saw the shot or chose a specific line. |

Full identifiers have the jr-native. prefix. Narrative decision IDs have judy-river. prefix. Short fact names in this table refer to the exact names in the JSON allowlist.

## Exact branch review

### Peralez

The release root starts persistent phase 82, whose sidequest phase includes sq006. Its normal graph flows through apartment, lab/chase, clandestine and conclusion; the failure route leaves separately. Conclusion's final-meeting output reaches the succeeded quest journal and done writer.

In sq006_07a_final_choice.scene, choice node88 option0 joins the English brainwashing disclosure and writes truth_hurts at node167. Option1 selects the withholding dialogue and writes fake_just_as_good at node4816. The scene binds Jefferson as actor0 and V as player actor3. The two positive outcomes share a mutually exclusive topic; conflicting observations suppress both.

No rule identifies the controller, alleges Night Corp or Mr. Blue Eyes as established masterminds, or gives Elizabeth's private request to Jefferson. Elizabeth's own clandestine scene was inspected but no additional durable positive disclosure flag has been qualified.

### River and Randy

sq021_11_finale.scene's release interaction reaches condition741. The game's bad-farm positive branch writes randy_kaputt; its other scene branch writes randy_saved. The pack observes these positive result writes, rather than executing a zero bad-farm inference itself.

The main quest's cleanup also writes sq021_done and has a separate saved writer and Randy-survival phone message. Both positive result flags are treated as conflicting if simultaneously present; nothing selects an arbitrary winner.

For commitment, sq029_05_morning_after.scene choice24 option0 joins the affirmative kiss answer, then V/River's agreement section25 and river_lover writer28. The engine's wait on V's drinking state is graph flow, not an authored world predicate. Specific sq029 cleanup supplies done.

sq021_sobchak_friend is not a safe refusal detector: friendship is also written by the earlier rescue success and by different morning answers. Neither friendship nor absent river_lover is used to invent a declined romance. The sex milestone and later commitment are compatible history, so neither should be treated as the other's negative.

### Sandra

The apartment phase enters mq024_02_meet_sandra.scene at Start0. Choice12's admission answer increments mq024_admit_that_looked; cleanup assigns done. Reachable EP1 history initialization also sets admission and completion. Accordingly, the rule reports save-established acknowledgement, not that the human selected that answer during this session.

Blackmail is traced from the Night Corp leak threat through choice94's request for silence payment, section93 and combat_sandra writer416. It is an armed hostility event, not a death detector.

The installed subtitle corpus differs from older inline scene text at 25 Sandra descriptors. The relevant blackmail text was checked against installed entries49/50/51/28. The two substantive differences elsewhere concern a question about mind conditioning and an AGI remark; neither is used to inflate these rules into detailed technical knowledge.

### Ana / Katya

The production phase enters the target scene's Meeting input. Section1068 binds Katya actor0, Ana actor2 and V actor4. Ana interrupts Katya's account with an execution order, then node1421 writes the exact positive order flag. The account is retained as Katya's allegation, not independently verified truth.

The return scene's explicit handover branch removes the monitor from V, injects it into Ana's client community and writes biomonitor_ana at node652. Leave/timeout sections also remove the monitor and write the same outcome at node649. The shared consequence is that Ana received the evidence, not that V necessarily selected the explicit handover option.

The order/revelation is historical and compatible with later Katya outcomes. The narrative and native mappings use a separate ana.katya-revelation-and-order topic; Katya's later fate stays separate. Claire's Beast gift and Sampson's Cthulhu offer are also separate narrative decisions and native topics.

### Judy / Clouds

Penthouse choices are not automatically Judy's knowledge. The pack requires specific Pisces completion after sq026_15_end.scene, where Judy actually discusses the outcome with V.

Maiko management follows the two recommendation sections into the Tyger bosses' acceptance and side_maiko writer285. The debrief's maiko entry challenges V about supporting Maiko.

Payment is a distinct branch: accepting Maiko's offer reaches writer367. Judy's debrief has explicit positive money comparisons selecting her accusation and rejection. Declining money cannot be inferred from a missing payment flag.

The main penthouse predicate for sq026_maiko_dead targets #maiko with killed=1, unconscious=0 and defeated=0. This is separate from a combat-completion predicate accepting unconscious/defeated. In the Judy debrief, its positive branch selects her shock at Maiko's death. Nonlethal and survived outcomes remain unmapped, because dead=0 is not sufficient.

The side_judy flag is set before combat; by itself it does not prove every boss died, that all workers survived, or that Clouds remained independent. No such claims are enabled from that flag.

Choice466 and its follow-up choice472 separate the Maiko-management resolution from the collective/opposition combat resolution. Management and its accepted-payment facet can coexist. The Maiko-death rule also requires the opposition flag, so a cross-topic resolution group suppresses all three rules if contradictory management and opposition/death observations appear together.

### Claire / Sampson

The Santo Domingo scene positively records V's race-first boundary after either the original choice or reconsidering withdrawal. The misleadingly named claire_spares_sampson flag is written here, before the final race, so it qualifies only that agreement.

Actual spared qualification uses a **revealed** phone message:
contacts/sampson/sq024_giving_car/00_sampson_thanks, gameJournalPhoneMessage.
Cooked journal LocKey#14333 joins installed onscreen entry10228, which thanks V for stopping Claire and offers the repaired car. The production graph reaches this message after the crash/alive result, Claire follow-up and native time delays. Runtime does not interpret the native zero death branch; it requires the resulting revealed message.

The gift and original mercy are compatible facets. The car-offer topic is distinct and told-by-v gated, since Claire did not receive V's private SMS. The shared final-fate exclusive group suppresses the gift as well as the spared rule if a contradictory death result is also true.

The death flag has three reviewed writers: direct scene execution and two native leave-area consequence routes. Therefore the rule describes the resolved confrontation death, without asserting a witnessed shot or V's exact final response. The native death rule and positive survival receipt share a conflict topic.

## Important unmapped outcomes and why

- **Katya actually killed:** the writer of sts_ep1_08_katya_killed follows a predicate with killed=1, defeated=1, unconscious=1. Its name is not death proof.
- **Katya spared / private bargain:** the found blueline writers include a fake input explicitly retaining old lines. They are not qualified as reachable production outcomes. The stash-info flag is written during a proposal, not guaranteed final mercy. Ana's hologram disconnects before V's private resolution.
- **Ana hotel destruction vs Steven drop point:** biomonitor_destroyed is also written on Steven's alternative drop route. A positive value does not distinguish the two narrative outcomes. Ana cannot automatically know the private bargain.
- **Ana delayed punishment:** the actual delayed message receipt and perspective still need a reviewed native rule.
- **Sandra unread, lied, respectful, runner rapport, survival:** branch dialogue exists but no complete positive durable outcome gate has been qualified. Rewards/hostility cannot substitute for the exact trust state or life state.
- **River declined, friendship-only, rejection, Harris revenge, abandonment, Joss-specific knowledge:** available flags overlap stages or require additional exact recipient/aftermath proof.
- **Judy Maiko refusal, nonlethal survival, bosses removed, later Clouds retaliation, Evelyn rescue/death:** remain researched conditional narrative, not native-enabled by this pack. Maiko death and early side-choice flags must not be stretched to cover them.
- **Claire race placement:** original and repeatable races share/reset some flags. These cannot establish a permanent original-race result without a specific final journal gate.
- **Claire revenge/withdrawal, finishing instead of chase, Beast gift:** early promise and broad pissed/done flags do not uniquely establish the requested branch or actual vehicle award. Cthulhu purchase alone must not imply mercy.
- **Ending and apartment-visit overlays:** Judy/River ending consequences are researched with canonical quest keys but remain native-unmapped here until the exact partner call, ending route and conversation receipt are verified. Generic ending availability is not a played ending.
- **Other knowledge:** no rule turns a global quest fact into every companion's knowledge. Groups are conservatively excluded from these private/participant rules until recipient combinations are individually qualified.

## Localization and reachability limits

The main Judy/River scene batch has 27 inline-versus-installed English discrepancies and 12 missing installed subtitle IDs. The enabled choice statements were checked; none depends on the unresolved IDs. The additional Judy ending and Claire Santo Domingo scenes have 206 English descriptors with complete, identical installed joins. Exact line-level joins are cached in localization/queries/scene-joins.jsonl, and summary differences are retained in scene-join-summary.json.

Release-reference closure establishes reachable asset references, not that every internal socket, fake input, test input or unused branch executes. Relevant internal native routes and scene inputs were separately inspected. Installation of an archive alone is never treated as evidence of a live outcome.

### Alternate writer audit

All positive assignment hits for this pack's 22 allowlisted facts in the main graph index and currently exported scene batches have exact cited pointers. This is a bounded-corpus audit, not a claim that every unexported scene in the game has been searched.

- **Sandra:** the isolated `mq055.quest` wrapper runs an explicit chicken-test scene and writes the admission/completion setup. The wrapper is absent from the base release reference closure. EP1 contains two additional presets: preparation inside phase12 and Standalone history inside phase19. Both sets of assignments are cited. The rule therefore describes save-established history rather than asserting a human selected an answer in this session.
- **River commitment:** standalone `q203_legend.quest` sets a test flag and launches its chicken-test scene while incrementing `sq029_done`. This test wrapper is absent from the base release reference closure; production uses the separate questphase. The done fact alone never establishes romance.
- **Randy:** finale scene node2734 also writes `sq021_done`, following either normal wrap-up or a River-hates-V branch. The rescue rule selects fate from its separate positive result and claims no affection. The main cleanup's additional saved writer is also cited explicitly.
- **Claire:** reachable `CYB-599920` quest repair can write `sq024_done` during an emergency Santo Domingo cleanup. This broad flag proves neither a completed final race nor Sampson's death. The death rule independently requires the reviewed positive confrontation-death result; it never maps completion alone.

The base release closure does not by itself enumerate a separate EP1 launch root. Native EP1 preset wiring is recorded as an additional source of values; its presence does not prove the current save used that initialization route.

## Verification

- review_native_rules.mjs verify passes: pack schema, every native pointer/type and binary SHA-256.
- Compiler verification passes against winning manifests: 35 artifacts, 221 exact evidence pointers, 16 linked outcomes out of 132 researched; 116 outcomes remain native-unmapped in this pack.
- Exact narrative decision/outcome links checked against quest-maps/judy-river.json. Global research validation reports zero errors after the compatible-facet splits.
- Eighteen focused pure resolver checks pass: positive outcomes, missing gates, ambiguous zero, unknown patch, unavailable capture, private/group recipients, contradictory result flags, compatible historical facets, the car-offer disclosure requirement and Pisces cross-topic route conflicts.
- No live save qualification or cross-save memory persistence claim is made by these checks.
