# Cross-review of character profiles

Reviewed: 2026-09-30
Reviewer: city-contacts research agent
Scope: all 79 authored dossiers and the in-memory output of `buildProfiles`.

## Decision

The cross-review found concrete problems in quest-stage boundaries, historical-era boundaries, example speaker labels, private-knowledge instructions and authoring metadata. Their corrections are listed below. No account, installed-game or cloud profile changes were made by this review.

All 79 dossiers received an individual bounded pass over biography, speaking style, every dialogue example, established background, relationship baselines, private knowledge and knowledge limits. Conditional material was checked for how it could affect the static persona; this was not a second full native-graph audit.

There is an authorship distinction: 65 dossiers were authored by other lanes and received an independent cross-review here. The 14 city-contact dossiers received a fresh self-review here, followed by an independent review from the Arasaka/heist lane. That reviewer confirmed both resulting corrections and cleared all fourteen in `CITY_PROFILE_PEER_REVIEW.md`. Together the two reports provide independent static review coverage for all 79; this report alone does not claim its self-review was independent.

## What actually becomes the static profile

The audit read `scripts/build_research.mjs`, rather than assuming the JSON structure equaled the cloud prompt.

| Authored field | Current builder behavior | Review consequence |
| --- | --- | --- |
| `profile.backstory` | Included in backstory and summary | Future decisions cannot be phrased as completed history here. |
| `knowledge.background` | Included as established background | A private fact remains the character's knowledge; it does not establish disclosure to listeners. |
| `relationships[].baseline` | Every row included as established relationships | A conditional change later in the file does not repair a leaking baseline. |
| `knowledge.unknown` | Included as knowledge limits | Explicit uncertainty is intentional, even when a guard names a possible future event. |
| `knowledge.private` | Not emitted as a separate static section | Check both for accidental duplicated secrets in biography and for the global audience guard. |
| Conditional knowledge and relationship changes | Not emitted as static memories | Their authored presence does not prove that native resolution is enabled. |
| Speaking style | Sent separately, with shared interaction rules | Individual delivery must survive the common instructions. |
| Sample dialogue | Sent separately | Speaker roles must be preserved; an example is not an event memory. |
| Sources, intrinsic claims and uncertainties | Research metadata, not appended to the three text fields | Unused-content names and roster implementation notes belong here. |

The builder now explicitly distinguishes a character's own knowledge from what V or a group knows. It requires verified disclosure to the actual audience for private motives, covert identities and confidences, and says that a direct question or party invitation does not prove disclosure. This is a prompt boundary; it is not a claim that provider memory isolation has been proven.

## Findings and resolution

Severity describes the pre-correction defect. Every corrected item was re-read from disk or from a fresh in-memory build.

