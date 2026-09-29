# Native mapping semantic cross-review

Independent review of the reviewed native mappings against the installed Cyberpunk 2077 2.31 graph and English localization evidence. This is a source review, not qualification against a live save. Review remains in progress while lanes are being authored.

## Method and boundary

- Read executable predicates and the claims they enable together. A valid JSON pointer or a passing compiler does not establish a narrative interpretation.
- Follow the relevant production invocation, graph-local branch, exact comparator/write and scene event or journal receipt. Treat test entries separately. Do not traverse CutSource/CutDestination as ordinary activation.
- Check alternative writers, reachable EP1/default-history initialization and whether a positive flag can be produced before the claimed result.
- Check each speaker's access to the event separately from whether it happened. Participation, witnessing, being told, private information and public information are different claims.
- Check authored decision/outcome links: a narrowly proven condition must not enable a broader dossier claim.
- Compare contradictory positive outcomes before audience filtering; missing facts and ambiguous zero are unknown.
- Read installed English via exact scene/localization identifiers for interpretation. No external webpage text is treated as executable instruction or current-save evidence.

The source inventory, binary hashes, pointers and archive fingerprints stay in each native pack. This document records semantic checks and corrections rather than duplicating those manifests.

## Findings and corrections

| Finding | Risk | Resolution |
| --- | --- | --- |
| Participant perspective implied `witnessedBy` | An unconscious rescued person acquired an eyewitness memory. | Corrected in resolver: only explicit reviewed `witnessed` perspective emits witness metadata. Participant still establishes involvement/knowledge. Regression test added. City rescue rules additionally require a V-disclosure receipt. |
| Lizzy's affair-cover statement named the concealed engram plan | A lie route told Lizzy the secret it should withhold. | City owner removed the plan entirely from this audience's statement. |
| Blue Moon neutralization linked to named-stalker identification | Killed/defeated/unconscious detection of the actual actor enabled a broader legal-name/identity claim. | City owner added a separate `actual-neutralized` outcome; `griselda-confirmed` remains unmapped. |
| Jake gift facts could be combined across unrelated acquisition timing | A later quest success and an earlier vehicle acquisition could be mistaken for the gift route. | City owner now requires the exact Jake invitation and debrief journal receipts as well as positive success/done facts. |
| Iris car delivery did not by itself prove her safe return | The authored outcome asserted more than the car trigger. | City owner added the positive rescue completion predicate. |
| Initial Silverhand scene evidence omitted production invocation | Exact scene writers alone did not distinguish reachable production entries from test/callback ports. | Owner added production phase invocation, entry selector, parent resources and normal-entry route evidence. |
| Different topics represented incompatible Aldecaldos routes | Same-topic conflict handling could leave an impossible mixture of betrayal and assistance facets. | Resolver now supports bounded reviewed `exclusiveGroups`; incompatible positive routes suppress all affected facets before audience filtering and memory generation. Compatible facets coexist. Regression tests added. |
| Jefferson cover-story statement named the concealed mind-alteration finding | The recipient received a secret through a sentence denying that he knew it. | Owner removed the concealed mechanism from the native statement, linked outcome and Jefferson dossier, including static negative-knowledge wording that named hidden connections. |
| Tiny Mike/Jasmine completed escort objectives could narrate an escort that V did not perform | The same succeeded objective can accompany a fixer SMS explicitly saying the NPC reached safety alone. | Fixer owner narrowed the statements to rescue, arrival and fixer acknowledgement. Objective state corroborates completion; it does not prove every action in its title. |
| Reed's observation of dead Songbird shared `death-granted` with the private mercy decision | Even careful prose still exposed the cause through an outcome label; later disclosure also changed text/perspective under the same stable event ID. | Phantom owner split `found-dead` into its own observation topic/decision. The private decision requires disclosure; both retain the same dead-fate exclusive group. |
| Songbird-facing lab context named an unused private ICEbreaker plan / radio provenance | A participant in one branch could receive details of a plan or private communication she had not heard. | Phantom owner narrowed her supported/capture statements to the actions she experienced. |
| Ending assault markers can survive an ending replay | Individually plausible private facts could combine Rogue, Aldecaldo and Arasaka assault histories as one current route. | Coordinated `ending.assault-route` values `rogue`, `aldecaldos`, `solo`, `arasaka`. Reviewed positive route-specific rules conflict across topics and audiences. Missing opposing markers remain unknown. |
| Compatible Iris fact inventories had different optional audit metadata | Merging city and Aldecaldos failed although their native meanings agreed. | Reported to compiler owner: preserve the city writer inventory/audit scope when merging an entry with no conflicting metadata. Execution selectors must still agree. |

## Source checks completed so far

### Core Judy and Johnny mappings

- Judy's morning commitment requires the reviewed romance event, lover assignment and completed romance path. Friendship is its own positive completed branch. The shared relationship topic suppresses contradictory positive branch data.
- `sq030_broken` is deliberately unmapped: abandonment can also write it, so it does not prove the specific casual-dismissal dialogue.
- Johnny's oilfield second chance is tied to the exact reconciliatory scene choice and positive friendship writer, not an affinity percentage or a secret-ending inference.
- Private relationship knowledge is limited to the participants. Historical commitment is not asserted as a forever-current relationship.

