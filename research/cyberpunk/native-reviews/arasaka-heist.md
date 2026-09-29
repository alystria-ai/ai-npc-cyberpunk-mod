# Arasaka / Heist native mapping review

Reviewed against the installed **Cyberpunk 2077 2.31** assets on 2026-09-30.
This is source qualification. No game fact was written, no save was modified,
and no rule has been qualified through a live save capture.

## Coverage

- Narrative research: **9 dossiers, 63 original dialogue examples, 22 quests,
  75 decisions, 124 outcomes**.
- Executable native mapping: **8 outcomes**, across the initial Stout offer,
  her private encounter, NetWatch/Alt, and the two Arasaka contract choices.
- Explicitly unmapped: **116 outcomes**, retained as non-executable coverage rows.
- Native evidence verification: **25 distinct artifacts, 148 exact JSON
  pointers**. Binary SHA-256, archive winner, JSON pointer, expected node type
  and narrative outcome links passed the pack verifier.
- Eight positive fact keys are allowlisted. There are no zero comparisons,
  inferred journal hashes, wildcard private audiences, or live-verification claims.

The executable boundary is native-rules/arasaka-heist.json. Broader research is
in quest-maps/arasaka-heist.json and the nine assigned dossiers.

## Provenance and release paths

Every evidence record stores the binary asset SHA-256 and its precise JSON
pointer. Game wording was used for internal interpretation; runtime statements
and dialogue examples are original prose.

The installed game definition declares the main quest at
/Data/RootChunk/mainQuests/0/Data/questFile. Its verified binary SHA-256 is
3bc1e3a75a1ba9dc582b8c7736a758899001cd15424ed79e1654de8b8ca41bbd.
The quest references the production phase. Evidence follows the production
prologue, Act 1, epilogue and additional/persistent-content references to the
reviewed phases. File names alone were not used to establish a release root.

A resource reference proves inclusion in that graph hierarchy; it does not prove
that the current save executed a branch. For reviewed rules, that requirement
comes from a positive current-save observation of the specific fact and the
inspected scene choice/event that writes it. Runtime capture still must meet
RUNTIME_CONTRACT.md: current-world binding, known positive value, exact version
and correct audience.

Normal scene entry paths were distinguished from extra test/callback ports:

- Initial Stout meeting: q003_militech.questphase node53 enters
  q003_01a_militech_in. The malware-removal callback is separate.
- Motel: q003_stout.questphase node20 enters q003_07a_stout_sex_in.
  Failure, farewell, cat and other callbacks do not establish intimacy.
- Mall agent: q110_06_inside_mall.questphase root node26's embedded graph,
  input0 -> restriction16 -> scene7 q110_07_agent_in.
  AfterAgentTestIn and AfterAgentDealTestIn are separate test ports.
- Alt: q110_11_alt.questphase reaches scene2 after the Alt-spawn condition.
- Orbital visit: q201_heir.questphase root node38's embedded graph routes
  normal input through visitor phase41, then hellman_out -> scene8 or
  takemura_out -> scene29, each entering day_30_start.

Numeric IDs are graph-local. Full graph/scene pointers distinguish identically
numbered nodes in different embedded graphs.

## Exact reviewed outcomes

### Militech chip accepted

ahe-native.chip-accepted maps
arasaka-heist.militech-chip / accepted-intact.

In q003_01a_militech.scene, choice1351 option0, or the acceptance after the
malware challenge, reaches hub2617 and handover section1844. Its output with
**name2, ordinal0** writes q003_militech_chip += 1 at node2752 (graph49).
Reading only name0 scene edges would miss this event. The choice and Meredith's
handover line were joined from screenplay IDs through locStore to English.
Actor1 is Meredith.

The statement records acceptance with malware present at handover. Later
cleaning, copying, payment and factory aftermath are independent. Only Meredith
receives this as a participant, privately with V.

### Militech chip declined or abandoned

ahe-native.chip-declined maps arasaka-heist.militech-chip / declined.

Choices1351/option2 and2869/option1 converge on refusal section2735 and
writer2737 (graph48), adding one to q003_militech_refused.
A distance-abandonment path also reaches that writer. The statement therefore
covers declining or abandoning the offer without inventing an exact spoken
refusal. Both accepted and declined positives conflict within the same topic
and suppress each other.

### Stout's completed private encounter

ahe-native.stout-encounter maps arasaka-heist.stout-encounter / completed.

q003_08_stout.scene node2288 (graph142) sets q003_stout_sex_done = 1
after the encounter's outro. The audited chain includes node1767 waiting for
q003_07a_stout_sex_closer to exit, actor cleanup, restoring the player's clothes,
removing restrictions, ending the audio mix, restoring gameplay, then completion.
This is separate from invitation, acceptance and active-sequence flags.

Meredith is the only enabled audience. Ongoing romance, exclusivity or another
meeting is never inferred. Other actor entries in this resource do not confer
access to the private encounter.

### NetWatch bargain accepted

