# Wave 3 held identity resolution

Reviewed 2026-10-01 against installed Cyberpunk 2077 2.31 native sources. This is an independent identity review for the nine rows held in `runtime/verification/wave3-compiler-checkpoint.json`. It changes no proposal, compiler, trusted subject ledger, roster, adopted pack, cloud profile, memory, voice, GPU or running game.

## Result

The native material supports the signed-document route for 8ug8ear and five **source-specific narrative alias proposals** for parent review. The parent's live read-only R3n0 diagnostic also supplies the missing property value, with explicit runtime provenance. These proposals identify characters in the authored scenes. They do not claim to resolve a world NodeRef to a canonical community or record.

| Held row | New review result | Remaining qualification |
| --- | --- | --- |
| 8ug8ear | Actual typed native essay signed by the exact contact name | Narrow authored-document compiler support and parent semantic review |
| Coach Fred | Direct emitted address to Fred and response by `fistfight_human`; exact acquisition continuity to vendor actor | Explicit reviewed aliases for those source hashes; canonical world record still unverified |
| Pepe Najarro | Fresh prologue exchange addresses `bartender` as Pepe; exact bar acquisition continuity | Explicit reviewed aliases; separate phone actor identified independently |
| Cynthia Najarro | Direct vocative identifies `Wife`; phone actor explicitly self-identifies as Cynthia | Explicit reviewed aliases; private disclosures remain excluded |
| Dennis Cranmer | Fresh named Dennis call transition; `Darryl` receives a contextual reply naming Dennis | Explicit semantic review of the narrative alias bridge; no world registry claim |
| Liam Northom | Direct named address and immediate `Liam` reply, plus Lizzy's explicit full-name testimony | Explicit reviewed alias/witness receipts; private material remains excluded |
| Jake Estevez | No decisive direct identification of the speaking actor found | Keep the speaking actor identity hold |
| Life Coach | Same speaking actor points to initializer whose typed caller is `contacts/coach` | A narrow authored contact-role route can be reviewed; canonical record and Brian Gustav name remain unqualified |
| R3n0 | Actual live displayName and fullDisplayName both resolve to LocKey 32025, English R3N0 | Parent admission through an explicitly reviewed live-property provenance route |

No proposal is promoted by this document. Five alias candidates are Fred, Pepe, Cynthia, Dennis and Liam; Dennis's contextual bridge is expressly distinguished from the direct vocative/self-introduction cases. The Life Coach contact route is additional evidence for review, not a sixth approved alias.

## Evidence package and checks

The isolated review packet is:

- `runtime/voice-cast/minor-generic/held-identity-resolution/identity-receipts.json`: nine findings, **390 exact identity references**, source table for 34 native raw/JSON pairs, actual speaker/item/emitted-event joins, English descriptor/payload IDs and same-ID shipped subtitles.
- `runtime/voice-cast/minor-generic/held-identity-resolution/authentication.json`: **1,568 proposal references** checked, including exact values or declared UTF-8 value hashes; proposal SHA256 values; 32 reused/fresh scene and source pairs plus two fresh subtitle serializations. Current installed base/EP1 winning archive rows, depot FNV64, archive-entry SHA1, raw size/SHA256, JSON SHA256, recorded inventory hashes, and native serializer/game versions were checked.
- `runtime/voice-cast/minor-generic/held-identity-resolution/inspection.json`: full actor/acquisition summaries and emitted English line index for the bounded inspected scenes.
- `runtime/voice-cast/minor-generic/held-identity-resolution/live-property-review.json`: independent review of the parent's actual R3n0 diagnostic, exact diagnostic hashes/pointers, read-only query-code snapshot, CRC32/length record-ID check, and independent hashes for the two installed TweakDB files. This is labeled runtime evidence separately from the 34 native source pairs.
- Reproduction: owned `inspect.py`, `authenticate.py`, and `build_packet.py` in that folder. They write only the isolated evidence folder. Archive/serialization work uses `Cast-SceneEvidence.py`'s shared two-slot CPU gate, pinned WolvenKit 9.0.1 and one .NET processor per serialization process.

Three exact scenes were freshly exported, totaling **838,981 decoded native bytes**:

1. `held-identity-narrative-oct01`: `mq038_01b_fisher_village.scene` and `q000_kid_01a_bar_activities.scene` (235,652 bytes together).
2. `held-pepe-named-oct01`: `q000_kid_01b_meet_your_fixer.scene` (603,329 bytes).