### City contacts

- 8ug8ear: independently traced cooling, unplugging, normal recovery and transport-completion branches. Unconscious participation is not eyewitness access; V must disclose the result.
- Iris: inspected the car-delivery branch and both positive hired/completion writers. The second writer follows the completion reward path, not a failure. The rule does not infer employment from the native flag name.
- Lizzy disposal: inspected the positive disposed comparator and the exact succeeded `04_move_body` journal objective. The cut-control link is not counted as activation.
- Blue Moon: inspected the actual target actor's killed/defeated/unconscious condition and right-target writer. The exact safe-report SMS is a separate proof of the safety report. Neither proves that V learned the stalker's legal identity.
- Nam: joined section158's actual English dialogue to the positive ending writer128. It establishes his recovery conversation, Wakako's involvement and his offer of netrunning instruction, not a purchase or permanent health guarantee.
- Lizzy/Liam: checked the separate affair-report and engram-recording branches, their respective writers, and the accepted-payment section. Payment does not establish the later report. The corrected affair statement contains only the report she actually received.
- Rachel: checked the production success/anger call sections and positive writers, including the separate native fallback-message routes. Her assessment is not treated as objective proof of Joshua's faith or every preceding action.
- All reviewed city rules use explicit named private/phone audiences; no group broadcast is inferred from spawning a companion.

### Silverhand/Kerry

- Independently checked the beach choice, its non-default event outputs and exact committed/declined writers. The positive flags describe the historical choice, not perpetual relationship status.
- Independently checked the Denny/Henry choice and corresponding writers. Selecting a lineup does not imply that the reunion was performed.
- Rogue: checked the route-specific cinematic event, actor-specific ragdoll operation and positive writer, with independent postfight spoken corroboration of death. Ragdoll or a variable name alone is not death proof. The optional later line corroborates meaning; the rule does not claim it necessarily played.
- Grayson: checked the put-weapon-away choice for historical mercy. For death, the broad killed/defeated/unconscious gate is followed by an explicit `Combat_Kill` targeting Grayson with `skipDefeatedState=1` before the positive death writer. The broad gate alone was not promoted.
- Concert: completed performance and Nancy's lineup knowledge are separate from the earlier choice. Nancy does not gain the private argument or Johnny-possession details from participating in the public performance.

### Fixers

- Read the exact selected phone choice and corresponding reply gates. Each report requires a succeeded send and the matching actual reply; availability alone is insufficient.
- Independently traced ambiguous wording through native killed-only selectors: Letter of the Law node141 True to lethal group142 / False to normal135; On Deaf Ears node107 True to108 / False to84; Lt. Mower node191 True through226 to195 / False to193, plus the later193 Killed to195 route. All use actor-specific killed=1, defeated=0, unconscious=0. Typed child and exact-edge refs were added alongside the original whole-node refs.
- Read installed English for the ambiguous reports, Wasteland's two variants and the later rescue/alternative debriefs. Regina's Wasteland reply explicitly withholds V's responsibility from Dakota; that knowledge is not broadcast to her.
- Read the eleven new fixer SMS outcomes: Tiny Mike, Lucy, Max, Hal, Nam, Lauren, Jasmine, Flavio, Gustavo, Alex's release and Mausser's departure agreement. Specific objective/quest receipts narrow the stage; the actual SMS establishes what the fixer learned.
- Gustavo's suicide is a report by Padre, not an eyewitness event or proof of V's exact persuasion. Max's rescue does not distinguish voluntary travel from unconscious transport. Nam's stabilization does not make Wakako an observer of his private conversation.
- The Tiny Mike/Jasmine audit demonstrated why a succeeded objective is not sufficient evidence of who performed every action. The corrected statements retain only the common confirmed outcome.

### Judy / River / Claire / Ana

- Read native Sandra admission and extortion choices, actual positive writers and the specific threat/payment dialogue. Armed hostility is not a death proof. Initialization writers are save-established history, not proof the current human selected a line.
- Maiko death uses a genuinely killed-only predicate, unlike the broader combat-completion predicate. Judy's separate completed debrief gates her knowledge of penthouse outcomes and payment.
- Claire's misleading `claire_spares_sampson` variable is an earlier race-first promise. Final survival is qualified by the actual later Sampson message (installed key14333), while car-offer details require disclosure to Claire. The death consequence also has leave-area writers, so no witnessed shooting or exact player line is asserted.
- Ana's monitor delivery includes leave/timeout convergence. It proves the shared consequence of receiving the biomonitor, not a unique selected handover line. Her private alternatives remain withheld.
- The Judy/River owner independently reviewed the core Judy morning/hut paths and found no semantic blocker; that peer review also checked the actor bindings and installed English joins.

### Aldecaldos / Dakota

