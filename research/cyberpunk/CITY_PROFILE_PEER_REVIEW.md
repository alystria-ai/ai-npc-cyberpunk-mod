# City profile independent peer review

Date: 2026-09-30
Reviewer: lore_arasaka_heist
Author reviewed: lore_city_contacts
Scope: all fourteen city-contact dossiers, their conditional outcome references,
and the actual profile compilation path in scripts/build_research.mjs.

## Decision

Both static relationship findings below have been corrected by the city author
and independently re-read. All fourteen profiles are clear from this scoped
static review, with no outstanding blocking findings.

This is an independent static review of the current authored material and its
cited provenance, not a new exhaustive public-source crawl or a claim of model
behavior in a live conversation. No production profile or cloud record was
changed by the reviewer.

## Findings

### CITY-P1 — Sergei assumes that V has already been hired

Severity: P2
File: dossiers/sergei-karasinsky.json
Location: relationships entry withKey=V, baseline

The baseline calls V a hired courier. The compiler unconditionally includes
relationship baselines under ESTABLISHED RELATIONSHIPS. A companion summoned
before Olive Branch contact can therefore receive a claim that hiring has
already occurred, despite the general current-save guard.

Requested correction: describe V as a potential courier until the actual
meeting/hiring is established. Retain the conditional delivery/release and
told-by-v aftermath boundaries.

Status: resolved and verified. The current baseline calls V a potential courier
and explicitly leaves hiring and any prior meeting unestablished until the
current save or a verified conversation confirms them. The conditional aftermath
and disclosure boundaries remain intact.

### CITY-P2 — Rachel assumes V has entered Joshua's project

Severity: P2
File: dossiers/rachel-casich.json
Locations: profile.backstory; relationships entry withKey=V, baseline

The biography says Rachel is navigating V's disruptive influence, while the
baseline calls V an unpredictable participant. Both are compiled as established
background before city-contacts.rachel.sinnerman-entry / joined qualifies.
The conditional entry is correctly authored elsewhere but cannot remove that
unconditional implication.

Requested correction: keep the planned production and Rachel's professional
concerns; make V's involvement and resulting influence conditional on the
actual introduction/joining event. The baseline can describe how Rachel would
evaluate a potential participant.

Status: resolved and verified. The biography now describes supervision and
scheduling, then explicitly requires V's actual current-save involvement before
attributing participation or influence. The V baseline now says potential
participant. The existing sinnerman-entry / joined conditional remains intact.

## All fourteen profiles inspected

| Profile | Review result and specific boundary |
| --- | --- |
| 8ug8ear | Pass. Editorial speaking voice is expressly labeled because the rescue primarily supplies screen messages. The Kiroshi/Tyger predicament is a quest premise, not a completed rescue. Legal name and cargo secrets are private; unconscious transport cannot become a remembered conversation. |
| Blue Moon | Pass. Promotional poetry/sweetness is presented as public image. No automatic romance or collaboration. Stalker identity requires disclosure; wrong reassurance and later death are preserved as separate possibilities. |
| Lizzy Wizzy | Pass. Public conversion/performance history is separate from Liam investigation and later violence. Her diagnosis is not invented. Undisclosed Arasaka negotiations, body disposal and later artwork are gated or private. |
| Iris Tanner | Pass. Technical pride and fixer friction give a distinct voice. Tribe, degree, romance and prior friendship are not invented. Rescue and equipment recovery remain separate. |
| Jake Estevez | Pass. Vehicle skill and poor social judgment are distinguished. Private personal entanglement does not imply V knows it. Pickup return, later gift offer and actual collection are separate events. |
| Chang-Hoon Nam | Pass. Experience replaces disputed age. Dante correspondence remains private. Recovery, MaxTac engagement, successful data delivery with injury, and proposed departure are separate. Aphasia is conditional and handled without comic caricature. |
| Jim Jarry | Pass. Limited race-organizer function is stated honestly; no fabricated childhood, driver career, gang or family. Editorial samples are role interpretation. Run-specific results cannot become an invented lifetime scorecard. |
| Liam Northom | Pass. Covert proposal is his own private knowledge, not Lizzy's or V's automatic knowledge. Motives are his rationale, not a clinical diagnosis or proof the proposed technology worked. No posthumous eyewitness memories. |
| Life Coach | Pass. Narrow Corpo-call role; no invented name, clinical credential, spiritual order or monk identity. No current biometric access, treatment powers or prior shared call from a manager summon. |
| Mark Bana | Pass. Explicit historical pre-disappearance portrayal. Impersonator dialogue is not used as his personality evidence. His private career/family are bounded; later outcomes require attributed reports, not resurrection or firsthand recollection. |
| R3n0 | Pass. Clarity/Hard Wire information is expressly private laptop-derived background. Transaction outcomes are conditional. Nix's later discoveries and unobserved theft are outside her automatic knowledge. |
| Rachel Casich | Pass after CITY-P2 correction. The producer voice is distinct from Shank; private project calculations, V's unspoken motives, cumulative outcome quality and later Brainporium business are bounded. |
| Sergei Karasinsky | Pass after CITY-P1 correction. His captive is treated as a person and a private plan; release/delivery reports and later bodies do not become firsthand knowledge or guaranteed safety. The movie reference is not fictional biography. |
| Shank | Pass. Current static bio uses Shank only. The unused Nuka Ohlone name is retained in research uncertainty, not conversational self-introduction. Sparse shop biography is bounded; scripts do not establish real cloning, sibling kinship or medical expertise. |

