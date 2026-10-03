# Kerry yacht outcome — October 4, 2026

## Scope

One new enabled rule covers **one previously unmapped outcome**:
`silverhand.yacht-outcome / destroyed`, using its exact catalog topic
`kerry.yacht.outcome`. No new fact reader, runtime feature, source extraction,
cloud write, installation, or test suite was added. This is source verification;
the parent performs the single merged compiler check. It is not live-save proof.

The additive packet depends on unchanged evidence in `silverhand.json`:
`silverhand-native.beach-committed`, `silverhand-native.beach-declined`, and
`silverhand-native.invocation-beach`. Existing beach relationship facts are
reused as sufficient late-stage receipts, never inferred from their names.

## Positive selector and audience

Either current-save `sq028_kerry_relationship >= 1` or
`sq028_kerry_dislike >= 1` is sufficient for the earlier yacht explosion.
The existing reviews establish these as positive writes after the two spoken
responses to beach choice 59. This rule adds only the earlier shared outing
knowledge, not an assertion about current relationship status.

Only Kerry may use this knowledge in private/phone conversations with V.
It does not disclose their relationship to Johnny, Rogue, or a group. It does
not assert whose yacht it was, who owned any vehicle, which destruction options
V chose, whether intimacy occurred, or whether the relationship remains active.
No positive beach response means **unknown**, including the non-romance branch;
this is deliberately a sufficient subset, not complete coverage of Boat Drinks.

## Actual destruction and event order

All three beach-dialogue variants emit the actual explosion first and their
continuation afterward:

| Scene section | Explosion output `(2,0)` | Continuation `(2,1)` | Continuation target |
| --- | ---: | ---: | --- |
| 9 | 19,992 ms (event 12) | 23,335 ms (event 16) | 13, then 20 |
| 185 | 10,000 ms (event 10) | 12,785 ms (event 13) | 20 |
| 192 | 22,879 ms (event 11) | 25,730 ms (event 14) | 20 |

Their explosion output invokes **FX node 90**, `explosion_cs`, on the actual
`#sq028_com_yacht` entity (`yacht_no_enviro`). Node 90 then reaches 239,
which hides the yacht prefab; 485/487 remove the fire variants; and 491
**deactivates the yacht community entry**. This is an authored destruction
sequence with changed world state, not an interpretation of a `burnt` fact.

After those timed events, choice 20's three responses 22/24/26 converge on
condition 92. Its true output leads through 42 → 58 → choice 59. Commitment
59/0 → 60 → writer 66 and rejection 59/1 → 61 → writer 118 occur afterward.
The existing release evidence establishes that `sq028_03_beach.questphase`
invokes `beach_in`, with the parent quest chain rooted in the shipped game.

A bounded source traversal inspected **all five scene entries and every
output socket**, including cancellation/preview edges (not just normal paths):
`beach_in`, `Start 1`, `Start 2`, and `mainline` can reach both writers, but none
can reach either writer after sections 9/185/192 are removed. `Start 4` can reach
neither writer. The continuation outputs of each of the three indispensable
sections occur after its explosion output. The only incoming paths to choice
20 are section 13 or the late outputs of 185/192; only 9 reaches section 13.
Early exits therefore do not synthesize the two positive receipts.

The previous writer audit for these existing fact names remains the bounded
source corpus authority. Default/preloaded save history or external debug fact
editing is not distinguishable from a historical branch by a fact alone; the
rule says what the current observed save establishes, not what a human clicked.

## Integrity and exact pins

The packet adds **37 native references**, including exact output destinations,
cue events and times, FX target, prefab change, community deactivation, entry
selectors, and actor IDs. It reuses the previously authenticated scene asset:

- Depot: `base\quest\side_quests\sq028\scenes\sq028_07_trashy_beach.scene`
- Binary SHA256: `1bb663aabc3292a2789b1bc6e8c2ce20ff81242a9b2d66c91ecf4a97bd2c2cbe`
- JSON SHA256: `fff001d4ef96c31856b605226add3220c3f157d854195aea06a2ae5c9d326219`
- Recorded inventory: `cache/game/scene-evidence/silverhand-authenticated-oct01/inventory.json`
- That inventory already records `sha1Verified`, `serializationVerified`, and
  the same binary and JSON hashes. Both bytes were independently rehashed in
  this review; no unauthenticated old JSON was relabeled as a native export.
- Existing archive/provenance audit is documented in `silverhand-oct01.md`.
  No new claim is made that the installed archive was freshly scanned today.

## Other inspected candidates remain withheld

- **Archangel gift:** concert scene section 1456 sends timed output to
  unequip 2273 then AddItem 2275, with one `Items.Preset_Overture_Kerry` added to
  the local player. The choice is optional; the separate `sq011_done` writer
  1390 follows section 1741 and does not independently prove this gift. No
  current-save receipt for the actual optional transfer was established.
- `sq028_done`, an early yacht-burnt marker, and the intimacy setup marker are
  not substitutes for the later outcome. Existing unrelated/test writers and
  pre-completion timing limitations remain in force.
- Kerry recognition, US Cracks photograph, and Rogue alternatives retain their
  existing unmapped status; this packet does not inflate their coverage.