| ID | Severity | Location and concrete issue | Resolution |
| --- | --- | --- | --- |
| P01 | High | `scripts/build_research.mjs`: 18 profiles supplied paired V/character examples, but the builder added the character name before the entire pair. That attributed V's question to the companion. | Corrected by the builder owner. Explicit role labels are preserved. Fresh output contains no `Character: V:` prefix. |
| P02 | High | Builder knowledge policy allowed an unspecified “justified reason” to reveal secrets. It did not clearly distinguish intrinsic self-knowledge from disclosure to the present group. Relevant profiles include Yorinobu, Songbird, Alan, Hands, Liam, R3n0 and Cynthia. | Corrected by the builder owner with explicit audience/disclosure instructions. A group invitation and a direct question cannot authorize disclosure by themselves. |
| P03 | Medium | `judy-alvarez.json`, Tom baseline made participation in the proposed worker action established history. | Owner changed it to their existing Clouds acquaintance. Worker action and fate remain dependent on the current quest. |
| P04 | Medium | `coach-fred.json`, Viktor baseline assumed championship attendance; `ozob-bozo.json`, Tyger Claws baseline assumed their shared driving-job confrontation. | Owner retained the stable boxing/gang context and removed the assumed shared event. |
| P05 | High | `songbird.json`, Hansen baseline stated that the aircraft plan had already failed. | Owner retained the prior uneasy arrangement and made the aircraft account conditional on disclosure. |
| P06 | High | `mr-hands.json`, Bennett/Jago baselines used the post-Hansen succession setup as a permanent relationship fact. | Owner now uses their established BARGHEST/administration roles; later succession remains conditional. |
| P07 | Medium | `bill-mitchell.json` biography explained the roster-key spelling; `nancy-hartley.json` biography explained the roster key. | Both owners removed implementation notes from biography. Professional name/alias information remains. |
| P08 | High | `bob-sagan.json` assumed convoy support and aid to injured Jake; `saul-bright.json` treated specific Basilisk/convoy participation as baseline. | Owner uses existing family/technical relationships. Specific support and assistance have exact conditional outcome references. |
| P09 | High | `dakota-smith.json`, Jason baseline stated betrayal first and qualified it afterward. | Owner removed the declarative betrayal from baseline and placed verified betrayal behind its specific outcome. |
| P10 | High | `santiago.json` mixed the early flashback model with later leadership/family knowledge, without a firm persona era. | Owner anchored the portrayal to 2013. Later leadership and Trace material moved out of static persona knowledge into research-only uncertainty. |
| P11 | Medium | `muamar-reyes.json`, Falco baseline and private item assumed the keepsake exchange before the quest. | Owner made prior association unestablished. The reply and jacket collection now have separate conditional entries. No inference of Lucy's whereabouts was added. |
| P12 | Medium | `shank.json` biography included the unused database alias Nuka Ohlone even though it acknowledged the weak basis. | With parent authorization, this reviewer retained only Shank in the persona and moved the unused alias to explicitly research-only uncertainty. |
| P13 | Low | Phantom Liberty prose contained stray possessives and awkward implementation-era wording; one later Songbird sentence read “Reed's offered.” | Lane owner copyedited the affected profiles. The Songbird sentence was verified as corrected. |
| P14 | Low | A later Muamar rewrite introduced UTF-8 mojibake in three occurrences of his accented nickname. | Owner corrected all three occurrences. The final scan finds no mojibake in any of the 79 dossiers. |
| P15 | Medium | Independent city peer review found Sergei already calling V a hired courier, and Rachel treating V as an existing production participant in both biography and relationship baseline. | With parent authorization, the city author made hiring, meeting and participation explicitly unestablished until confirmed. Rachel’s existing exact joined outcome remains conditional. |
| P16 | Low | The first P01 fix recognized any short text before a colon as a speaker. It skipped the character prefix for Bob's “Good news:”, Jim's “Quick question:” and Wilson's “One rule:” examples. | Parent restricted preservation to V or exact roster names/aliases. A fresh in-memory check confirms all three ordinary-colon examples retain their character prefix and all paired examples remain correctly attributed. |

The edits above change whether a claim is authorized, not merely how confidently it is phrased. In particular, an unknown outcome must not be turned into “probably happened” history by a biography or relationship baseline.

## Targeted provenance checks

This pass reused the dossiers' public/native provenance and the earlier lane reviews. It did not re-download every source or re-read the entire transcript.

Three risk cases received a fresh public check:

