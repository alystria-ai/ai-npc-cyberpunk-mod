# Character knowledge coverage audit — October 1, 2026

## Scope and result

This is an independent, bounded audit of the 79 current conversation-profile inputs, their generated fields and the compiled quest pack. It is a source/configuration audit, not a new cloud readback, live-conversation qualification or complete primary-source validation of every biography. The author read every dossier's biography, delivery guidance, relationships, private/unknown knowledge and original examples through projected inspections and serializer checks. After the audit, the root authorized a scoped correction to the two ambient source dossiers. Their delivery directions and examples remain unchanged; generated and cloud profiles have not been updated by this agent. No provider memory, save or game state was changed.

The baseline captured at **2026-10-01T09:01:17.417Z** has:

- **79/79 dossiers:** 77 named characters and two explicitly authored ambient templates.
- **618/618 distinct original spoken examples**, with no exported speaker labels or V prompts.
- Separate biography, speaking-style description and spoken-example API fields.
- **253 researched quests, 704 decisions and 1,160 outcomes**; no schema/reference errors or warnings in a fresh in-memory validation.
- **172 compiled rules linked to 166 distinct researched outcomes**. Only **52 profiles** are eligible speakers for any compiled rule; **39** have participant/witness/public rules. **43** have at least one specific authored conditional outcome executable for that speaker.
- Generated roster fields exactly matched a fresh in-memory profile build at capture time. No shared build was run.

The October 1 native additions and provenance migrations were still being integrated by other lanes. They are intentionally excluded from these baseline counts. Regenerate this audit's machine snapshot after that merge before claiming new totals.

## Findings and recommended changes

Root integration after this baseline: the two resident profiles were regenerated
and updated through existing cloud mappings. Both readbacks confirmed the new
backstory and model, with memory configuration preserved; no character was
created. The combined native pack now has 191 rules / 185 mapped outcomes and
5,359 hash-bound evidence pointers. The per-character table below deliberately
retains the earlier audit baseline, rather than inventing refreshed attribution
counts from those aggregate totals.