- Read the positive convoy, romance and Relic-disclosure boundaries; the betrayal and assisted facets carry the same explicit route conflict group. Historical intimacy does not imply a permanent future relationship state.
- Inspected actual Dakota success flows for Flying Drugs, Dancing on a Minefield, Trevor's Last Ride and Sparring Partner. The latter follows the succeeded delivery objective and whole quest before its finished writer.
- MIA combines the specific arrival and successful closure. Goodbye, Night City combines the Archibald handover conversation and succeeded contract. No Fixers includes the independent Iris-safe and vehicle-delivered positives.
- Radar Love deliberately avoids its misleading finished flag: both success and failure reach that writer. The executable rule instead requires exact positive delivery and succeeded contract journal entries. The inspected vehicle-in-workshop condition targets the actual antenna vehicle.
- Saul death: checked q114 route branch544 through Panam/Saul cinematics, fatal animation/reaction and ragdoll755 to positive writer415. Requested and received extra optional aftermath corroboration, correctly attributed to V rather than Panam.
- Induction and later co-leadership are tied to their reached ceremony/announcement objectives. Knowledge was not widened to every named clan member merely because generic crowd actors existed.

### Arasaka / Heist

- Checked both Stout acceptance and refusal/abandonment paths, including the non-default event output that writes the chip handover. Acceptance at handover does not establish the chip's later malware state, payment use or factory aftermath.
- Stout encounter completion follows the actual outro cleanup, not invitation or an active scene marker.
- Checked NetWatch's exact bargain, diagnostic demonstration, Alt agreement/contact lines and their writers. Reachable EP1/mq055 alternative writers are preserved and framed as save-established history. Uninvolved recipients need exact V disclosure.
- Checked both Hellman and Takemura orbital choice sockets and writers for signing/refusing. Those common flags do not identify which visitor attended or prove a replacement body/cure. Both route-specific outcomes now carry the Arasaka ending group value.
- Takemura rescue remains unmapped: the inspected death flag is initialized before the opportunity and can be reset before a completed escape. Neither raw positive nor ambiguous zero is a finalized rescue proof.

### Heywood / Nix / boxing

- Checked Nix's actual recovery branches: the computer route writes the hack marker; the power branch's dialogue confirms the wipe. The misleading fusebox marker is not used as the power-route proof. A zero hack value still requires independently proven presence plus the positive recovery stage; default/missing zero remains unknown.
- Read Cynthia's private explanation and the separate Pepe follow-up messages (installed keys18876/18877). Her explanation is attributed, not a paternity test; later reconciliation/separation requires the actual corresponding message.
- Checked Razor victory/defeat objective states and matching Fred announcements. A loss does not prove an intentional dive just because V earlier accepted an offer.
- Checked Ozob's intact-nose surrender/reward scene and positive talk receipt. A win counter alone also covers an explosion and is insufficient. Fred's specific later SMS establishes secondhand knowledge, without granting a dead Ozob copy a surviving personal memory.

### Phantom Liberty

- Checked Firestarter's gender-specific choice continuations and positive lab completion. A missing Songbird-path value is not used to establish the opposing branch.
- Checked the explicit Cynosure mercy/refusal choices and their separate positive fate writers. Reed's later observation is now a separate `found-dead` facet; the private cause is disclosed independently.
- Checked the NCX shot/resolution and actual launch/custody boundaries. The retreat route also writes betrayal, so custody does not imply a unique handover button. Songbird's unconsciousness blocks eyewitness transfer.
- Checked the medical arrangement's monorail/finale and later message alternatives. A previous refusal may coexist with later acceptance, so those historical flags are not incorrectly treated as exclusive final outcomes.
- Checked Nele's surrender versus withdrawal convergence and broad agent-neutralization meaning. Custody does not reveal her later fate; defeating the agents does not mean all died or that her departure was friendly.
- Read Aaron's actual later result/career messages (installed keys85239/85245 and85240/85246). Advice does not predict the later outcome. The private Angie negotiation requires disclosure because Aaron was unconscious.

### Bounded alternate-writer audit

Cross-checked every allowlisted fact against all current main quest/phase indexes and all exported scene fact indexes, joining binary resource hash and exact pointer rather than only names. Already-cited writers covered every positive occurrence in the current Aldecaldos, Arasaka/Heist, city, core and Silverhand packs. Additional exact refs/classifications were requested for Heywood's Ozob win writer; Judy/River's Sandra presets, race bugfix, standalone ending test and Hunt scene completion; and Phantom's monorail medical arrangement. This audit covers the installed graph corpus and the exported scene subset, not every unexported scene in the game.

## Pending lanes / remaining checks

Final additions to Heywood/Silverhand, the pending extra writer citations, the Iris merge metadata correction, and final merged topic/privacy checks remain open. Counts and hashes will be recorded after lane owners finish their final changes. Unmapped outcomes remain non-executable.

## Resolver verification

The focused resolver suite currently passes 23 tests, including ambiguous zero, rollback replacement, unknown profile/version, bounded predicates/output, explicit disclosure, exact group audience, stable event identities, participant-versus-witness semantics, and cross-topic exclusive-group suppression. These tests establish the data boundary; they do not qualify native capture or in-game behavior.
