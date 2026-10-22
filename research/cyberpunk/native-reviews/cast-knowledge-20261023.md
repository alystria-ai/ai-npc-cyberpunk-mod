# Cast knowledge, third batch (2026-10-23)

Characters: `hasan-demir`, `pedro-aimar`, `mr-blue-eyes`.
Before: none of them had a compiled rule. After: 2 audience additions (Pedro, Hasan), no new pack, no rule for Mr. Blue Eyes.
Same method as `cast-knowledge-20261019c.md`: an existing source-verified rule whose scene evidence puts the character in the scene, with a statement that is true as the character lived it.

## Audience additions (existing rules)
| Rule | Added | Why |
| --- | --- | --- |
| `fo5.desperate.truck` | pedro-aimar | `sts_std_arr_12_car` and `sts_std_arr_12_pedro`: Pedro (actor `Pedro`, one voicetag, 22 and 67 lines) rides the stolen Zetatech car with V and sets up the theft; the statement (V stole the car with Pedro and left it at Tirempire, completing Muamar's gig) is what he lived. |
| `pg5.prototype.hands-safe` | hasan-demir | `sts_ep1_04_hasan_final`: Hasan (actor `hasan`, community entry `hasan`) is in the room while V argues with Hands over the holocall; the rule's evidence node (`sts_ep1_04_mr_hands_holo_convinced`) sits in that scene. He hears V ask Hands to find him a chrome-doc instead of sending him back. His own lines after the choice thank V. |

The speaker and recipient lists and the pack `profileKeys` carry the new keys; `characters/world-knowledge.json` and `research/cyberpunk/generated/world-knowledge.json` were rebuilt with `build_native_pack.mjs --apply` (their `profileKeys` follow the roster).

## Not supported (and why)
- `hasan-demir`: the other Prototype outcomes (`zetatech`, `alone`) and the later states (`shop`, `impoverished`) are unmapped or end his scenes; the Zetatech branch ends with him taken away, the Kill branch with his death.
- `pedro-aimar`: the ALS disclosure (`pedro-disclosure`) is unmapped.
- `mr-blue-eyes`: owner decision, minimal row. His quests (`Dream On`, `Path of Glory`, a glimpse in `The Killing Moon`) have no source-verified rule naming him. `silverhand.crystal-palace-job` is unmapped ("departure is not success"), and a character never gets a rule about an unmapped outcome. His dossier carries no conditional knowledge and no relationships; the profile text names no plot, and `bridge/cast-expansion.test.mjs` checks that.