## Privacy was checked through the compiler

The review inspected buildProfiles rather than treating the dossier's private
array as an automatic runtime guarantee.

The compiler adds a shared rule that background is the character's own knowledge,
not evidence that V or other listeners know the secret. It requires verified
disclosure to the actual audience and explicitly says that a direct question or
group invitation alone does not establish it. The speaking-style output also
prohibits revealing private conversation history to a group.

This makes the following retained own-background material acceptable in the
current compiled profile design:

- Liam's covert Arasaka proposal.
- R3n0's real identity, employment and off-books sale.
- Sergei's abduction plan.
- 8ug8ear's legal name and cargo arrangement.
- Jake's personal entanglement and Nam's correspondence.

Lizzy's profile does not receive Liam's undisclosed plan as her known history.
Its unknown list names that boundary. The native/dynamic layer still has to
respect the separate outcome and disclosure receipts; no static review can
prove future generative compliance.

## Sparse canon and example dialogue

Jim Jarry, Life Coach, Mark Bana and 8ug8ear explicitly distinguish documented
role from an authored companion performance. Their samples do not purport to
be recovered game lines. Mark's apparent later contact is identity-sensitive,
so the profile correctly avoids treating it as his own spoken evidence.

All fourteen profiles have at least six original examples. The sample set has
108 entries and no duplicated full sample string across these profiles.
Voice direction distinguishes bright/public-facing Blue Moon, conceptual Lizzy,
managerial Liam, transactional R3n0, practical Iris, brash Jake, deliberate Nam,
race-organizer Jim, procedural Life Coach, operational Bana, evasive Sergei,
studio Rachel, shop-scale Shank and sparse-voiced 8ug8ear.

Samples describe possible delivery rather than established memories. The
compiler preserves that distinction. No new accent, family, hidden operation,
romance or successful game action should be inferred from sample phrasing.

## Structural audit

A read-only check of all fourteen files found:

- 14 valid dossiers.
- 108 sample entries, each profile meeting the minimum.
- 96 conditional knowledge/relationship references.
- Every reference has an existing decision, exact outcome key and matching
  quest key in the current quest-map collection.
- Every referenced conditional source ID exists in its dossier.
- No duplicate full sample strings.
- Zero structural errors.

The check is narrower than native rule qualification: it verifies authored
references, not a quest flag's game semantics.

## Correction verification

The author's focused changes to CITY-P1 and CITY-P2 were independently re-read
on 2026-09-30. Sergei's relationship baseline now establishes neither hiring nor
a prior meeting. Rachel's biography and V baseline now require actual
current-save involvement; her existing exact joined outcome remains the point
at which the authored profile can recall entry into Joshua's journey.

The bounded reference audit was rerun after these changes: fourteen valid
dossiers, 108 examples, 96 conditional references, no duplicate sample strings,
and zero errors. Both findings are resolved; no static blocker remains in this
fourteen-profile lane.

No additional public crawl was needed for these two defects: the contradiction
was between a static baseline and its existing conditional entry in this
repository. This clearance does not claim live conversation behavior or cloud
application, neither of which this reviewer performed.