| ID | Status / priority | Evidence and consequence | Recommended root action |
| --- | --- | --- | --- |
| CK01 | Source corrected; generated integration pending | Resident dossiers promise per-pedestrian confidentiality/continuity and session-local fallback. Active `PlayerKnowledge` keeps physical entity IDs in transient session keys but sends the one persistent player ID to the same generic provider character. `PlayerMemory` enables/adopts that profile's memory normally. Distinct sessions do not partition durable provider memory. `docs/PLAYER_MEMORY.md` already states the real limitation accurately. | Keep the one-ID policy. The two source dossiers now remove the per-body durable-memory promise. Describe profile-level recalled conversations as unverified for this body, avoid asserting a personal history, and retain the entity-specific transient-session boundary. Do not claim prompt wording establishes hard provider isolation. Regenerate the roster, profile text and profile plan after correcting source dossiers. |
| CK02 | Naming suspicion cleared; voice binding still pending | `Character.sts_hey_rey_09_tobias` is an unexpected internal name, but native onscreen display-name/full-name entries identify it as **8ug8ear** (32836/32837). The fresh `bugbear_default.scene` actor acquires `rey_09_target`, and a typed native community spawn entry binds that name to this exact record. The final world NodeRef-to-community resource edge remains unqualified for voice attribution. | Keep the current canonical record. An internal spelling is not a different male NPC. Finish the exact world-binding proof before promoting generic default speech; do not change the body from name similarity. Native community use establishes this is an NPC record, but this audit does not certify every companion spawn/animation case. |
| CK03 | Confirmed documentation drift; low | Several dossier uncertainties still say all native outcomes remain unmapped. That is no longer true for Aaron, Alex, Dino, Johnny, Hands, Nele, Panam, Regina, Reed and Songbird. The separate narrative maps' `runtime.status=unmapped` is intentional authoring state; it is not the compiled pack's qualification. | Replace blanket claims with “only outcomes in the reviewed native pack are executable; other authored outcomes remain research-only.” Leave real unresolved particulars explicit. Do not turn documentary cleanup into rule enablement. |
| CK04 | Evidence limitation; medium | **636 source attachments** comprise 586 community, 24 guide, 8 community-transcript, 7 walkthrough, 6 transcript, 3 official and 2 primary entries. Attachments repeat sources across dossiers. The five official/primary attachments mainly qualify patch features, gig ownership or an occupational archetype; they are not primary proof of every major biography. Many Fandom bodies were blocked and the notes honestly identify indexed excerpts. | Preserve those acquisition limits. Link new scene/journal/shard evidence to individual intrinsic claims, especially when casting exposes an alias or identity-sensitive recording. Do not describe collector URL counts or a cited wiki as exhaustive verified game canon. |
| CK05 | Confirmed depth limitation; medium | Named biography bodies range **66–162 words**, median **110**. Source count and the longer generated prompt include limits/guards, not additional life history. Main cast usually has richer quest lists, but Jackie has 43 researched affected outcomes with no compiled link; Hands 82/2; Panam 65/8; Johnny 93/12; Judy 50/5; River 27/3. A quest list is not usable character knowledge. | Prioritize verified major-character history and branch coverage, while leaving one-off characters sparse. Extend claim-level evidence and exact condition/audience mappings rather than adding generic prose to hit a length target. Johnny's war/career and Jackie/lifepath progression are useful next targeted dossiers. |
| CK06 | Builder consequence; medium review | `buildProfiles` emits biography, background, baseline relationships and unknown limits. It excludes `knowledge.private` and all conditional changes. Important individual texture can therefore be absent despite existing in research—for example Evelyn's NetWatch approach, Nix's corporate leak and Mitch's forced wartime drug context. Appending every private item blindly would also introduce sensitive or unqualified claims. | Classify supported self-knowledge separately from audience disclosure before any builder change. Source and qualify a fact first, then add a guarded intrinsic/private layer if needed. Never convert conditional quest memories or instructions into universal static history. |
| CK07 | Prompt-quality caution; low | Original examples are structurally clean and individually different, but many emphasize “what did you actually see,” evidence, discretion and clear plans. This is useful safety guidance but can flatten diverse characters into prudent analysts if made dominant. The previous blinded prompting pilot did not establish a broad stylistic improvement from extra directions. | Preserve the accepted baseline. Use native lines to check cadence, humor, defensiveness and emotional registers; write original scenario-specific examples and evaluate fresh exchanges. Do not equate a schema pass or model-authored score with faithful conversation. |

### Confirmed code path for CK01

- `bridge/convai-bridge.mjs` imports and constructs **PlayerKnowledge**, not the older anonymous-aware `KnowledgeRouter`.
- `bridge/player-knowledge.mjs:#configuration` adds ambient entity to its session partition but returns `remoteConfig:{endUserId:memory.endUserId}` for every ready route.
- `bridge/player-memory.mjs:route/prepareCharacter/beginConversation` resolves the one configured provider character and player identity; no durable body key is used.
- `bridge/player-knowledge.test.mjs` explicitly checks same player ID with separate physical entity sessions. This is narrower than per-body durable isolation.
- `resident-female.json` background/private/unknown and `resident-male.json` private/unknown/uncertainties contain the overclaim. Some private text is research-only, but unknown/background text reaches the static generated prompt.

### Canon and uncertainty checks retained

No new confirmed cross-character biographical swap or fabricated life history was found in the bounded prose pass. This is not an assertion that every historical detail was independently re-proven from primary assets. The profiles deliberately preserve important distinctions: Aaron Waines versus Aaron McCarlson; real Mark Bana versus impersonated communications; Bill's uncertain marital label; Cynthia's private medical history versus an affair allegation; Panam's Tower silence versus a death claim; Rogue/Trace parentage uncertainty; Johnny's subjective memory versus objective history; and era-bound Santiago/Spider/Thompson versus omniscient 2077 versions.

