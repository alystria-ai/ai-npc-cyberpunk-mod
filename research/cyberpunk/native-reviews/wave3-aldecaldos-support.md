# Wave 3: Saul, Mitch and Carol

Source review dated October 1, 2026, against installed Cyberpunk 2077 2.31.
The three files in `../native-character-proposals-wave3/` remain unadopted
authoring proposals. The coordinator owns adoption and the shared subject
qualification ledger.

| Character | Public claims | Excluded private / conditional | Original examples | Exact refs | Selected speech lines | Subtitle sources |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Saul Bright | 10 | 0 / 1 | 6 | 530 | 15 | 6 |
| Mitch Anderson | 10 | 0 / 0 | 6 | 316 | 8 | 3 |
| Carol Emeka | 11 | 1 / 0 | 6 | 515 | 14 | 5 |

These counts include source evidence for the excluded claims. Every original
example refers only to eligible public claims. `currentSaveQualified`,
`adopted`, `cloudWrites` and `memorySeeding` remain false.

## Knowledge and disclosure review

Saul's codex supplies the difficult circumstances of his leadership, the shift
from smuggling toward corporate connections, responsibility for his decisions,
and a stubborn, principled temperament. His authority is scoped to this family
within the Aldecaldos. His own speech supports concrete questions, a practical
triage metaphor, concern for the family's survival, stern but occasionally wry
delivery, and plain interpersonal concern. Those examples do not establish a
present corporate agreement, an imminent raid, rescue debts or V's membership.
His later admission that he was wrong and offer to lead alongside Panam remain
one explicitly conditional claim, excluded from universal material.

Mitch's codex supports Bright-family membership, the Free States side in the
Unification War, service with the panzerboys, later smuggling work, friendship
with Panam and respect within the family. His own brief recollection places
panzer service in Mexico. Repair dialogue supports patient testing and avoiding
needless disassembly; other lines support practical warmth and an expressed
belief that good jobs can rebuild the Aldecaldos' reputation. This creates no
rank, medal, exact campaign, current Basilisk ownership or experience shared
with V. Four samples were tightened to remove unsupported long hours/heat,
the suggestion that smuggling was free of gunfire, an ungrounded argument with
Panam, and an unnecessary preference for starting a repair over.

Carol's codex supplies her chosen family, corporate offers she declined,
the value she places on being needed, army training, leaving after her contract,
and the perspective gained on the road. Her judgment that the army resembled
a corporation stays attributed to her. Her own speech demonstrates concrete
knowledge of punched-card data storage, precise technical concern, familiar
teasing, a return to useful work, and earthy recollection of panzer discomfort.
These are bounded professional and delivery observations; they grant no
medical credential or proof that she treated this V. Her Maryland hometown,
age when leaving and unmentioned birth family remain a private codex claim.
The panzer example stays within her own heat/discomfort recollection and does
not imply that V remembers it.

## Native subject and speech chains

All three identities use typed `gameJournalCodexEntry` subjects with exact
localized title bindings. Their subject paths share the prefix
`/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data`.

| Character | Subject suffix | Native subject ID | English title entry |
| --- | --- | --- | --- |
| Saul | `/entries/23/Data/id` | `saul_bright` | `onscreens_final`, entry 15139 |
| Mitch | `/entries/32/Data/id` | `mitch` | `onscreens_final`, entry 15120 |
| Carol | `/entries/51/Data/id` | `carol_emeka` | `onscreens_final`, entry 56207 |

Every speech claim records a typed actor, exact actor ID and voice tag, matching
screenplay speaker/item, a cited emitted `scnDialogLineEvent`, and a selected
`en_us` descriptor/payload. The descriptor and payload variant IDs agree.
The matching shipped entry is typed `localizationPersistenceSubtitleEntry`,
with the same `stringId` and exact English variant content. Dialogue availability
does not qualify its event in the current save.

| Scene basename | Saul screenplay indices | Mitch screenplay indices | Carol screenplay indices |
| --- | --- | --- | --- |
| `sq027_03_saul_whistleblowing` | 2, 3, 21, 24, 25 | — | — |
| `q114_04b_party` | 93, 100, 106 | — | 15, 72, 144 |
| `q114_04_initiation` | 60, 65 | — | — |
| `sq027_09_new_camp_wakeup` | 69, 72, 91 | 79, 81 | — |
| `sq027_08_camp_saved` | 7, 10, conditional | — | — |
| `sq027_04a_camping` | — | 14, 15, 18 | 20 |
| `sq027_04_preparations_mitch_bob` | — | 2, 4, 22 | — |
| `sq027_04_preparations_carol` | — | — | 0, 10, 11, 15, 17, 18 |
| `q114_03c_dakota_trailer` | — | — | 17, 19, 26, 53 |

Carol's trailer line **53** is the actual emitted duplicate. Unused screenplay
line **30** is excluded. Base-party and EP1-party-overlay subtitle tables are
separate native resources; both match the selected six party lines. Neither
table is relabeled as the other table's depot winner.

## Verification

Five existing pinned subtitle exports from the Bob/Cassidy/Dakota lane were
reused after hash checks. Five exact additional subtitle resources were exported
and serialized with pinned WolvenKit 9.0.1: initiation, whistleblowing, Carol's
preparations, camp saved and new-camp wake-up. Their decoded total is **32,064
bytes**. Extraction used the shared two-slot CPU gate and isolated output.

The local source pass checked all **1,361 references across 33 claims**, including
private/conditional material, and all **37 actor-to-emitted-speech joins**.
All **21 unique source assets** passed raw SHA-256, archive-entry SHA-1, JSON
SHA-256, serializer version/game version and serialization source-path checks.
Current installed archive directory winners and depot hashes were verified
independently. A raw CR2W subtitle parser checked **43 same-ID English joins**;
the six additional joins are the party overlay's matching entries.

The read-only compiler accepted **31 public claims and 18 examples**, reporting
**1,516 verification checks**. It rejected only
`saul.conditional.co-leadership` and `carol.private.early-life`, each with reason
`not-universal-public-topic`. The tested compiler SHA-256 was
`f4912101843a489887cb0cfd0523ccc42007207f6d6885b9eb90e971ea6b1118`.

Ignored evidence and runnable verification helpers are in
`runtime/voice-cast/aldecaldos/wave3-support-finish/`:
`verification.json`, `installed-verification.json`,
`compiler-verification.json`, `subtitles/sources.json`, `finish_support.py`,
`verify_installed.py` and `verify_compiler.mjs`.

This pass changed the three proposals and this review. It did not change shared
compiler/roster/build files, cloud profiles, audio, installed game files or
persistent memories, and it is not an in-game qualification.