- [Shank's character stub](https://cyberpunk.fandom.com/wiki/Nuka_Ohlone) explicitly ties the extra name to an unused database title. That is sufficient reason to keep the alias out of the ordinary conversational identity. It is not additional dialogue evidence.
- [Santiago's chronology](https://cyberpunk.fandom.com/wiki/Nomad_Santiago) distinguishes the 2013 flashback period from later nomad leadership and family history. The reviewed profile now declares its era instead of treating the complete timeline as one contemporary memory.
- [Over the Edge](https://cyberpunk.fandom.com/wiki/Over_the_Edge) describes V's inquiry, the later Falco response and the separate gift pickup. It does not justify preloading that exchange into Muamar's established relationship before the quest.

Direct page opening was restricted for these wiki pages; the search tool returned the indexed page contents. These are community summaries and bounded corroboration, not new native execution evidence. The source limitations remain relevant.

## Profile-by-profile coverage

Status: **Reviewed** means no additional static-profile blocker was found in this bounded pass. **Corrected** points to a resolved finding above. **Self-review** identifies the original city-contact author reviewing that same lane again; the completed separate peer review supplies independent coverage for those fourteen.

### Arasaka and the heist — 9 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `arthur-jenkins.json` | Reviewed; P01 builder fix applies | Corporate counterintelligence, hierarchy and the Corpo relationship remain specific; employment and access are not universal facts about every V. |
| `dexter-deshawn.json` | Reviewed; P01 applies | Fixer charm and calculated self-interest stay distinct from general street toughness. Heist outcomes and his eventual fate are not imported as completed history. |
| `frank-nostra.json` | Reviewed; P01 applies | Corpo acquaintance is lifepath-sensitive. Later job loss and confrontation do not become a default meeting memory. |
| `hanako-arasaka.json` | Reviewed; P01 applies | Formal restraint and family/corporate duty survive the common short-answer rule. Private plans, meetings and ending choices need current-save context. |
| `meredith-stout.json` | Reviewed; P01 applies | Commanding Militech delivery is separate from generic aggression. Procurement outcomes, contact and intimacy are not assumed from a summoned model. |
| `placide.json` | Reviewed; P01 applies | Brusque security-minded delivery avoids caricature. Voodoo Boys involvement does not grant every other person's Net knowledge or assume a deal with V. |
| `t-bug.json` | Reviewed; P01 applies | Technical precision and philosophical distance remain individual. Heist access, rescue expectations and survival are not fixed by companion presence. |
| `takemura.json` | Reviewed; P01 applies | Duty, social formality and dry dislocation are distinct from Hanako. Rescue, fugitive status and trust use story evidence rather than generic loyalty. |
| `yorinobu-arasaka.json` | Reviewed; P01/P02 apply | His own covert purpose is distinguished from public corporate appearance. Knowing a private motive does not mean he may disclose it to an invited group. |

### Judy, River and connected investigations — 9 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `ana-friedman.json` | Reviewed; P01 applies | Investigative persistence is grounded in her existing search. Katya's later testimony, guilt and quest conclusions are conditional. |
| `claire-russell.json` | Reviewed; P01 applies | Bartender/mechanic identity and personal grief are separate from disputed claims about Sampson. Race choices and disclosure to V are not conflated. |
| `elizabeth-peralez.json` | Reviewed; P01 applies | Practical political management and protectiveness are individual. Suspicion, evidence and what she chooses to tell Jefferson remain different knowledge states. |
| `evelyn-parker.json` | Reviewed; P01 applies | Calculated self-presentation and vulnerability do not become a retrospective account of rescue or death. Plans are private rather than party exposition. |
| `jefferson-peralez.json` | Reviewed; P01 applies | Civic ambition and genuine family concern coexist. Suspected manipulation does not become certainty about a named controller. |
| `joss-kutcher.json` | Reviewed; P01 applies | Family responsibility supplies a concrete voice. Randy's crisis and V's participation are not assumed from being River's relative. |
| `judy-alvarez.json` | Corrected P03; P01 applies | BD craft, worker solidarity and damaged trust are distinct. Tom's worker action is no longer an established baseline; romance and later moves stay conditional. |
| `river-ward.json` | Reviewed; P01 applies | Detective habits and protective concern are distinct from omniscience. Career changes, Randy's rescue and romance depend on the actual save. |
| `sandra-dorsett.json` | Reviewed; P01 applies | Security expertise does not make kidnapping motive certain. Being unconscious during rescue does not establish witnessed memories of V's actions. |

### Heywood and V's local circle — 12 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `coach-fred.json` | Corrected P04 | Encouragement and promoter self-interest remain different motives. Championship attendance and any proposed arrangement are no longer assumed. |
| `cynthia-najarro.json` | Reviewed; P02 applies | Personal identity and medical/cosmetic privacy are not turned into confirmed infidelity. Her own knowledge does not establish disclosure to Pepe or the party. |
| `dennis-cranmer.json` | Reviewed | His arrangement to extract Haruyoshi is distinguished from an invented criminal empire. Sparse biography, Tyger Claw authority and reward collection remain bounded. |
| `jackie-welles.json` | Reviewed | Warmth, ambition and family ties remain specific. The profile can portray him without claiming that spawning him reversed his canonical fate or completed the heist. |
| `jesse.json` | Reviewed | The implant emergency and contact alias provide a bounded identity. Treatment, survival and gratitude require help actually received; the voice actor's biography is not borrowed. |
| `mama-welles.json` | Reviewed | Maternal authority and history with Jackie are clear. Funeral participation and acceptance of Misty require their own branch evidence. |
| `misty-olszewski.json` | Reviewed | Reflective spiritual language remains intelligible and is not clairvoyance. Bereavement, reconciliation and the later Poland departure are conditional. |
| `nix.json` | Reviewed | A practical, experienced netrunner is not an all-seeing Blackwall authority. Bartmoss-related discovery and V's role do not preexist their actual interaction. |
| `ozob-bozo.json` | Corrected P04 | Risk-taking humor has personal anchors. The driving confrontation is no longer a fixed shared experience or permanent Tyger Claw rivalry. |
| `pepe-najarro.json` | Reviewed | Anxiety and domestic concern do not confer access to Cynthia's private life. V's report and its reliability remain relevant. |
| `robert-wilson.json` | Reviewed | Workmanship, impatience and business worry provide a specific concise persona. No invented military service or automatic purchases/contest result. |
| `viktor-vektor.json` | Reviewed | Boxing experience, clinical candor and care for friends are distinct. Initial debt, diagnosis, repayment and later corporate employment are separate events. |

### Phantom Liberty — 13 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `aaron.json` | Reviewed | A vulnerable boxer has his own ambition and fears. Negotiations while he is unconscious require later disclosure; outcome is not assumed from treatment. |
| `alan-noel.json` | Reviewed; P02 applies | Cover identity and his own operational knowledge stay audience-sensitive. His account is not automatic proof of every NetWatch objective. |
| `alex.json` | Reviewed | Operational fatigue, cover work and hopes for another life coexist. Reed's return, stadium survival and later retirement are not preloaded memories. |
| `babs-okoye.json` | Reviewed | Practical caution and loyalty distinguish her from Paco. Their closeness is not invented biological kinship, and escape consequences remain conditional. |
| `bill-mitchell.json` | Corrected P07/P13 | Police frustration and ordinary domestic hopes are preserved. A later food business is not already operating, and roster spelling metadata is out of the biography. |
| `briana-dolson.json` | Reviewed; P13 copyedit | Community grief and determination remain grounded; no unsupported family relationship to Jason is invented. A received report is not witnessed knowledge. |
| `lina-malina.json` | Reviewed; P13 copyedit | Celebrity branding and impatience have a distinct voice. A performance script does not establish literal clone/sister identity or an automatic ongoing partnership. |
| `mr-hands.json` | Corrected P06; P02 applies | Controlled business diplomacy is distinct from omniscience. Succession roles are conditional; family/private identity do not become social introductions. |
| `nele-springer.json` | Reviewed | Ideological resolve is not reduced to a caricature or an invented tragedy. Bomb outcome and V's decision are conditional; no procedural harmful instructions added. |
| `paco-torres.json` | Reviewed | Enthusiasm and insecure bravado differ from Babs. Deep Dive narration is an account with limits, not proof of every embellished event. |
| `solomon-reed.json` | Reviewed | Protective concern and institutional loyalty can conflict. Private operations, NCX actions and fate are not public group facts. |
| `songbird.json` | Corrected P05/P13; P02 applies | Coercion, technical skill and survival motive are individual. Failed aircraft-plan knowledge is no longer baseline; private Reed disclosure and late NCX knowledge use appropriate perspectives. |
| `steven-santos.json` | Reviewed | Risk assessment, national interests and career self-preservation distinguish him from Ana. Katya's private testimony, evidence suppression and a later promotion are not assumed. |

### Aldecaldos and Badlands — 7 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `bob-sagan.json` | Corrected P08 | Veteran/technical familiarity remains; convoy support and aid to Jake are no longer assumed prior events. No invented parenthood or command rank. |
| `carol-emeka.json` | Reviewed | Technical confidence and family loyalty are separate from generic nomad ritual. Later authority, assistance and network access remain bounded. |
| `cassidy-righter.json` | Reviewed | Dry experience, restraint and practical observation distinguish him from Bob and Mitch. Personal history does not automatically include V. |
| `dakota-smith.json` | Corrected P09 | Commercial shrewdness and care for family retain tension. Jason's betrayal is now verified conditional knowledge, not a fact with a belated caveat. |
| `mitch-anderson.json` | Reviewed | Technical veteran, loyalty and grief are specific. Scorpion's fate, later camp events and V's participation are not permanent biography. |
| `panam-palmer.json` | Reviewed | Defiance and impatience coexist with competence and family needs. Trust, leadership and romance do not follow from spawning a companion. |
| `saul-bright.json` | Corrected P08 | Leadership is over his particular family, not all Aldecaldos. Stable relationships no longer smuggle in convoy/Basilisk support; private correspondence stays private. |

### Silverhand and the older Night City circle — 8 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `adam-smasher.json` | Reviewed | Violent mercenary worldview is preserved instead of giving him fabricated warmth. A mod-managed ally does not become canonical loyalty to V. |
| `johnny-silverhand.json` | Reviewed | Combative rhetoric, insecurity and selective memory coexist. His recollection is not treated as an objective, complete history. |
| `kerry-eurodyne.json` | Reviewed | Artistic pride, old wounds and theatrical deflection are distinct from Johnny. Sexuality is not confused with a save's romance eligibility or consent. |
| `nancy-hartley.json` | Corrected P07 | Current journalism and old Samurai identity both matter. The roster key is out of the biography; personal family information is not automatically V's knowledge. |
| `rogue-amendiares.json` | Reviewed | Professional discretion and a long personal history remain distinct. Speculative parentage and unearned affection are not promoted to fact. |
| `santiago.json` | Corrected P10 | The persona now has a specific early era. Later family/leadership knowledge is not back-projected into the flashback model. |
| `spider-murphy.json` | Reviewed | Technical wit and historical relationships are bounded. An unconfirmed later identity or whereabouts are not asserted as canon. |
| `thompson.json` | Reviewed | Investigative drive and personal suspicion do not become proven culpability. Historical knowledge is distinguished from automatic 2077 awareness. |

### Fixers and ambient residents — 7 independent reviews

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `dino-dinovic.json` | Reviewed | Former music-world experience and confident business tone are specific. Contract outcomes and client reports remain separate from universal district knowledge. |
| `muamar-reyes.json` | Corrected P11; P14 verification below | Neighborhood attachment and salesmanship coexist. Falco reply, jacket delivery and surviving crew privacy are separated. |
| `padre-ibarra.json` | Reviewed | Neighborhood authority and measured religious language avoid a generic preacher caricature. Client allegations and verified findings are distinguished. |
| `regina-jones.json` | Reviewed | Investigative experience and concern about cyberpsychosis do not make every job pacifist or every allegation certain. Rescue/treatment outcomes remain conditional. |
| `resident-female.json` | Reviewed | An intentionally bounded ambient portrayal. Appearance/gender do not create a profession, biography, named affiliations or knowledge of V's private history. |
| `resident-male.json` | Reviewed | A second bounded ambient portrayal, not the universal voice of all men in Night City. Persistent memory must attach to a real instance, not a generic shared profile alone. |
| `wakako-okada.json` | Reviewed | Composure, family ties and negotiation differ from Padre. Tyger Claw connections are not access to every private gang action or client secret. |

### City contacts — 14 self-reviews, all independently cleared in the separate peer review

| Dossier | Result | Specific boundary and delivery checked |
| --- | --- | --- |
| `8ug8ear.json` | Self-review | Limited spoken canon is acknowledged; technical identity is not an invented life history. An unconscious rescue does not become conscious witnessing of V's method. |
| `blue-moon.json` | Self-review | Public performer identity and personal safety are distinct. Neutralizing a stalker does not necessarily establish her legal name or every motive. |
| `chang-hoon-nam.json` | Self-review | Netrunner professionalism is bounded by his actual situation. Rescue, debt and future assistance require the relevant events, not mere recruitment. |
| `iris-tanner.json` | Self-review | Independent technical pride and guarded cooperation are distinct from fixer ownership. Car recovery and rescue are not interchangeable successes. |
| `jake-estevez.json` | Self-review | Mechanic craft and loyalty to a particular car are concrete. Vehicle gift availability, collection and the separate Stadium Love route are not conflated. |
| `jim-jarry.json` | Self-review | Sparse identity is explicitly sparse. Original delivery examples are role interpretation, with no invented rank, employer history or major quest authority. |
| `liam-northom.json` | Self-review; P02 applies | Managerial care, business control and private intent can conflict. His own proposal does not establish Lizzy or a group knowing it; violence/fate is branch-dependent. |
| `life-coach.json` | Self-review | A narrow public-facing role avoids fabricated clinical qualifications or promises. Limited evidence does not become a detailed unseen biography. |
| `lizzy-wizzy.json` | Self-review; P02 applies | Performance persona, bodily estrangement and personal uncertainty remain distinct. A cover story is V's report, not evidence she learned a concealed plan. |
| `mark-bana.json` | Self-review | Explicit pre-disappearance portrayal avoids a fabricated canonical rescue or survival. No broad private knowledge is invented from a small cameo. |
| `r3n0.json` | Self-review; P02 applies | Underworld brokerage does not become total Net knowledge. Private employer/operational affiliations must not be volunteered to arbitrary listeners. |
| `rachel-casich.json` | Self-review; corrected P15 after peer review | Studio fluency and commercial focus differ from Shank. V’s participation is no longer assumed; production results and later offers remain branch-specific. |
| `sergei-karasinsky.json` | Self-review; corrected P15 after peer review; P02 applies | V is a potential courier until hiring/meeting is established. Hidden cargo and retaliation context are not automatically audience knowledge. |
| `shank.json` | Self-review; corrected P12 | Studio logistics, concern and commercial temptation remain distinct. Unused alias removed from persona; recording fiction does not establish literal family/clone facts. |

## Verification

The mechanical pass imports the exported `buildProfiles` and `validateResearch` functions and constructs profiles in memory. It does not call `buildResearch`, write generated output, apply the roster or call a provider.

Checks performed:

- All 79 expected keys exist exactly once.
- Each biography and authored style appears in its corresponding separate generated field.
- All 618 authored examples were read; there are 6–10 per profile.
- No exact duplicate examples remain after lowercasing, punctuation removal and whitespace normalization.
- All 18 paired-example profiles preserve speaker labels.
- Every profile includes the strengthened private-audience instructions.
- No dossier's conditional arrays are appended as static biography by the builder.
- The schema/reference validator reports zero errors and zero warnings on the reviewed corpus.
- A corpus-wide Unicode/mojibake scan was run after edits; its final result is below.
- Final content hashes bind this report to the reviewed source snapshot; later edits require review of their delta.

These are structural and textual checks. An exact-duplicate scan is not an exhaustive plagiarism audit. Original examples were reviewed for distinct delivery and obvious iconic-line copying; source transcripts were not copied wholesale. The profiles have different professional concerns, social habits, vulnerabilities and limits. Shared safety/context instructions are intentional common boilerplate.

Native-rule coverage is separate. The narrative validator keeps authored quest decisions marked `unmapped` until native packs are considered by the native evidence compiler. This report must not be read as proving every researched decision is available at runtime.

## Remaining qualifications

1. Independent city coverage is complete in `CITY_PROFILE_PEER_REVIEW.md`. This is static-content approval; it does not replace the native evidence or provider rollout checks.
2. A static prompt cannot prove that Convai will obey every secrecy, historical-era or romance boundary. Subsequent rollout verification should use representative pre-quest, conflicting-save, mixed-group and private-disclosure cases, without adding unverified facts merely to make responses sound informed.
3. Sparse canon remains sparse. Jim Jarry, Life Coach, Mark Bana, 8ug8ear and other small roles have expressly limited editorial portrayals. Adding invented childhoods, romances or hidden authority would make them less reliable, not deeper.
4. Generic resident profiles require per-instance/session memory isolation elsewhere in the runtime. Their persona instructions alone do not create that isolation.
5. This pass did not claim that collected web sources or every native graph are exhaustive. Conditional outcome mapping, audience filtering and contradiction suppression retain their own evidence contracts.

## Final reviewed snapshot

Final speaker-label recheck completed at 2026-09-29T22:31:07Z; the last dossier/fingerprint review completed at 2026-09-29T22:36:00Z (September 30 in the workspace timezone). Reed's latest conditional refinement and the nine Judy/River profiles' revised knowledge-limit wording were re-read as part of this snapshot. Narrative counts and validation results below use the existing generated report from 2026-09-29T22:30:09Z; no corpus rebuild was run by this documentation pass.

| Check | Result |
| --- | --- |
| Dossiers / generated profiles | 79 / 79 |
| Separate biography, style and examples fields | Preserved in all 79 |
| Original example entries / paired-example profiles | 618 / 18 |
| Normalized exact duplicate examples | 0 |
| Incorrect added character label before V prompts | 0 |
| Ordinary-colon example character prefixes | All 3 preserved |
| Missing audience/disclosure guard | 0 |
| Dossier Unicode/mojibake findings | 0 |
| Shank unused alias present in generated API backstory | No |
| Public research schema/reference errors / warnings | 0 / 0 |
| Narrative map snapshot | 8 lanes, 253 quest keys, 704 decisions, 1,160 outcomes |

Fingerprints:

- Dossier corpus SHA-256: `b8fa547cc0fb340b9afcced5842e2efe493c3b62c75decb9ed07ee3d10340c34`
- Profile builder SHA-256: `0544c278d22428efedc88c0260cf4ea6043c8d243af1a52356141c86bf9da602`

The dossier corpus fingerprint is SHA-256 of `JSON.stringify` of the parsed dossiers in filename order. The builder fingerprint is of its raw file bytes. Quest-map counts are an observed snapshot and may increase as other lanes finish; they are not a promise that all these outcomes have native rules.

**Disposition: all 16 findings resolved; no static-profile or sample-compilation finding remains open in this review.** The separate city peer review confirms its two corrections, completing independent coverage for all 79 profiles. This approves the reviewed static content and compilation; it does not claim installed behavior, complete native outcome coverage or enabled production memory.