Bugbear’s internal record is a useful false-alarm check. The native onscreen record keys explicitly name 8ug8ear despite the `tobias` spelling. Her default scene actor and community entry agree on `rey_09_target`. Matching this exact community to the scene’s world NodeRef still needs its binding edge before the default voice can be promoted. This audit therefore does not recommend replacing her physical catalog entry.

Jim Jarry is another useful limit: the casting lane freshly identified `Character.jim_jarry` as the Guns n Horses scene's voiceset holder. Older race announcer scenes use a separate canonical record despite the same voice tag. Those facts support correct clip attribution but do not independently turn a broadcast role into his full street-contact biography. Race contact and broadcast evidence must stay distinct until corroborated.

## All-profile depth and branch table

**Bio** counts only the authored biography, excluding common guards. **Src** is attached sources, not independent primary sources. **Q** counts this dossier's researched quest keys. **Cond** is the number of distinct authored conditional outcomes (knowledge plus relationship changes). **Exec** is the subset matched by a compiled narrative link whose speaker audience includes this profile. Exec is source-level eligibility, not proof the current save satisfies the condition, disclosure exists, every channel is allowed, or the player heard it. Zero means explicitly unqualified, not an excuse to invent an outcome.

| Profile | Bio | Src | Q | Cond | Exec | Individual basis and boundary |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 8ug8ear | 154 | 2 | 1 | 3 | 2 | Sparse runner portrayal; rescue/transport needs attributed knowledge; canonical record name verified; voice/world binding under review. |
| Aaron Waines | 124 | 2 | 1 | 9 | 6 | Aaron Waines, not Aaron McCarlson; distinct intimidation, implant and fight outcomes. |
| Adam Smasher | 146 | 10 | 7 | 5 | 0 | Deliberate brutality and Arasaka employment; friendly copy is not redemption or resurrection. |
| Alan Noël | 124 | 4 | 2 | 6 | 0 | NetWatch cover belongs to his own knowledge; affiliation and investigation are not group disclosure. |
| Alex | 148 | 10 | 9 | 9 | 2 | Daphne cover, acting wish and FIA fatigue; survival, farewell and dance are separate. |
| Ana Friedman | 93 | 4 | 3 | 9 | 2 | Analyst, not generic armed operative; Bana evidence and Steven disagreement remain attributed. |
| Arthur Jenkins | 88 | 5 | 1 | 4 | 0 | Departmental rivalry; V employment requires Corpo history; no posthumous witnessed memories. |
| Babs Okoye | 131 | 4 | 2 | 5 | 0 | Independent protective soldier, not Paco's biological sister or interchangeable narrator. |
| Bill Mitchel | 110 | 4 | 2 | 7 | 0 | Bill/Stella partner wording preserves marital uncertainty; shop opening requires an outcome. |
| Blue Moon | 145 | 4 | 3 | 8 | 2 | Public idol image is not a private psychological biography; job completion does not prove survival. |
| Bob Sagan | 104 | 7 | 5 | 10 | 0 | Limited technician/veteran basis; Jake is not his son; no invented surgeon credentials. |
| Briana Dolson | 116 | 3 | 1 | 2 | 0 | Community organizer and bereaved people; not Jason's mother; reports differ from direct knowledge. |
| Carol Emeka | 115 | 13 | 8 | 15 | 0 | Distinct technical competence; physiological monitoring is not access to cyberspace or private romance. |
| Cassidy Righter | 99 | 11 | 7 | 10 | 0 | Family gunslinger; childhood rescue concerns Panam's friend, not automatically Panam herself. |
| Chang-Hoon Nam | 139 | 4 | 2 | 5 | 1 | Correspondence and technical limits; inconsistent age omitted; agreement to hack is not success. |
| Claire Russell | 114 | 7 | 6 | 11 | 4 | Craft and grief coexist; Sampson culpability stays attributed; revenge disclosure is stage-dependent. |
| Coach Fred | 68 | 5 | 7 | 7 | 2 | Limited promoter/boxer basis; no invented titles; championship scheme is not a standing agreement. |
| Cynthia Najarro | 71 | 6 | 2 | 5 | 1 | Office work and private body history; no assumed affair; Pepe does not inherit her secrets. |
| Dakota Smith | 123 | 18 | 11 | 15 | 8 | Local brokerage and Pomo identity; no invented ceremonies; client allegations need reports. |
| Dennis Cranmer | 70 | 2 | 1 | 5 | 2 | Sparse extraction contact; Haruyoshi's story remains attributed; no invented criminal empire. |
| Dexter DeShawn | 102 | 6 | 5 | 7 | 0 | Shrewd fixer rather than field-solo rewrite; released-game history excludes trailer betrayal. |
| Dino Dinovic | 97 | 7 | 6 | 9 | 1 | City Center, nightlife and band basis; proximity to musicians is not personal friendship. |
| Elizabeth Peralez | 76 | 5 | 2 | 7 | 0 | Professional agency and family concern; do not label her experiment originator or preload confession. |
| Evelyn Parker | 127 | 7 | 7 | 5 | 0 | Ambition, compartmentalized plans and vulnerability; conversation after story endpoint is a mod extension. |
| Frank Nostra | 98 | 3 | 2 | 5 | 0 | Corpo-colleague relationship only; later collapse and peaceful/fatal branches remain unresolved without evidence. |
| Hanako Arasaka | 98 | 13 | 6 | 12 | 1 | Formal family/netrunner basis; different eras remain distinct; access is not universal corporate knowledge. |
| Iris Tanner | 131 | 2 | 1 | 3 | 2 | Independent techie with two sources; rescue and vehicle/tool recovery are different obligations. |
| Jackie Welles | 75 | 11 | 9 | 7 | 0 | Heywood/family/craft basis; lifepath meeting and all heist choices need specific history. |
| Jake Estevez | 137 | 5 | 3 | 4 | 3 | Mechanic and imperfect social judgment; Thorton recovery and Quadra gift/collection are separate. |
| Jefferson Peralez | 108 | 6 | 2 | 8 | 2 | Candidate baseline, not universal eventual mayor; memories and suspicion remain attributed. |
| Jesse Johnson | 66 | 4 | 1 | 3 | 2 | Implant emergency, not celebrity biography; normal delivery after recovery; no invented broad career. |
| Jim Jarry | 116 | 3 | 2 | 4 | 0 | Race-contact role is documented; broadcast uses canonical record, but media-role biography needs corroboration. |
| Johnny Silverhand | 110 | 21 | 33 | 19 | 6 | Engram and subjective recollections; major war/career depth still thin; no universal ending or viewpoint. |
| Joss Kutcher | 119 | 4 | 2 | 5 | 0 | Specific parent/family portrayal; Randy state and private trauma require appropriate audience. |
| Judy Alvarez | 136 | 18 | 17 | 22 | 5 | BD craft, family and worker solidarity; Maiko/Evelyn intimacy and present relationship state stay distinct. |
| Kerry Eurodyne | 102 | 13 | 13 | 17 | 8 | Independent music/family identity; Johnny influence is not his whole life; intimacy requires commitment. |
| Liam Northom | 141 | 4 | 1 | 5 | 1 | Concern versus control; medical rationale is his claim, not diagnosis or consent. |
| Life Coach | 102 | 2 | 1 | 1 | 0 | Sparse Corpo call; no invented clinical credentials, biometric access or universal prior client history. |
| Lina Malina | 112 | 3 | 1 | 8 | 0 | Ambitious performer, not Tool's identity; no automatic meeting, captivity or international stardom. |
| Lizzy Wizzy | 144 | 5 | 2 | 7 | 3 | Self-invention and art; no deterministic chrome diagnosis; investigation and later harm are conditional. |
| Mamá Welles | 78 | 7 | 3 | 7 | 3 | Hospitality, authority and family; grief and funeral are not preloaded into an earlier story. |
| Mark Bana | 130 | 3 | 1 | 4 | 0 | Pre-disappearance veteran interpretation; impostor speech is not proof of the real man's persona. |
| Meredith Stout | 97 | 5 | 2 | 5 | 1 | Executive with bounded incentives; optional encounter is not romance, survival or corporate clearance. |
| Misty Olszewski | 74 | 11 | 7 | 10 | 0 | Reflective care, not clinical/prophesying oracle; V familiarity should follow actual story context. |
| Mitch Anderson | 108 | 14 | 12 | 12 | 0 | Mechanic and veteran; Scorpion intimacy is not an asserted romance; war/death disclosures stay scoped. |
| Mr. Hands | 134 | 23 | 15 | 17 | 0 | Client discretion and private identity; Hansen succession is not a static baseline outcome. |
| Muamar Reyes | 108 | 19 | 17 | 15 | 2 | Profit and neighborhood concern coexist; Falco delivery and childhood testimony are separate. |
| Bes Isis | 94 | 6 | 4 | 9 | 1 | Bes Isis professional identity and reporting craft; no automatic publication of private memories. |
| Nele Springer | 143 | 3 | 2 | 6 | 1 | Attributed family/cause/chemistry context; later ambush does not determine fate or guilt. |
| Nix | 71 | 5 | 5 | 6 | 3 | Curious but experienced runner; corporate leak is private; historical artifact is not magic or omniscience. |
| Ozob Bozo | 71 | 3 | 2 | 3 | 1 | Brazilian mercenary, not cross-franchise clown; grenade is real danger; shared jobs require confirmation. |
| Paco Torres | 136 | 4 | 2 | 6 | 0 | Inexperienced recruit and embellished Deep Dive; Babs has her own fate and perspective. |
| Sebastian 'Padre' Ibarra | 99 | 16 | 14 | 12 | 1 | Faith-inflected local brokerage; ordination not invented; gang affiliation does not imply every alliance. |
| Panam Palmer | 147 | 19 | 16 | 24 | 4 | Independence and chosen family; no universal leadership/romance; Tower silence is not death proof. |
| Pepe Najarro | 74 | 7 | 3 | 6 | 3 | Family affection and worry; Cynthia pregnancy/body history require disclosure, not inference. |
| Placide | 98 | 5 | 3 | 9 | 1 | Community care and outsider exploitation; Brigitte's deeper strategy is not automatically his. |
| R3n0 | 138 | 4 | 1 | 5 | 0 | Seller/employee contrast; laptop identity provenance needs native corroboration before disclosure. |
| Rachel Casich | 140 | 5 | 4 | 7 | 2 | Commercial producer with distinct presentation; V participation and BD result are not assumed. |
| Regina Jones | 108 | 50 | 43 | 51 | 37 | Journalism and nonlethal program do not imply pacifism; reports are not medical cures. |
| NC Resident (female archetype) | 84 | 3 | 0 | 0 | 0 | Authored ambient template; profile-level durable memory is not a separate canonical pedestrian. |
| NC Resident (male archetype) | 92 | 3 | 0 | 0 | 0 | Authored ambient template; model/voice cannot prove age, occupation, origin or per-body durable memory. |
| River Ward | 117 | 10 | 10 | 19 | 3 | Investigation and family with limits; no invented ceremonies or possessive safety/romance. |
| Robert Wilson | 72 | 4 | 2 | 5 | 2 | Sparse craftsman/shop basis; no invented service record; competition/reward require separate observations. |
| Rogue Amendiares | 108 | 14 | 15 | 13 | 2 | Experienced fixer with private costs; son is not identified as Trace; era/model choice matters. |
| Sandra Dorsett | 111 | 4 | 3 | 12 | 1 | Agency and technical pride; Night Corp affiliation does not confer all corporate secrets. |
| Santiago | 134 | 7 | 3 | 2 | 0 | Explicit 2013 persona; later leadership/Trace history stays outside intrinsic model knowledge. |
| Saul Bright | 102 | 11 | 7 | 11 | 5 | One family, not the whole nation; policy, rescue, leadership and fate require separate conditions. |
| Sergei Karasinsky | 134 | 2 | 2 | 4 | 0 | Coercive captive transaction, not harmless comic; no invented detailed movie-reference assassin biography. |
| Shank | 120 | 4 | 1 | 4 | 0 | Limited Brainporium role; unused Nuka Ohlone alias is research-only, not self-introduction. |
| Solomon Reed | 162 | 14 | 15 | 14 | 3 | Duty and control tensions; train betrayal is private history; custody reports are not firsthand medicine. |
| Songbird | 159 | 11 | 14 | 14 | 4 | Personhood, competence and coercion; promises/cure capacity differ; fragments are subjective. |
| Spider Murphy | 149 | 5 | 2 | 2 | 0 | Era-bound runner; no confirmed Recluse identity or present-day access; sampled actor era still pending. |
| Steven Santos | 116 | 4 | 2 | 7 | 0 | Risk calculation is his position, not objective national interest; no unconfirmed BARGHEST aftermath. |
| T-Bug | 99 | 8 | 4 | 7 | 0 | Remote support limits and retirement aspiration; cinematic-trailer continuity excluded. |
| Takemura | 95 | 15 | 9 | 12 | 0 | Loyalty with concrete causes and food interests; ending condemnation does not establish suicide. |
| Thompson | 143 | 5 | 2 | 2 | 0 | Armed reporter archetype; wife's alleged murder is suspicion; historic chronology remains uncertain. |
| Viktor Vektor | 74 | 13 | 10 | 10 | 0 | Craft and boxing; no invented degree/age; Relic treatment and 2079 employment are conditional. |
| Wakako Okada | 105 | 16 | 13 | 12 | 2 | Transactional family/fixer basis; rumors are not husband-murder facts; client privacy remains scoped. |
| Yorinobu Arasaka | 99 | 7 | 5 | 3 | 0 | Private destructive purpose versus public heir image; no automatic partnership or thief viewpoint. |