ahe-native.netwatch-accepted maps arasaka-heist.netwatch-choice / accepted.

In q110_08a_agent.scene, section659 states the agent's terms.
Choice671/option0 -> hub4117 -> node712 sets q110_08a_netwatch_deal = 1.
Later callback writer547 adds one to the same fact; the runtime test is >= 1.

The terms concern removing the virus, releasing Brigitte and Ti Neptune, and
letting the agent depart with his data. Their fulfillment or the runners' final
fate is not inferred.

EP1/mq055 initialization also assigns this positive fact. Those paths can
establish default history in this save. Wording does not claim the human
personally selected the option on screen. Every listener in this lane requires
a matching V-disclosure receipt. Placide does not gain private NetWatch
conversation knowledge from an actor entry or later phone callback.

### Agent's malware warning and diagnostic demonstration

ahe-native.placide-virus-warning maps
arasaka-heist.placide-malware-warning / warned-by-agent.

Section769 explains the planted virus. Diagnostic choices1263 and2429 lead
through two diagnostic sections. Section2434's event output writes
q110_08a_virus += 1 at node966 (graph67). The English lines explain the
duplicate, forged diagnostic result.

This covers a reached subset of warning paths. An earlier warning followed by
immediately incapacitating the agent may not write this fact. Missing that
subset is preferable to inventing a completed diagnostic. Bargain acceptance
and disclosure to Placide remain separate; this rule requires a receipt.

### Contact with Alt

ahe-native.alt-contact maps arasaka-heist.alt-contact / met.

q110_14_alt.scene section1022 contains the agreement and contact-channel
exchange. Condition1028 splits on NetWatch. Either section714 or735 writes
q110_made_contact_with_alt += 1 at node1027 (graph52) via an event output.

Contact is established across both routes. EP1/mq055 may initialize equivalent
save history. The mapping does not automatically tell Hanako, Placide or another
outsider what was discussed; each listener requires V's exact disclosure.

### Secure Your Soul accepted / refused

ahe-native.contract-signed and ahe-native.contract-refused map the two outcomes
of arasaka-heist.secure-your-soul.

| Scene | Choice | Accept writer | Refuse writer |
| --- | --- | --- | --- |
| q201_07_cabin_day_30 (Hellman) | 2038, graph40 | 3001, graph84: q201_ice=1 | 3005, graph85: q201_earth=1 |
| q201_08_cabin_day_30_takemura | 154, graph61 | 227, graph84: q201_ice=1 | 228, graph85: q201_earth=1 |

Option0 selects digitization; option1 selects returning to Earth. English
payloads and direct socket destinations were checked in both scenes. Both
outcomes share v.secure-your-soul and contradictory positives suppress the topic.

These common flags do not identify the visitor. Takemura receives this knowledge
through the receipt route here. A visitor-specific rule needs separate positive
participation evidence. Signing does not prove a suitable body was found;
refusal does not prove a later cure or death date.

Both reviewed orbital contract scenes belong to the Arasaka ending. Their rules
also carry exclusive group ending.assault-route / arasaka, as requested by the
parent review. Replayed saves with positive evidence for another assault route
must suppress conflicting current ending context and memory. This metadata is
limited to the final contract rules; earlier Stout, NetWatch and Alt history is
compatible with later route choices and is not assigned to that group.

## Knowledge boundaries

Stout's offer and encounter have native and narrative participation evidence
and are restricted to private/phone conversation with her.

The other five rules use told-by-v for this lane's nine profiles. The resolver
requires an authored receipt for the **same topic, same outcome, exact listener**.
The native fact alone supplies no such context. Spawning a model establishes no
canonical presence or shared experience.

No group channel is enabled for these private facts. Verified native save,
playthrough, branch and checkpoint identity is still required before the
coordinator may propose durable memory.

## Reviewed hazards retained as unmapped

### Pickup branches

Chip acceptance is not current infection state. Cleaning/copying, payment,
warning Royce, combat, Flathead possession, Maelstrom fates, leak discovery and
the Militech visitor need separate outcomes.

q003_calm_ending is written after the final Jackie chat and does not establish
absence of earlier combat. q003_done also occurs in initialization/test setup.

The factory-end graph assigns q003_brick_dead when the rescue flag is absent.
It cannot identify V detonating the trap versus leaving Brick unrescued.
Royce's generic neutralization condition admits unconscious/defeated states;
it does not establish execution by V.

The q003_meredith_won / q003_anthony_won resources have gate, failsafe and
later phone/farewell entries. Entry-specific audit is needed for the narrative
gate-meeting outcome. Misleading *_dead_conclusion names were not promoted.

### Takemura rescue

q112_10_safe_house.scene has three q112_takemura_dead writes:

- Node1615, graph207, sets one before the rescue opportunity finishes.
- Node1588, graph199, resets zero when V reaches the rescue-floor trigger and
  activates the rescue objective, earlier than a completed joint escape.
- Node534, graph71, reasserts one through the abandoned-escape branch.