The bar-activities export had no decisive Pepe identity exchange; it is retained as a negative result. It is not cited as proof. The two useful new scenes' English subtitle raw resources were matched to their current winning native archive rows and freshly serialized in `held-identity-resolution/subtitles/`.

All proposed named identity exchanges have at least one **literal same-ID embedded/shipped English match**. Jake's held Uncle Estevez line retains its actual differing English variants. There is no punctuation or spelling normalization rule, fabricated codex, unused choice caption promoted to speech, or zero-valued inactive record promoted to active acquisition.

**World registry edges verified: zero.** Existing community matches and cached quest-phase references were inspected as leads. Repeating a NodeRef in a quest phase, finding a similarly named community containing the expected record, or matching a shared voice does not supply the missing NodeRef-to-resource edge. No broad world-sector payload extraction was performed.

## 8ug8ear: authored native essay

The winning cooked journal's contact is typed `gameJournalContact`, ID `8ug8ear`, at `/Data/RootChunk/entry/Data/entries/3/Data/entries/135/Data`. Its `name/value` is `LocKey#10546`; installed English entry 6851 resolves that key to `8ug8ear`.

The essay is a real `gameJournalOnscreen`, ID `generic_guide_net`, at:

`/Data/RootChunk/entry/Data/entries/7/Data/entries/0/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/4/Data`

Its title is `LocKey#7270`; installed English entry 3788 contains **Blaming Bartmoss**, explicitly signed **by 8ug8ear**. Its description is `LocKey#7269`, resolved by English entry 3787. The exact contact, typed document, both LocKeys, both English keys, title/signature and essay content are in the packet.

This supports the four proposals as her **written outlook and written delivery**: imagined old-Net risk/opportunity, the cost she attributes to Bartmoss, resentment of NetWatch control, and concrete irreverent comparisons. The opening explicitly says she imagines the old Net. It does not establish firsthand pre-crash experience, authoritative technical history, Blackwall access, a distinctive spoken accent or biography from the generic default actor. No orphan localized codex string is used.

The existing hold is an integration limitation. A narrow authored-document branch can preserve the actual evidence kind. A speech/codex branch should not be used to evade it.

## Fred: direct name and response

In `q001_02a_fistfight_tutorial.scene`, emitted screenplay line 15 is the actual Player actor asking **Where'd you get 'im, Fred?** Line 16 is `fistfight_human` answering the question.

- Actor: `/Data/RootChunk/actors/1`; voice `1624173162010259556`.
- Line 15 native ID: `2231923009650704384`; event `/Data/RootChunk/sceneGraph/Data/graph/69/Data/events/0/Data`, starts 0, duration 1595.
- Line 16 native ID: `2231923635625410560`; event `/Data/RootChunk/sceneGraph/Data/graph/69/Data/events/1/Data`, starts 1627, duration 10165.

The adjacent events in the same native section establish who is being addressed. This is stronger than locating a Fred contact near a generic actor.

The vendor scene's `wat_lch_melee_01` actor and tutorial's `fistfight_human` have identical **active** `scnSpawnSetParams`: entry `wat_lch_melee_01`, reference `#wat_lch_melee_01`, and the same force-visibility value. The packet verifies both parameter objects and voices exactly. This supports an explicit reviewed continuity alias for those two authenticated scenes; it does not prove that this NodeRef resolves to `Character.wat_lch_melee_01` in the world registry.

## Pepe: fresh prologue exchange and separate phone identity

The fresh `q000_kid_01b_meet_your_fixer.scene` has `bartender` at actor 1, voice `1624173162027037464`.

- Line 32: bartender asks who mugged V.
- Line 33: the Player directly addresses **Pepe** in the reply, native ID `1822690001384566784`.
- Line 34: bartender immediately responds, addressing **V**, native ID `1926933095683911680`.
- Their events are in the same native graph section 14, respectively events 35, 38 and 45; start times are 12726, 15262 and 21432.

That is a direct identity exchange. Its `bartender` active spawn-set object is identical to held `mq040_01_bar.scene` actor 3 `El_Coyote_Barman`: entry `elcoyote_barman`, reference `#elcoyote_barman`, force visibility 0. The packet verifies the exact acquisition continuity.

The `mq040_03_ripperdoc.scene` actor 4 is a **separate phone acquisition**, entry `pepe_holo`, reference `#pepe_holo`. It is independently addressed as Pepe: line 33 asks what now, Player line 34 directly names Pepe, and the actor replies at line 35 in graph section 16. This phone actor is not falsely reported as having the bar spawn-set. Neither route resolves a world canonical record.

The identity evidence does not make debts, quest acceptance, marital suspicions, outcomes, payments, or the player's local history universal biography.