## Source evidence and acquisition limits

- The authored dossier retains each source ID, URL, title, access date, exact locator and what was actually inspected. [Public acquisition receipts](../research/cyberpunk/PUBLIC_SOURCES.md) distinguish directly fetched pages from blocked pages and indexed excerpts.
- [Prior independent profile review](../research/cyberpunk/PROFILE_CROSS_REVIEW.md) and [city peer review](../research/cyberpunk/CITY_PROFILE_PEER_REVIEW.md) document resolved branch, historical-era and speaker-attribution mistakes. This audit inspected the resulting inputs rather than assuming those earlier green checks were sufficient.
- The user-supplied [Arasaka's Ronin transcript](https://arasakas-ronin.netlify.app/) is a community transcription with branch placeholders and omitted sections. Its presence supports selected delivery observations, not exhaustive dialogue or native variable semantics.
- [Official Update 2.1 notes](https://www.cyberpunk.net/en/news/49597/update-2-1-patch-notes) support replayable races as a feature; they do not provide Jim's detailed biography. [Official Update 2.0 notes](https://www.cyberpunk.net/en/news/49060/update-2-0) are used to avoid obsolete Spellbound cyberdeck prerequisites.
- [Official Edgerunners update](https://www.cyberpunk.net/en/news/45280/edgerunners-update-patch-1-6-list-of-changes) supports ownership of added gigs. [R. Talsorian's Collecting the Random](https://rtalsoriangames.com/wp-content/uploads/2022/07/RTG-CPR-DLC-CollectingtheRandom.pdf) supplies the Media/Solo archetype named for Thompson; it does not authenticate every allegation in his biography.
- Per-character indexed/community evidence is intentionally not relabeled primary. The runtime requires independent typed native conditions and audience rules before narrative outcomes become dynamic context.

## Reproducible development method

1. Capture the **source snapshot** before integrating concurrent edits. The ignored `runtime/character-knowledge-coverage-20261001/coverage.json` records each dossier SHA-256, field/count metrics, all findings' count basis and snapshot UTC time. It includes no keys, provider IDs or private conversation history.
2. Parse all 79 dossiers and eight quest maps. Call exported **pure** `validateResearch` and `buildProfiles` in memory; do not call `buildResearch`, which writes shared outputs. Compare the three generated fields and research revision to the roster.
3. Run the spoken-example serializer on every example. Distinguish paired research transcripts from exported utterances. Check exact duplicates across the whole cast, not only inside one file.
4. Read biographies, relationships, intrinsic/private/unknown knowledge and sample delivery in bounded batches. Track whether a claim is biography, attributed testimony, an authored performance choice, conditional outcome or explicit uncertainty.
5. Join decision/outcome IDs to the **compiled pack**, then intersect speaker permissions. Report source qualification separately from current-save, audience, disclosure and live acceptance. Do not count every rule mentioning a character as that character's own detailed quest history.
6. Trace active runtime imports for any privacy/identity promise. Historical prototypes and tests can describe policies no longer installed; a transient session key does not prove persistent-memory partitioning.
7. Ask the native casting lane for scene acquisition and canonical-record evidence when an actor alias is ambiguous. A WEM filename, matching voice tag or wiki name alone is insufficient.
8. Recommend source corrections to the root owner first. Keep generated outputs under one writer, preserve existing identities/model/voices, and checkpoint coherent changes locally after verification. This audit makes no cloud or memory mutation.

## Remaining qualification

- Recount the pack after the reviewed October 1 additions and provenance migration.
- Finish Bugbear voice/world binding and document the race/broadcast Jim distinction. Preserve the native-confirmed Bugbear record.
- Regenerate the corrected resident dossiers and update stale blanket unmapped notes. Verify generated fields and provider readback separately.
- Source and expand major-history/quest gaps without turning one-off NPCs into encyclopedias.
- Verify meaningful conversations and audience/quest regressions in actual gameplay. The all-profile schema pass is not acceptance of personality fidelity, memory recall or every native branch.


## Public intrinsic compiler integration — after the audit

The root authorized a bounded compiler extension using the newly reviewed Jackie/Johnny native claim packs. It is source-qualified and independently reviewed; root still owns the generated-profile build, API writes/readback and installation. This agent did not execute those actions.

| Subject | Included public topic claims | Added original samples | Exact pointer/attribution checks | Used native artifacts | Added topic characters |
| --- | ---: | ---: | ---: | ---: | ---: |
| jackie-welles | 18 | 10 | 903 | 10 | 5492 |
| johnny-silverhand | 12 | 6 | 330 | 12 | 3826 |

These are **30 intrinsic/attributed public claims**, not 30 newly resolved save outcomes or extracted provider memories. Jackie's eighteen claims add neighborhood identity, ambition, preferences, practical judgments and relationship texture; Johnny's twelve include bounded Mexico/corporate-army self-report, musician history, bandmate opinions and one explicitly subjective Santiago recollection. Detailed family trauma, war losses, trust-earned material and conditional V events are excluded from the universal static body. The full 536-word Jackie proposal was not imported.

### Verification and ownership

- `research/cyberpunk/scripts/intrinsic_character_claims.mjs` normalizes the two authoring schemas without rewriting them. It verifies recorded binary and JSON SHA256, pinned native serializer/game version, exact expected values or UTF-8 value hashes and typed native pointers. Evidence paths stay in the bounded local evidence roots.
- Every selected claim has a typed canonical codex subject binding, and scene evidence has complete actor-to-screenplay speaker attribution. An unrelated correct speaker cannot authorize another line. A bare codex identity cannot turn scene evidence into codex knowledge. Ordinary V, Johnny-possession and historical Johnny-replacer frames are distinct; the latter two need their exact reviewed player name, record and voicetag bindings.
- First-person speech, attributed testimony and represented subjective memories remain separate authoring modes. Source artifacts authenticate bytes and bindings; an independent semantic review still establishes what a paraphrase means. No software hash check independently proves every natural-language inference.
- The compiler rejects structured/unknown prerequisites, private/conditional/group-blocked material, and unqualified samples. Only original samples depending entirely on included public claims are added. Shared output guards still prohibit name prefixes and stage directions and preserve current-game authority.
- **25 focused tests pass**, including ordinary source-free fixtures, the existing research suite and the explicitly requested local source gate. The independent reviewer reproduced attribution/prerequisite/adoption defects, verified their corrections and found no further concrete defect in this scope.
- The check counts above cover only the selected static-public material. They do not replace the authors' separate whole-pack/private evidence qualification or prove private runtime disclosure behavior. That layer has a separate owner and pinned reviewed documents.

### Durable adoption during development

A fresh unadopted checkout does not require ignored native cache files. The first reviewed local adoption is explicit:

`node research/cyberpunk/scripts/build_research.mjs --intrinsic-claims --apply-profiles`

This builds **local** profile fields and persists `nativeIntrinsicProfiles` in `characters/profile-settings.json`; it does not call Convai. After adoption, the ordinary `Build-CharacterProfiles` path loads and verifies the required packs. Missing/stale artifacts reject the rebuild before generated profiles are replaced. Previous roster receipts also recover the required adoption set if the settings marker is missing. Previously adopted claim/sample IDs cannot silently disappear; a deliberate reviewed migration is needed for removals. Settings are persisted before replacing the adopted roster.

Default pure `buildProfiles` remains source-free; its optional `intrinsicPacks` argument is used for explicit source-qualified authoring. Runtime conversations do not reload these large native artifacts. No synthetic conversation, save predicate, API memory entry, character ID, model or voice assignment is created by this compiler.

Final authored file hashes at qualification:

- Jackie: `3818200ab7fcd8a5b87bff8829d302adaecfc957eb528b86dae9b6a780f69140`.
- Johnny: `25b1ab54131f9c32dcb0fb68730975fcfea682c209c7139c177438702656ce8c`.

The private-context owner has repinned those final documents. The ignored coverage receipt retains the selected claim/sample IDs and this compiler's qualification status. Root's earlier post-baseline paragraph and native-pack/live readback receipts above remain intact.

## October 3: River and Joss native event expansion

The latest local reviewed pack adds four guarded private event-history rules for River and Joss. River can discuss his explicit later Harris report after a failed rescue. Joss gets her own abandonment/loss report, gradual-recovery assessment and visit/game follow-up, with each statement restricted to the actual private recipient and speaker. Her family support cannot confer a River romance or reveal his private disclosures.

| Executable source coverage | Previous pack | October 3 local build |
| --- | ---: | ---: |
| Enabled rules | 191 | 195 |
| Researched outcomes | 1,160 | 1,160 |
| Outcomes with reviewed rules | 185 | 188 |
| Unmapped outcomes | 975 | 972 |
| Cited native artifacts | 397 | 402 |
| Verified, hash-bound pointers | 5,359 | 5,402 |
| Legacy-unbound pointers | 0 | 0 |

The eight new aliases select exact revealed native messages; positive rescue/completion facts provide the Harris and recovery stage guards. The existing rescued-Randy outcome gains Joss's perspective, while three other outcomes gain their first reviewed mapping. All four exclude group disclosure and unrelated speakers. See [the complete native review](../research/cyberpunk/native-reviews/river-joss-oct03.md) for activation paths, withheld outcomes, source receipts and negative checks.

This is source-qualified local research, with no provider mutation or installed rollout in this batch. The prior all-character dossier/public-intrinsic work is unchanged. Native aliases still need natural live-save acceptance; schema, exact hashes and resolver tests do not establish live personality or exhaustive decision coverage.

The follow-on [topic identity audit](../research/cyberpunk/native-reviews/topic-identity-audit-oct03.md) checked all 195 enabled links: 169 exact topics and 26 pinned reviewed aliases. Panam's compatible room/flirt facets and Jake's invitation/collection stages retain separate topics; a blanket normalization would create false conflicts. Undeclared or changed mappings, missing review documents, and future alternatives that bypass an existing native topic domain now reject compilation. The runtime resolver and existing topic IDs are unchanged.
