# Cast knowledge, pass B: native rules for the 28 new talkable characters (2026-10-18/19)

Characters: `bryce-mosley`, `dum-dum`, `royce`, `rosalind-myers`, `kurt-hansen`, `voodoo-queen`, `anders-hellman`, `joshua-stephenson`, `maiko-maeda`, `woodman`, `fingers`, `garry-the-prophet`, `brendan`, `denny`, `henry`, `teddy`, `weyland`, `oda`, `anthony-gilchrist`, `wilky-laguerre`, `aurore-cassel`, `dante-caruso`, `jago-szabo`, `chester-bennett`, `bree-whitney`, `edgar-tool`, `jacob-long`, `angelica-whelan`.
Before: 0 compiled rules with any of them as a speaker. After (enabled rules): bryce 2, dum-dum 7, royce 3, myers 8, kurt 0, voodoo-queen 3, hellman 6, joshua 2, maiko 5, woodman 1, fingers 2, garry 0, brendan 0, denny 3, henry 3, teddy 6, weyland 4, oda 2, gilchrist 3, wilky 0, aurore 1, dante 0, jago 3, bennett 3, bree 2, tool 4, jacob 1, angelica 3.
Pack: `research/cyberpunk/native-rules/zz-cast-knowledge-20261018b.json` (57 new rules; the `zz-` prefix keeps it last in the builder's sorted merge, same reason as pass A). 17 audience additions to existing rules (below), one separate fix to an existing rule, six topic alias rows. The builder reports 0 errors, 853 enabled rules (796 before).

## Method
- Candidates came from the scene actor lists of each character (`staging/cast/<key>/attribution.json`) matched against the scene evidence that every enabled rule cites (`staging/cast/_knowledge/tools/rules-by-scene.mjs`). Citation is not proof of presence: each candidate was judged on whether the scene branch the rule's condition proves is one the character is in, with lines and addressees read through the tools (`char-lines.mjs`, `scene-actors.mjs`) and, where branches were in doubt, the scene graph (`scene-graph.mjs`, `scene-path.mjs`, `scene-gate.mjs`: quest-fact conditions upstream of a line, True/False socket polarity, fact setters upstream/downstream, English text from the installed-localization index).
- Additions go onto an existing rule only when its statement says nothing the character could not know. Otherwise a new rule is a clone: `from` an enabled source-verified rule, so condition, evidence rows, sources, allowlists, catalog link and exclusive groups are copied unchanged; only id, audience and a trimmed statement are new. Nothing here invents a condition or an outcome.
- Build tooling (`staging/cast/_knowledge/`): `specs/*.json` (one per cluster plus `_extras.json` for new fact rows), `build-specs.mjs` (writes the pack, alias rows and, with `--additions`, the audience additions into the native-rules sources, refreshing the alias hashes of any rule whose audience changed and the `profileKeys` of the touched files), `check.mjs` (dry run of the real builder).
- Drafting: five Sonnet agents drafted cluster specs (maelstrom, voodoo-judy, misc-base, phantom-a, phantom-b); every spec was then reviewed against the scene data, trimmed where a statement over-reached, and the lead's review points were settled (below).

## Audience additions (existing rules)
| Rule | Added | Why |
| --- | --- | --- |
| `jt.royce-negotiation.paid-personal` | royce, dum-dum | `q003_03_deal`: both are actors (57 and 48 lines); the statement (V paid Royce with personal funds) is plain scene fact. |
| `jt.pickup-conflict.peaceful` | dum-dum | `q003_03a_militech_invades` calm entry: Dum Dum walks V and Jackie out and tells them not to come back. Royce is not in that walk; he has his own rule. |
| `ah5.totentanz.royce` | royce | `sq011_07a_royce`: Royce speaks 20 lines to Nancy and V. |
| `al5.gun.deal-intimidated`, `al5.gun.deal-firefight` | teddy | `mq002_01_deal`, `mq002_02_combat`, `mq002_03_summary`: Teddy is an actor beside Carol and Cassidy (the existing speakers). Weak but real presence (1-2 lines each). |
| `aldecaldos.native.v-aldecaldo-initiation` | teddy | `q114_04_initiation`: bystander at the ceremony; the statement claims nothing private. |
| `priority-panam.native.convoy-assistance` | teddy | Teddy is one of the veterans in `sq027_03_panams_plan`, `sq027_04_preparations_cassidy_teddy`, `sq027_05_ambush`; not added to `aldecaldos.native.basilisk-convoy-secured` (that adds a Panam-Saul scene). |
| `priority-endings.rogue.weyland-recovered` | weyland | The rule is about Weyland himself (`q115_jungle_weyland_saved`; `q115_05_halo_jump`, `q115_06_regroup`). |
| `jt.oda-refusal.refused` | oda | `q112_00b_secret_meeting`: 23 lines, he refuses and warns them. Precedes the parade, so not his death branch. |
| `db.oda-spared` | oda | `q112_08_parade_speech`, fact `q112_08_oda_spared` is the spared branch. |
| `cc5.rachel.joined-joshua` | joshua-stephenson | `sq023_11_01a_after_chase`: Joshua is the central actor; he survives this branch. |
| `db.lucretia-oath-sworn` | rosalind-myers | `q302_04_squot`: Myers administers the oath. |
| `priority-judy.revolution-accepted` | maiko-maeda | `sq026_08_plan`: she is in the plan meeting. |
| `priority-judy.pisces-maiko-survived-installed` | maiko-maeda | `sq026_13_hiromi`: her own survival and takeover; chosen over `jr-native.pisces-maiko-installed`, which also states Judy confronting V. |
| `priority-endings.takemura.estate`, `priority-endings.hanako.extracted` | anders-hellman | `q113_03a_haru_kasai_drive`, `q113_04_hanako_estate`, `q113_05_av_flight`: Hellman drives V to the estate and flies out with Hanako and V. |
| `pm5.easy.fate-controlled` | angelica-whelan | `mq306_04b_angie_meeting`: Angie speaks all 9 of her lines in it; the statement is what she lived. |

## New rules (clones with a trimmed statement)
- **Pickup (Dum Dum, Royce).** Dum Dum: `fought-maelstrom` (only the breakdown and his own call to shoot; the existing statement's V-and-Jackie escape is dropped), `fought-militech` (led them out, fought beside them; the "survived the assault" clause and the thanks line are dropped because `q003_dumdum_dead` is written in that scene), `chip-malware` (witnessed in the room; the chip's origin stays out), `royce-downed` (see "Guards"), `totentanz-recognised-v`. Royce: `sale-completed` (peaceful route; he did not walk the factory so that clause is dropped).
- **Samurai reunion (Denny, Henry).** One rule each for chosen, passed over and performed. Both are in `sq011_08b_denny_henry` when V picks one, so each holds the pick; only the chosen one is in the concert (`silverhand.reunion-performed` does not say who played, so the `-nancy` rules with the per-person fact are cloned instead).
- **Gilchrist.** `stout-meeting` (held by Stout's bodyguards; the statement does not assert he is the mole), `gate-meeting`, `confronted`.
- **NetWatch and the Voodoo Boys.** Bryce: `deal-accepted`, `virus-warning`. Brigitte: `v-returned` (the Placide confrontation), `evelyn-hired` (the recorded session; she does not know V and Judy watched it), `alt-dive` (what she ran; nothing about the Alt exchange or her runners' fate).
- **Judy lane.** Woodman: `fingers-lead` only. Fingers: `assaulted`, `questioned`. Maiko: `office-meeting`, `paid-v`, `bosses-removed` (guarded). Hellman: `captured`, `estate-without-takemura` (mutually exclusive with the Takemura-present addition), `yorinobu-held` (extra catalog link), `collected-v`.
- **Aldecaldos, Afterlife, misc.** Teddy: `sent-v`, `v-woke-at-new-camp`. Weyland: `flew-the-assault`, `rogue-died` (override), `rogue-alive`. Joshua: `v-walked-out`.
- **Phantom Liberty.** Myers: `hole.rescued`, `spider.chimera-defeated`, `lucretia.operation-accepted`, `lucretia.intruders-cooperated`, `silence.handover-alive`, `.handover-dead`, `.medal-accepted`. Jacob: `intruders-cooperated`. Aurore: `roulette-v-won` (actor `Bella` in `q303_07_finale`, who introduces herself as Aurore; none of the disguise actors `Alex_Female`/`Replacer_Female` in `q304_05` to `q304_07b`, which are Alex and V). Bree: `sided-with-bree`, `sold-to-netwatch`. Jago and Bennett: `bennett-killed` (Jago), `jago-killed` (Bennett), `peace-deal` and `terra-cognita-price` (both). Envoy wording is "a Cuban cartel envoy called Aguilar" (they do not know it was V). Tool: `sister-reunion`, `clone-story`, `letter-read-aloud` (the three finale branches, each stated as Tool lived it, not as the cover story it was) and `freed-from-booth`. Angelica: `deal-accepted`, `sasquatch-threat`.

## Guards, overrides and new fact rows
- `q003_dumdum_dead` (new allowlist row, three writers in `q003_04d_shootout_militech`, graph nodes 48/68/260) as a zero-guard: `dum-dum.the-pickup.royce-downed` fires only while it is 0.
- `q110_placide_dead` (new row, `q110_07b_placide_combat.questphase` node 13) as a zero-guard on `voodoo-queen.i-walk-the-line.v-returned`: the combat variant of the Placide objective sets it and plays no Brigitte scene, so the 09c talk variant is `q110_placide_dead == 0`.
- `maiko-maeda.pisces.bosses-removed` adds `sq026_maiko_dead == 0` (she can be killed in that scene); the guard journal is the only `pisces` row in the allowlist.
- `weyland.knockin.rogue-died` overrides the condition to `q116_rogue_dead >= 1` and `q115_jungle_weyland_saved >= 1`: his two lines in `q116_03b_after_bossfight` sit under the Weyland-saved branch (node 240), so a copy never claims Rogue's death in a save where he was not recovered.
- `anders-hellman.total-immortal.yorinobu-held` has a second catalog link to `silverhand.yorinobu-confronted/completed` (previously unmapped, now mapped) with a pinned `compatible-facet` alias row.

## Separate fix to an existing rule (commit on its own)
`jt.royce-negotiation.paid-clean-or-warned` (`priority-jackie-takemura-20261004.json`) used only `q003_militech_betrayed >= 1`. In `q003_03_deal`, `q003_paid_maelstrom=1` (graph node 79) leads straight to `q003_militech_betrayed=1` (node 241), so the rule also fired on personal-funds saves next to `paid-personal`. It now also requires `q003_paid_maelstrom == 0` (guarded by `jt.pickup.completed`). Reproduce with `node staging/cast/_knowledge/tools/scene-graph.mjs q003_03_deal down q003_paid_maelstrom`; script `staging/cast/_knowledge/fix-paid-clean-or-warned.mjs`. The two other `betrayed` setters (nodes 58, 107) are the clean/warned paths.

## Judgement calls from the review
- Dropped (strict reading, nothing in the pack proves alive-versus-dead there): Royce `chip-malware`, `militech-stormed-plant`, `knocked-out-by-v`; Woodman `fight-lost` and `maintenance-confrontation`.
- Dropped as not traced: `maiko-maeda.ex-factor.woodman-missing` (the "didn't show up" line is reached through `q105_woodman_dead >= 1` false, the "murdered Oswald Forrest" line only through it true: no single proven branch); Joshua's two dinner rules (the goodbye lines have no upstream gate that separates the accept and refuse branches; the bribe setters are upstream of the "glad to have met you" line).
- Trimmed to what the scenes support: Myers `intruders-cooperated` and Jacob's copy (no price, Rayfield or street name: the graph shows the negotiate fact is reached before several sub-branches), Myers `operation-accepted` (the NUS-assets pledge sits on the "I'm out" exchange and is not tied to the accepted branch, so only "you two have to find her together" stays), the medal and handover statements (only lines confirmed in the matching branch: "excellent hands, best care on the continent"; "killed in the line of duty ... remembered"; the offer itself), Woodman's lead (the "chip could not be repaired" clause is dropped).
- Brigitte: her `q110_16b_closing_funeral` lines show her alive after the dive, so no rule states her death on the NetWatch route.
- `rosalind-myers` was not given `lucretia-reed-met` (it says V met Reed; she is not shown at the interrogation).

## Could not support with evidence (no filler)
- **Kurt Hansen:** every branch of the Firestarter/Hansen rules ends in his death (Alex or V kills him); his q303/q304 scenes show hearsay about the roulette or a covert scan; mq301/q302 "Kurt" actors are a flashback slot, a radio voice and vehicles. No rule.
- **Wilky Laguerre:** the Baron scene ends with his death and Songbird's Black Sapphire message reaches V while he convulses; no living branch.
- **Dante Caruso:** the only mapped branch (V kills him) is his death; `dante-alive` and `both-dead` have no predicate (needs `mq305_bree_dead`-style facts in the allowlists).
- **Garry the Prophet, Brendan:** the quest catalog has no quest, character or decision for mq026/mq037; nothing to map.
- **Royce alive, Dum Dum alive/killed, Gilchrist dead:** `q003_royce_dead` is written on every cited death route but its absence is not proof of survival; `q003_dumdum_dead` is wired only as a guard, not as an outcome rule (Dum Dum's own death cannot be his memory and there is no "alive" fact); `q003_gilchrist_dead_conclusion` (`q003_07aa_final_traitor`) has no catalog outcome.
- **Myers:** `lucretia-operation-refused` is her death branch; the NCX/`the-killing-moon` outcomes are after her scenes; the tracker cut from her neck and the declined oath have no predicate.
- **Hellman as Takemura-less envoy** (`arasaka-heist.orbital-visitor/hellman`, the `where-is-my-mind` participant contract rules): needs a "Takemura not rescued" condition that does not exist yet.
- **Maiko:** `nonlethal`/`refused` payment branches and the `maiko-fate` outcomes lack separating facts.
- **Jago/Bennett Arasaka investigation** (`phantom.town.arasaka/investigated`), **Tool in the mq303 vendor scene**, **Angie's refusal branch** (`mq306_animals_dead` mixes killed and knocked out): no predicate.
- The remaining `needsNewEvidence` entries in the specs are leads for a later evidence pass, not wired.