## Cynthia: in-person vocative and explicit phone introduction

In the authenticated `mq040_03_ripperdoc.scene`:

- `Wife`, actor 1, voice `1630226362467385344`, emits line 4 on discovering the intruder.
- `Ripperdoc`, actor 2, directly responds **Cynthia** in emitted line 5, native ID `1805710631159083008`. Both are in graph section 4; events 3 and 6 start at 0 and 3136.
- `Wife_phonecall`, actor 6, explicitly introduces herself as **Cynthia, Pepe's wife** at lines 42 and 45, native IDs `1816909127090319360` and `1816909362759872512`. These are emitted events in the two alternate call branches, not a claim that both happened to the player.

The in-person and phone actors each have direct textual identity evidence. The shared voice is supporting consistency only. The actual contact `rachel_joestar_mq040` resolves to Cynthia; it is not Rachel Casich. These exact narrative aliases can be reviewed without declaring `#mq040_com_apartment` world binding verified.

The private appearance disclosure, pregnancy and marital outcomes remain private/conditional. Identity proof does not grant the player or other companions knowledge of them.

## Dennis: explicit call identity and contextual Darryl bridge

The fresh `mq038_01b_fisher_village.scene` provides native `Denis`, actor 4, voice `1624173162010259552`, acquired through `dennis_holo/#dennis_holo`.

Player line 2, native ID `1883463148254842880`, says **Let's hear what Dennis has to say...**; actor `Denis` line 3, native ID `1813997940173070340`, supplies the phone response asking about the package. Both are actual emitted lines with exact shipped English matches. This establishes the authored Dennis phone role; it does not itself authenticate the separate in-person world acquisition.

The held claims use in-person `Darryl`, `community` entry `darryl`, reference `#mq038_com_darryl`. Briefing and ending acquisition objects match exactly. In the ending:

- Darryl line 2 directly asks **Haruyoshi** whether he is all right.
- Surgeon line 3 answers **Dennis give me hope.** The events are in the same graph section 3 at starts 4544 and 7490.
- Darryl line 9 introduces Haruyoshi's story; Surgeon line 11 again names Dennis as his rescuer in that conversation.
- The actual native contact ID is `darryl`, with exact localized name **Dennis Cranmer**.

Together these support a **reviewed narrative alias proposal**, with its semantic limit explicit: the Surgeon speaks about Dennis in the third person, rather than Darryl uttering an unambiguous full-name self-introduction. Parent review must approve that contextual bridge deliberately. The packet does not turn the community candidate into a verified world edge or let Dennis inherit Haruyoshi's personal claims.

## Liam: direct address plus full-name testimony

`mq019_04_manager.scene` actor 0 is native `Liam`, voice `1624173162010259524`.

Technician line 50 directly addresses **Liam**; native ID `1946025992124682240`, event `/Data/RootChunk/sceneGraph/Data/graph/38/Data/events/3/Data`. Liam immediately replies at line 51; native ID `1946026216285065216`, event 5 in the same graph section. Start times are 6480 and 10390. The exact emitted English exchange supplies the actor's named narrative identity.

In `mq019_01_notell_motel.scene`, Lizzy explicitly names **Liam Northom** at line 34, then identifies her manager at line 38. Her testimony stays attributed to her. The actual journal contact `liam` resolves to Liam Northom. These pieces support an explicit source-specific alias without resolving the external `community` resource link.

Privacy, relationship details, covert backup/alteration intentions, bribery, symptoms and later outcomes are separate from identity qualification and remain excluded as described in the existing proposal review.

## Jake: decisive hold retained

The held actor is `Estevez`, active `findInWorld`, voice `1624173162010261132`, reference `#gle_06_com_jake`, entity name `gle_06_jake`.

The inspected speaker mentions **Uncle Estevez**. Other generic actors discuss absent **Estevez** or **Jake** in different subscenes. Those references are compatible with the intended identity, but none directly addresses or introduces this actor as Jake Estevez. The matching community record still lacks an authenticated world NodeRef-to-resource edge. Cached quest phases repeat the same NodeRef, character-spawn condition and contact SMS path; they do not provide the missing resource map.

The packet preserves the evidence and its exact English variant difference. The speaking-actor hold should remain. A record's distinction from another record would not prove a different person, and the shared voice does not prove this person either.

## Life Coach: a narrower contact route, canonical record still held

The actual speaking `Coach` is actor 1 in `q000_corpo_03b_fly_to_lizzies.scene`, voice `1624173162010259648`. Its own `holocallInitScn/DepotPath` explicitly points to `base\quest\holocalls\coach\coach_holocall.scene`.

