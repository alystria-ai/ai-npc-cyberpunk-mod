# Panam and Aldecaldos side outcomes — October 4

## Draft for parent integration

`priority-panam-20261004.json` contains 17 authored rules. The first 13 are the saved Panam lane; this continuation adds Ghost Town cargo delivery, the Scorpion loss, Hellman's capture, and the explicit Riders rescue failure. They remain unintegrated until the root lane reviews the combined pack, native topic aliases, and old topic adjustment. The focused validator passes 247 hashed pointers in 34 native files and 159 current-save resolver probes. This is source and offline resolver evidence, not gameplay or installed-mod acceptance.

The 11-scene and 9-phase saved exports were reused. One previously missing handoff scene was exported into the immutable `priority-panam-20261004-ghost-handoff` batch, with 1/1 assets and no missing paths. Its installed archive winner is `basegame_4_gamedata.archive :: base\quest\main_quests\part1\q103\scenes\q103_14_maelstrom.scene`; archive entry SHA-1 `24da1f09565cd78b6d83e42b4aa6ec78d798bbc5`, raw SHA-256 `3cbf1d83421ebca8732c844e6c7e25a99cd48a55e9f557781b640738ebda4371`, JSON SHA-256 `65aaa437c6fe151cc734ccc1dbe2753655d89335939a1975f4ad3c0c058a7e27`.

## Added receipts

- **Ghost Town delivery:** The motel scene's merchandise exchange, buyer payment instruction, and Panam's later account to Rogue support the delivered cargo. The current save must show `steal_car`, `wait_convo_maelstrom`, and Ghost Town all revealed and succeeded. The latter objective is written Succeeded only after the handoff section. Audience: Panam in private or phone conversation.
- **Scorpion loss:** The post-wreck scene's `q104_mitch_rescued > 0` branch leads to Panam saying Mitch survived and Scorpion did not. Positive `q104_mitch_rescued` and later `q104_saul_met`, plus succeeded Life During Wartime, guard the statement. Audience: Panam and Mitch; no assertion that V caused their deaths.
- **Hellman capture:** V's gas-station report of having Hellman, the `confront_anders` succeeded objective, and the subsequent `q104_haru_taken_by_takemura = 1` custody writer support capture after Panam helped the pursuit. Life During Wartime must be succeeded. Audience: Panam only; the rule does not expose a later private interrogation to Saul or Mitch.
- **Riders rescue failed:** The saved sq004 drive phase waits for Panam's exact `contacts/panam/sq004/quest_failed` message to become Active, enters the canonical quest's `Failed` socket, then writes `sq004_fail_message_sent = 1`. The rule requires that positive fact and the revealed quest's `failed` state. Audience: Panam only; Saul, Mitch, and Carol are not automatically given V's private failure message.

Native zero is never treated as a refusal, death, or other written state. Every new rule requires positive branch, stage, and completed-quest observations. The runtime's revealed-state and audience checks are exercised with absent, false, hidden, wrong-speaker, and group probes.

## Alias review

The three entries in `runtime/quest-priority-eight-20261004/panam/topic-alias-proposal.json` are intentional. Convoy assistance joins the existing Panam trust domain and sq027 exclusive group, so an impossible save with assistance and betrayal resolves to neither contradictory memory. Riders failure joins the existing Saul rescue topic, so failure and rescue are contradictory outcomes. Collapse witnessed is a compatible facet of the Relic disclosure domain: witnessing a collapse does not imply hearing the private chip explanation. The proposal's author hashes are refreshed by `verify.mjs` after rule generation.

## Residuals requiring separate native receipts

The root's direct-affects draft listed 36 Panam rows after the 16-rule version of this pack. `aldecaldos.riders.rescue/failed` is now mapped by the seventeenth rule. Of the other 35 rows, 25 belong to the shared endings lane and `silverhand.nash-detour/assisted` plus `/declined` belong to the Johnny/Rogue lane. The eight remaining side-arc rows owned here are individually audited below.

| Direct Panam row | Native evidence checked | Residual basis |
|---|---|---|
| `aldecaldos.ghost.nash/declined` | `q103_10_escape`, `q103_11_tunnel_drive`, `q103_13_roadhouse_drive`, and the new `q103_14_maelstrom` handoff scene | `q103_helped_panam = 1` positively marks assistance. No retained positive refusal writer was found; its zero/absence cannot establish the detour choice. Cargo delivery remains mapped independently. |
| `aldecaldos.wartime.mitch-rescue/panam-alone` | `q104_05_av_debris` and `q104_07c_nomads_arrive` | The latter has alternate lines when `q104_mitch_rescued > 0` is false, but that false branch is not a written fact. `q104_crash_site_mitch_done` does not uniquely distinguish who saved Mitch. |
| `aldecaldos.wartime.pilot-information/tracks-followed` | `q104_05_av_debris`, `q104_tracking_av.questphase`, and `q104_gas_station.questphase` | `q104_pilot_gas_station = 1` records the pilot's disclosure. Tire/oil scan receipts show evidence gathered but do not prove the disclosure did not also occur; zero/absence is insufficient. |
| `aldecaldos.friends.loyalty/declined-initially` | `sq027_02_panam_and_santiago.scene` choice576 and followup `04_talk_to_panam_2` | The refusal dialogue exists, but the objective success is reached from both acceptance and refusal, and no unique persistent refusal writer was found. The player can still join later. |
| `aldecaldos.friends.tower-talk/personal-support` | `sq027_04_preparations_panam.scene` choice1095 and `sq027_panam_impulsive` writer | The positive fact follows either of two optional personal/impulse exchanges. It does not establish the catalog's stated reason for helping and may coexist with the mapped payment request. Mapping it to the exclusive motive domain would erase a legitimate cumulative conversation. |
| `aldecaldos.friends.campfire/heard` | `sq027_04a_camping.scene`, campfire lines, and `05_camp_with_nomads`/`talk_to_the_nomads` objectives | The scene contains the Scorpion/Saul veteran discussion, but these generic camp/talk receipts do not establish that V heard the entire optional account. No unique post-story save writer was found. |
| `aldecaldos.queen.romance/platonic` | `sq027_06_panzer.scene` and Queen completion | `sq027_panzer_sex = 1` and `sq027_panam_lover = 1` positively establish the romantic outcome. Zero or missing values, a nonreaction, or generic Queen completion do not establish a terminal platonic choice. |
| `aldecaldos.queen.nash/encountered` | sq027 camp-attack phase/scene corpus and q103 Nash branch | Nash can be conditionally present after a skipped earlier pursuit, but no positive current-save encounter receipt was found. A possible spawn condition or `q103_helped_panam = 0` cannot prove Panam saw him. |

These eight are genuine unqualified outcomes after the available installed-native pass, rather than generic backlog placeholders. They should remain unmapped until a positive saved observation is found. The 25 shared ending/Nocturne rows need the separate endings lane's audience and continuity review; this packet does not claim them.

- Optional farmhouse neutrality still lacks a saved neutral-choice receipt. Scorpion's farewell attendance or missed window is Mitch's private side quest and needs its own participation or closure receipt.
- Biotechnica contract termination needs the specific correspondence; camp defense alone is insufficient.
- Gun Music and Fortunate Son are Aldecaldos family stories without Panam as an established participant. Their unresolved deal, message, implant, and recovery branches must not be inferred from the Panam quest chain. Shared endings, Nocturne partner calls, and post-ending calls are owned by the root's other lane.

No game action, install, generated-pack change, central topic edit, cloud write, commit, or publication occurred in this lane.