Neither a positive mid-mission flag nor ambiguous zero proves finalized fate.
q112_done occurs in the later proxy/Johnny sequence and wrapping phase, with
another setup writer elsewhere. Final rescue needs reached escape/journal
evidence and independently established outcome. No rule was promoted here.

The reconnaissance scene was also inspected. Its talking switches are transient;
scan counters and impressed values do not establish that V heard Takemura's
specific childhood account.

### Hanako disclosures

q112_hanako_info_given increments across several information branches. Its total
cannot identify which lead V shared. Hellman and Alt disclosures remain separate,
unmapped outcomes. Quest completion cannot unlock every optional disclosure.

### Voodoo Boys / NetWatch

Acceptance and warning do not identify runner fates, who attacked first, or
Placide's death.

Persistent/escape graphs contain a killed-only condition for
q110_placide_killed: killed=1, defeated=0, unconscious=0. This is stronger than
a generic defeated flag. Its completed-release sequence and appropriate audience
still need full qualification, so it remains inactive.

### Other Arasaka ending details

q113_mikoshi_jackie_played is written when V requests the construct at
choice257/option2. It precedes the actual conversation. Prior Takemura disclosure
is required too. This flag alone does not prove a completed Jackie encounter.

Contract flags do not identify the visitor, tower participants, Oda's fate or
Smasher's execution. Yorinobu's sitting/standing/synchronization flags do not
establish hearing his full explanation. These outcomes remain independent.

## Remaining work by quest

Non-executable rows preserve each outcome separately.

| Quest | Native qualification still needed |
| --- | --- |
| The Corpo-Rat | Observed lifepath, Jenkins commission, Frank office conversation, dismissal; no office friendship for other lifepaths. |
| War Pigs | Lure versus actual confrontation; peaceful exit, nonlethal defeat, player kill and self-inflicted death. |
| The Ride | Completed Dex briefing and its disclosure scope. |
| The Information | Storage scan versus optional security scans; private Evelyn bypass offer. |
| The Pickup | Completed interrogation; chip cleaning/copy; payment; factions fought; Flathead; three Maelstrom fates; leak discovery/disclosure; actual gate visitor. |
| Venus in Furs | Invitation received and response, independently of mapped completed encounter. |
| The Heist | Evelyn disclosure, promised cut, Saburo witness event, lost T-Bug contact, later death report, Jackie destination and Dex betrayal. Other lanes own some Jackie mappings. |
| Playing for Time | Takemura recovers V; separate diner agreement. |
| Down on the Street | Oda refusal and optional shared ride. |
| Gimme Danger | Joined/declined recon, childhood and Jackie disclosures, float compromise. |
| Play It Safe | Sniper route, Oda fate, Hanako abduction. |
| Search and Destroy | Hanako testimony, finalized rescue/loss, separate Hellman/Alt disclosures. |
| M'ap Tann Pelen | Actual Placide briefing and its limited contract. |
| I Walk the Line | Rejection/agent neutralization, payload survival, return to Placide. Acceptance/diagnostic subset mapped. |
| Transmission | Runners, initiation of hostility, Placide's precise fate. Alt contact mapped. |
| Nocturne OP55N1 | Heard offer versus committed route. |
| Last Caress | Completed extraction and actual Takemura participation. |
| Totalimmortal | Saburo revelation, completed Jackie encounter, board testimony, Smasher fate, Yorinobu explanation and Takemura help. |
| Where Is My Mind? | Prognosis receipt and actual visitor. Both final choices mapped. |
| Second Conflict | Actual Totentanz leader; earlier neutralization flags insufficient. |
| The Gift | Collection from Yoko. |
| The Rescue | Completed Sandra extraction and actual participants. |

## English localization cross-check

The scene exports include English locStore entries. The data audit also joined
scene IDs against installed lang_en_text.archive subtitles.
localization/queries/scene-join-summary.json records 33 differing entries and
3 absent subtitle IDs among the 18 exported scenes in this lane.

Cited initial Stout offer, mall-agent and final contract payloads are not in the
reported discrepancy list. Cited Alt agreement/channel payloads likewise are
not listed. The absent Stout ID is uncited support material; the completion
chain does not depend on its wording.

Further work on the safe-house/proxy, confrontation, Yorinobu and other differing
entries must prefer the shipped subtitle and retain the exact scene-to-string
join. English authoring text is not automatically the final shipped wording.

## Validation boundary

JSON parsing and validateKnowledgePack passed.
verifyNativeEvidence passed all 148 pointers against 25 binary assets.
All eight executable outcome links match their narrative quest keys.
The other 116 outcomes are non-executable records.
An additional 57 offline assertions passed for positive observations, missing
facts, ambiguous zeros, unsupported versions, forbidden group audiences,
missing/wrong disclosure receipts and mutually conflicting choices. These
exercise authored pack behavior without claiming an in-game test.

This is a verified subset with an explicit coverage gap. It does not claim a
complete quest-memory implementation or in-game acceptance.