That authenticated initializer has one native actor `coach`, using the same `coach_holo/#coach_holo` active spawn-set fields. At `/Data/RootChunk/sceneGraph/Data/graph/5/Data/questNode/Data/type/Data`, its typed `questCallContact_NodeType` has a typed `gameJournalContact` caller path **contacts/coach**, player addressee, `Video` mode and `StartCall` phase. The journal's genuine `coach` contact localizes to **Life Coach**.

This is a directly referenced authored phone-role chain that a parent could review as a narrow contact attribution route. It is stronger than an unrelated contact merely appearing in the scene. It still does not yield a canonical Character record: the initializer's voice is zero, active acquisition is a spawn-set, and the source has no enabled same-actor direct record. **Brian Gustav** remains name metadata lacking that property/record route. Keep the current hold unless a distinct reviewed contact-role branch is explicitly accepted.

No present biometric access, medical credentials, employer benefit or earlier session with the current V follows from this identity route.

## R3n0: actual live property receipt

The phone scene's actual `Seller`, actor 0, has **active `findInContext`** and literal `Character.mq015_seller` at `/Data/RootChunk/actors/0/findActorInContextParams/specRecordId`. Its native voice is `1624173162010259764`.

Installed English entry `/Data/RootChunk/root/Data/entries/20789` has:

- `primaryKey`: `32025`.
- `femaleVariant`: `R3N0`.
- `secondaryKey`: `Story-base-gameplay-static_data-database-characters-npcs-records-quest-minor_quests-mq015-mq015_seller_displayName`.

This exact property-like localization key is not the record property itself. The parent then supplied an actual read-only diagnostic at `runtime/verification/reno-record-name/record-name-probe.json`. Its SHA256 is `6767fcab924b31e61c41338ac870c01305cab2dc7a3e4e6e1064d631691ae0bc`.

The returned game version is `2.31`, capture time `1790872343000` milliseconds since the Unix epoch, and the record exists. Its native ID string contains CRC32 `0xC1CC74A0`, length `22`; this review independently recomputed those values from `Character.mq015_seller`.

Both exact read-only property queries succeed:

| Property | Actual Lua type and printed value | Parsed key | Actual localized result |
| --- | --- | --- | --- |
| `Character.mq015_seller.displayName` | `userdata`, `LocKey(32025ull)` | `32025` | `R3N0` |
| `Character.mq015_seller.fullDisplayName` | `userdata`, `LocKey(32025ull)` | `32025` | `R3N0` |

The native type's `GetClassName` was not returned; no unavailable native class-name value is invented. The diagnostic source performs `GetRecord`, `GetFlat`, native ID stringification and `GetLocalizedText`, and writes the diagnostic report. It contains no TweakDB mutation in this branch. Exact lines 1–35 are snapshotted to the owned `record-name-probe.source.lua`, with source and snapshot hashes in the review receipt.

The parent also supplied `installed-tweakdb-receipt.json`. This review independently rehashed both exact installed files under `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\r6\cache`:

- `tweakdb.bin`: 42,028,033 bytes; SHA256 `918f0acfc3f3174b29b5c10b463dfb106b603118c85d24456204a1e2a2ac13f9`.
- `tweakdb_ep1.bin`: 48,192,743 bytes; SHA256 `89c7ee678c1366d4c289edc78beaa60ce3d64bf44b300fc3902adc94f6ac14c5`.

The actual active-installation property edge is now established and matches the independently authenticated native scene/English resource. Parent compiler admission should use an explicitly reviewed **live read-only property** receipt and exact `/properties/displayName` or `/properties/fullDisplayName` JSON pointers. This is not a CR2W serialization, and installed file hashes do not by themselves prove absence of runtime mod overrides. The evidence must retain that provenance limit.

The restaurant's separate community acquisition and any laptop author/employment inference are not repaired by the phone record.

## Parent integration guidance

Review the exact alias receipts independently. If accepted, scope each ledger alias to the recorded source hashes, actor pointer, native voice, named event(s), subject contact/title and, where used, exact source acquisition continuity. Record the evidence as **narrative identity**. Preserve the separate missing world registry edge.

Use the signed document branch only for 8ug8ear's typed authored essay. Admit R3n0's captured property only through its explicit runtime provenance. Keep Jake's actor claims held on the present evidence. Treat the Life Coach route as a separate contact-role decision, and retain Dennis's contextual attribution limit. Claims that were private or conditional before an identity review remain private or conditional afterward.
