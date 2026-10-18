# Cast knowledge, second expansion batch (2026-10-19)

Characters: `steve`, `grayson`, `aymeric-cassel`, `farida-nazeri`, `brick`, `patricia`, `lucy-thackery`, `mateo-thiago`, `max-jones`, `tiny-mike`, `ziggy-q`, `doctor-paradox`, `leon-rinder`, `albert-murphy`, `carl-robinson`.
Before: none of them had a compiled rule. After: 6 new rules (6 speakers) and 6 audience additions (grayson, brick, patricia).
Pack: `research/cyberpunk/native-rules/zz-cast-knowledge-20261019c.json` (the `zz-` prefix keeps it last in the builder's sorted merge). Specs: `staging/cast/_knowledge/specs/` (not in git); this file records the decisions.

## Method
- Audience additions first: an existing source-verified rule whose scene evidence puts the character in the scene, with a statement that is true as the character lived it. Presence was checked in the scene actor lists and the screenplay lines of the exported scenes.
- New rules clone the condition, evidence, sources and allowlists of the reviewed rule they restate and narrow the statement to what the character saw. A rule that lives in a `zz-cast-knowledge-*` pack is cloned, not edited.
- A character never receives a rule about their own death, about a decision they were not present for, or an outcome the catalog leaves unmapped.

## Audience additions (existing rules)
| Rule | Added | Why |
| --- | --- | --- |
| `ah5.pickup.brick-rescued` | brick | `q003_05_transition`: Brick is the actor in the cell scene where V and Jackie free him from the mine. |
| `ah5.totentanz.brick` | brick | `sq011_07b_thugs`, Brick branch: he is the leader V and Nancy talk to. |
| `sh5.second-conflict.brick` | brick | Same scene: he talks with V and Nancy and lets Nancy walk out. |
| `ah5.totentanz.patricia` | patricia | `sq011_07b_thugs`, Patricia branch: she receives V and Nancy with her crew (34 lines). |
| `sh5.second-conflict.patricia` | patricia | Same branch (fact `sq011_patricia_combat_path`): her people turn hostile; the statement stops at the fight. |
| `silverhand.grayson-spared` | grayson | `sq031_04_grayson`: he is the actor of the interrogation scene and V lowers the weapon on this branch. |

## New rules
- `aymeric-cassel.name.roulette-v-won` (participant; clone of Aurore's rule): at the Black Sapphire roulette table V won the all-in exchange against the twins; the actor Theo (Aymeric) plays at the same table.
- `albert-murphy.firestarter.songbird-hunt` (participant; clone of `phantom.native.firestarter.songbird`): on the Songbird branch the BARGHEST alarm under Murphy's voice (actors `Kruger`, `KrugerVoice`, one voicetag) sends the soldiers after the intruders and names Songbird as the main target; nothing is said about whether he lived.
- `lucy-thackery.hippocratic-oath.escorted`, `tiny-mike.concrete-cage-trap.escorted`, `max-jones.freedom-of-the-press.brought-out` (participant; clones of Regina's debrief rules): V found them and brought them out; the existing limits (patient outcome, what he took, how Max agreed to leave) are kept in the statements.
- `mateo-thiago.the-information.met-v` (witnessed; clone of `evelyn-parker.information.met-v`): V came to Lizzie's Bar to meet Evelyn and Mateo greeted V by name and sent V into the club; nothing more is claimed.

## Not supported (and why)
- `steve`: the Temperance epilogue has no live save and Steve never learns the neighbour is Johnny; the existing guitar rule names Johnny.
- `grayson`: the killed branch ends his life; the Porsche is recovered after the scene.
- `patricia`, `brick`: Royce's and Dum Dum's fate rules belong to rooms they were not in; Brick's trap-killed and left-unrescued branches end his scenes.
- `aymeric-cassel`: the executed rule is the twins' own deaths.
- `farida-nazeri`: the ICEbreaker rules gate on V's briefing with Reed; her scene never mentions it.
- `albert-murphy`: the Reed-branch rules are told-by-V or events he did not witness.
- `mateo-thiago`: the Automatic Love evidence rules are told-by-V or journal facts he cannot know.
- `ziggy-q`, `doctor-paradox`: broadcast voices with no quest of their own.

## Needs new evidence (decisions the catalog leaves unmapped)
- Waiting for Dodger (`phantom.dodger.force`, `resolution`, `bill-followup`) for `carl-robinson`.
- The Man Who Killed Jason Foreman (`rinder-plan`, `rinder-fate`, `rinder-followup`) for `leon-rinder`.
- Hippocratic Oath `patient` for `lucy-thackery`; Freedom of the Press `max/dead` for `max-jones`; Birds with Broken Wings facial-morph visit for `farida-nazeri`; Royce's fate seen from Brick's Totentanz lines.
