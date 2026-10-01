# Wave 3: Dennis Cranmer, Jake Estevez and Liam Northom

Reviewed October 1, 2026 against installed Cyberpunk 2077 2.31 resources. These are **authoring proposals with explicit subject-attribution holds**, not adopted profiles or evidence of events in the running save. No cloud, memory, game-state, GPU, global-build or Git action was performed by this lane.

## Deliverables and scope

| Subject | Public proposals | Private proposals | Conditional proposals | Original examples | Exact references |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Dennis Cranmer](../native-character-proposals-wave3/dennis-cranmer.json) | 5 | 1 | 2 | 4 | 273 |
| [Jake Estevez](../native-character-proposals-wave3/jake-estevez.json) | 5 | 1 | 2 | 3 | 226 |
| [Liam Northom](../native-character-proposals-wave3/liam-northom.json) | 3 | 3 | 1 | 3 | 269 |

The 13 public propositions describe supported work, values or delivery. They do not inflate limited appearances into lengthy invented biographies. Private and current-save material is kept outside public profile eligibility. The ten examples are original, short spoken lines with no name prefixes; they depend only on public propositions. Automatic follow-up questions are not introduced by these samples.

## Actual subject identity

All three have individual `gameJournalContact` entries; none has an individual codex in the inspected winning cooked journal. The actual journal subjects are preserved. No codex, ID, spelling or roster alias was fabricated.

Journal prefix: `/Data/RootChunk/entry/Data/entries/3/Data/entries/`.

| Character | Contact object suffix | Actual contact ID | Name LocKey | Exact installed English index/name |
| --- | --- | --- | --- | --- |
| Dennis | `137/Data` | `darryl` | `10727` | `7019`: Dennis Cranmer |
| Jake | `78/Data` | `jake_estevez` | `13987` | `9945`: Jake Estevez |
| Liam | `49/Data` | `liam` | `19259` | `14372`: Liam Northom |

Every claim contains exact `/id`, `/$type`, `/name/value`, English entry type, primary key and name-variant references. Each subject reference has `kind: journal-contact`. Exact hashes are retained on every source/ref and in each proposal's immutable `nativeSources` table.

## Speaker and evidence contracts

The proof chain for spoken material is the typed native actor and acquisition fields → actor ID → screenplay speaker ID → screenplay item ID → emitted `scnDialogLineEvent` → native voicetag → `en_us` embedded descriptor/payload → same-ID shipped English subtitle. Choice captions and lines without emitted events are not treated as spoken reports.

| Native scene | Subject actor | Native voice | Qualification limit |
| --- | --- | --- | --- |
| `mq038_01_briefing` | `actors/0`: Darryl | `1624173162010259552` | Generic actor; actual community acquisition still needs reviewed external world binding. |
| `mq038_02_ending` | `actors/1`: Darryl | `1624173162010259552` | Surgeon explicitly names Dennis, but this is not independently the world-registry edge. |
| `sts_hey_gle_06_scene` | `actors/4`: Estevez | `1624173162010261132` | `findInWorld` points to `#gle_06_com_jake`; matching community filename/record alone is insufficient. |
| `mq019_04_manager` | `actors/0`: Liam | `1624173162010259524` | Named speaker and contact match; coordinator must qualify the actual subject/actor branch. |
| `mq019_01_notell_motel` | `actors/0`: Lizzy_Wizzy | Exact source voicetag retained per ref | Third-party testimony explicitly names Liam Northom, then identifies him as her manager. |

The cached community receipts contain canonical records `Character.mq038_darryl`, `Character.sts_hey_gle_06_jake` and `Character.mq019_liam`. They do **not** by themselves prove that the scene's external world NodeRef resolves to that community resource. The proposals consequently retain `held-native-actor-subject-qualification`, and claims remain `awaiting-native-subject-binding` until coordinator review. No `bindingVerified: true` was inferred from co-occurrence.

Dennis's generic native alias gets an additional semantic chain: Haruyoshi's emitted speech names Dennis as the person who gave him hope and saved him, while Darryl addresses that speaker as Haruyoshi. This narrows the person but does not manufacture a missing world-node registry mapping.

## Character-specific findings

### Dennis

The introduction shows direct contracting, impatience with intermediary fees, staged delivery instructions and terse price negotiations. This supports an economical, transactional portrayal. It does not establish a criminal empire, a gang rank, a medical profession, family or age.

Haruyoshi's surgeon credentials, escape and claim of deliberately killing a Tyger Claw boss stay attributed to **Haruyoshi**. Dennis does not inherit them. Praise for V belongs to an actual completed delivery; the offered blade and its inventory acquisition remain separate. A summon is neither quest completion nor payment.

### Jake

The car-return dialogue supports attachment to the build, continuing improvements, distrust of people compared with machines, and his own recollection of advice from an Uncle Estevez. The Uncle's existence and advice are represented as Jake's reported recollection; there is no invented uncle occupation or criminal history.

A different emitted garage discussion explicitly names Jake and credits him for vehicle software, calibration and technical contacts. It is retained as third-party support for actual work, not an invented degree, universal expertise or proof Jake knows he was discussed. The same-source garage commentary does not create V's personal history with him.

Car return, the later Quadra offer and actual collection remain separate. Existing `city-native.jake-pickup-returned`, `city-native.jake-gift-offered` and `city-native.jake-gift-collected` gates retain responsibility for those events. The static profile contains no gifted-car memory, stealth/violence route, invented racing title or guaranteed Sacramento sale. The departure line's “today” is attached to its ending context rather than reused permanently.

### Liam

Lizzy's explicit introduction establishes his manager role. His meeting dialogue supports privacy, defensiveness and hesitant transactional phrasing. These are bounded delivery cues; they do not require hostility or a bribe in every conversation.

The relationship, fears about Lizzy's conversion and covert personality-backup/alteration proposal remain private, appropriately contextualized material. His stated symptoms are not a diagnosis, proof of cyberware causation or informed consent. An intended backup is not a completed engram. A bribe offer is not acceptance. Liam cannot gain knowledge of V's private report, posthumous disposal or later art merely because the player summons him.

## Source authentication and English variants

Three freshly pinned scene serializations were exported into the lane's isolated `intrinsic-gig-contacts-wave3` batch. Jake's existing finalized `native-bindings-oct01` export and Liam's finalized `city-contacts-authenticated-oct01` export are reused only after their recorded binary and JSON SHA256 values pass. Six exact original shipped subtitle resources were freshly serialized in the lane's isolated `history-gig-contacts-wave3/subtitles` directory. Both installed English archive SHA256 values were rechecked against the localization inventory before copying original resources; no old unbound JSON was retroactively blessed by simply hashing it.

Some shipped captions differ slightly from embedded spoken wording. The exact same-ID versions are both preserved, not rewritten or loosely merged. Inspected differences are Jake lines 0/3/4/7/8/17 (added “I,” contractions, punctuation) and Liam meeting line 8 (“make” versus “made”). They do not change the retained proposition, but the discrepancy remains visible in exact expected-value refs. No arbitrary text mismatch is automatically accepted.

The source loops verify actor-to-speaker IDs, event item IDs, descriptor-to-payload variant IDs and subtitle locstring IDs before writing. Proposals are outside the adopted source folder. Source authenticity, coordinator identity qualification, current-save admission and runtime deployment are separate states.
