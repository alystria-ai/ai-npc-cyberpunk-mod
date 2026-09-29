# Silverhand native review

Reviewed 2026-09-30 against installed Cyberpunk 2077 **2.31**, base plus Phantom
Liberty winning resources. This is source verification, not live-save
qualification. No game facts, saves, production profiles, cloud records or
installed mod files were changed by this lane.

## Measured scope

- Eight dossiers: Johnny, Rogue, Kerry, Spider Murphy, Santiago, Thompson,
  Adam Smasher and Bes Isis (existing key nancy-hartley).
- 74 original speaking examples; 35 researched quests, 83 decisions and
  129 narrative outcomes. Biography, style and examples remain separate fields.
- **15 enabled native rules covering 13 distinct outcomes**, 17 evidence records,
  13 positive allowlisted facts, 26 binary-hashed assets, 390 verified pointers.
  All are source-verified; none are live-verified.
- **116 outcomes remain unmapped locally.** Accepted oilfield second chance is
  separately owned by core-arcs and intentionally not duplicated.
- Narrative maps remain research documents. Only native-rules/silverhand.json
  supplies executable predicates; the parent compiler merges final coverage.

## Semantics and audience

| Outcome | Actual branch meaning | Audience |
| --- | --- | --- |
| Kerry beach commitment | Beach choice59 ordinal0 -> response60 -> writer66, sq028_kerry_relationship +=1. English response agrees. | Kerry, private/phone. Historical agreement, not guaranteed current partnership. |
| Kerry one-off rejection | Choice59 ordinal1 -> response61 -> writer118, sq028_kerry_dislike +=1. English spoken refusal supplies meaning; the option payload has a Polish placeholder and was not used as English proof. | Kerry, private/phone. Not generalized hatred. |
| Denny/Henry lineup | Choice261 ordinals0/1 directly write425/428. Localized choices identify the selected member. | Johnny/Kerry initially; Nancy only after completed-concert evidence. |
| Terrace kiss | Choice204 ->462/465 -> eligibility474 -> actual section212 -> writer208. | Kerry only. Eligibility is not consent or final partnership. |
| Backstage threats | Conditions355/366 roughness>=2 -> coercion362 -> trigger482 -> departure485 -> final no-deal writer378. | Kerry only. One early threat is insufficient. |
| Reconciliation subset | Apology/acceptance122 -> group-photo choice583 -> selfie writer547. | Kerry only. Sufficient for prior reconciliation; not proof photo was taken. Friendly paths without this marker remain unknown. |
| Reunion completed | Phase117 to_concert ->246 concert_starts ->117 after_concert; final exit -> reward125 -> checkpoint119 -> cleanup122 writes sq031_samurai_concert_done. Performance and postconcert dialogue corroborate this. | Johnny/Kerry/Nancy. Publicly visible V performing; no possession disclosure to Nancy. |
| Rogue killed | Boss cinematic515 -> Rogue ragdoll758 -> exact writer416. Postfight sections199/237 independently confirm death and Smasher responsibility. | Johnny only. A summoned Rogue is not a posthumous witness. |
| Grayson spared | Put-weapon-away choice133 ordinal1 -> writer1923 -> confirmation135. | Johnny only. Historical mercy, not guaranteed later survival or car ownership. |
| Grayson killed | Armed branch -> hit/incapacitation -> XOR3653 -> explicit Combat_Kill3655 targeting #grayson, skipDefeatedState=1 -> cut-control1659 normal output ->2680 -> writer337. | Johnny only. Unconscious/defeated condition alone is insufficient. |
| Movie date completed | sq031_bushidox scene401 movie_out -> reward411 -> checkpoint409 -> cleanup406 In1, whose connected chain reaches node17 and increments sq031_rogue_date_done. Actual movie exit200 follows the post-outing V/Johnny exchange. | Johnny/Rogue, private/phone. Johnny used V's body; no V/Rogue partnership is inferred. |
| Movie intimacy interrupted | Kiss choice658/950 ordinal0 ->1015/1145/1457 -> cinematic662/1463 timed output(2,1) -> positive writer721 -> refusal670 -> reply672 -> departure684. Requires completed-date fact as a second gate. | Johnny/Rogue, private/phone. Intermediate intimacy alone cannot announce the later refusal; absence cannot prove no kiss. |

Nancy's lineup facet requires both the selected-member fact and completed
concert. It contains no private argument or Johnny possession facts.

## Production linkage and alternate writers

Each rule cites SHA256, exact pointers, localized screenplay joins and actor
identity. Production invocation evidence records a connected quest-scene input
and matching scene selector. The parent resource chain reaches
cyberpunk2077.quest. That closure is **structural provenance**, not proof a
current save executed it.

- sq028_03_beach root input0 invokes scene7 through beach_in; normal scene entry1
  reaches choice59 through the beach exchange and branch92.
- sq011_denny scene35 has actual villa and return inputs. Exact normal-entry
  paths to the lineup choice are recorded; unconnected preview sockets are excluded.
- sq017_02c_club_attack invokes Start 0. Premiere has separate normal,
  without-Us-Cracks and rooftop inputs; only the actual kiss is mapped.
- Grayson confrontation is invoked by sq031_adam nested scene3 through
  sq031_04_grayson_in. Porsche/shooting/obituary entries are not interchangeable.
- Movie scene401 is invoked through sq031_08_movie_in, matching scene entry296.
  Preview1031, rogue-leaves1494 and bug-fix1607 entries do not establish the
  ordinary outing. The completion writer is reachable through the normal movie
  return and exact cleanup chain; it is not inferred from the earlier meeting.
  Scene-local English for all 120 movie descriptors matches shipped subtitle
  localization. The two intimate cinematics share the same writer/refusal path.

The main base/EP1 fact index and **all scene fact indexes exported at review
time** were searched for assignments to the thirteen enabled names. Only the
cited positive writer was found for each; no extra EP1 initialization writer
was found in that bounded corpus. This is not a claim every game scene was
exported. Later-discovered writers require review. Reachable EP1 presets can
establish default save history without proving the human clicked that branch.

The Us Cracks scene also has a reference in sq021_braindance nested node158.
Its only connected input is sq021_we_got_in, absent from the installed scene's
entry selectors (Start 0, Start 6, Start 1). The River node's Start0/Start1
sockets are unconnected. This stale mismatch is documented, not counted as
execution of backstage choices.

## Rejected shortcuts and remaining risks

- q116_smashero_deado follows a broad player hit condition accepting bullets,
  explosions, melee and other hits. No killed/spared interpretation is enabled.
  Grayson's path differs because an explicit Kill precedes its writer.
- sq028_kerry_sex is written during setup, not proved completion.
  sq028_yacht_burnt precedes the final beach explosion.
- sq028_done has unrelated-world/test writers; it cannot stand for romance,
  intimacy, destruction or a particular human selection.
- sq017_selfie is written before the photograph. sq031_rogue_date_met is a
  meeting, not completed date; sq031_rogue_date_done is separately audited from
  the movie return. sq031_rogue_lover alone precedes the later refusal, so it
  requires the completed-date gate. sq011_kerry_met alone does not establish that
  Kerry accepted Johnny's identity. Nancy cleanup is not optional-data recovery.
- No negative/zero conditions. Absent, hidden or unobserved facts remain unknown.
- Same-topic contradictory outcomes suppress that topic. Kiss and later declined
  partnership are sequential possibilities and deliberately separate topics.
- Rogue death uses exclusiveGroups ending.assault-route / rogue. Opposing
  positive ending-route remnants suppress dependent facets across topics.
  This does not assert that a human never tried another ending. Current-world,
  checkpoint and rollback identity remain the coordinator's responsibility.
- Private/phone only until verified disclosure allows broader group knowledge.
  Appearance, summons and a shared roster identity are not witness/survival proof.
- Santiago defaults to a **2013-era** persona. Later leadership and Trace
  parentage are research-only uncertainties, removed from intrinsic knowledge
  and relationship baselines. Historical copies receive no automatic 2077
  omniscience. Johnny memories remain subjective.
- Bes Isis' biography contains no roster-key implementation metadata.

## Verification

- Research validator: 8/8 assigned dossiers, 74 examples, 35 quests,
  83 decisions, 129 outcomes, zero errors/warnings.
- Read-only native compiler verification: 15 rules, 26 unchanged assets,
  390 exact pointers, all narrative outcome links valid, zero errors.
- Expected types and fact/value/setExactValue are also checked by the rule verifier.
- Ten resolver checks pass: conflicting beach choices withheld; Nancy lacks
  early lineup knowledge; she receives completed lineup without private facts;
  conflicting Grayson states withheld; Rogue copy not posthumous witness;
  missing facts assert no romance; intermediate movie intimacy waits for date
  completion; date completion does not invent a kiss; both positive markers
  recall the later refusal; private date knowledge is withheld from Nancy.
- No live game acceptance claimed; no long game dialogue reproduced.

## Per-decision coverage

A mapped key executes only under the predicates/audience above. A dash means no
local native rule. The full map has 129 outcomes, including intentional gaps.

| Quest / decision | Locally mapped | Remaining outcomes and reason |
| --- | --- | --- |
| Love Like Fire / `silverhand.memory-2023` | — | `experienced` — Subjective Johnny memory needs its own native progression audit; recollection is not objective omniscience. |
| Love Like Fire / `silverhand.kerry-farewell-tone` | — | `encouraging`, `dismissive` — Subjective Johnny memory needs its own native progression audit; recollection is not objective omniscience. |
| Playing for Time / `silverhand.relic-diagnosis` | — | `heard` — Relic and identity progression need exact stage/disclosure proof. |
| Playing for Time / `silverhand.diner-cooperation` | — | `proposed` — Relic and identity progression need exact stage/disclosure proof. |
| Never Fade Away / `silverhand.memory-2013` | — | `experienced` — 2013 memory viewpoint and each event need native progression and disclosure proof. Historical copies do not receive V memories. |
| Transmission / `silverhand.alt-contact` | — | `contact-established` — Alt contact and identity disclosure need stage and audience proof. |
| Transmission / `silverhand.voodoo-outcome` | — | `netwatch-purge`, `peaceful-departure`, `v-initiated-fight` — Alt contact and identity disclosure need stage and audience proof. |
| Tapeworm / `silverhand.dog-tags` | — | `received` — Separate conversations and trust cannot be reduced to quest completion. |
| Tapeworm / `silverhand.rogue-control-agreement` | — | `agreed`, `declined` — Separate conversations and trust cannot be reduced to quest completion. |
| Ghost Town / `silverhand.rogue-commission` | — | `paid-and-briefed` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Ghost Town / `silverhand.nash-detour` | — | `assisted`, `declined` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| A Cool Metal Fire / `silverhand.bender-handover` | — | `completed` — Body control and optional consequences need separate exact branches. |
| A Cool Metal Fire / `silverhand.bender-tattoo` | — | `johnnys-special`, `together-forever` — Body control and optional consequences need separate exact branches. |
| A Cool Metal Fire / `silverhand.ebunike-lead` | — | `obtained` — Body control and optional consequences need separate exact branches. |
| Chippin' In / `silverhand.grayson-interrogation` | — | `heard` — Interrogation, vehicle recovery and invitation need independent completed branches. Oilfield accepted second chance belongs to core-arcs. Mercy is not Porsche ownership. |
| Chippin' In / `silverhand.grayson-fate` | `spared`, `killed` | All authored keys mapped, subject to the subset/audience limits above. |
| Chippin' In / `silverhand.porsche-recovery` | — | `recovered` — Interrogation, vehicle recovery and invitation need independent completed branches. Oilfield accepted second chance belongs to core-arcs. Mercy is not Porsche ownership. |
| Chippin' In / `silverhand.oilfield-reconciliation` | — | `second-chance`, `other-conversation` — Accepted second-chance is mapped by core-arcs. Other conversations cannot be inferred from its absence. |
| Chippin' In / `silverhand.rogue-date-invitation` | — | `arranged`, `declined` — Interrogation, vehicle recovery and invitation need independent completed branches. Oilfield accepted second chance belongs to core-arcs. Mercy is not Porsche ownership. |
| Blistering Love / `silverhand.date-completed` | `completed` | All authored keys mapped from the normal movie exit and connected cleanup writer. |
| Blistering Love / `silverhand.drive-in-intimacy` | `interrupted` | `not-initiated` — The positive intimacy marker plus completed date proves the interrupted branch. Missing or zero intimacy cannot prove no kiss. |
| Holdin' On / `silverhand.identity-revealed` | — | `recognized` — The mansion meeting marker does not prove acceptance of Johnny identity or agreement to a reunion. |
| Holdin' On / `silverhand.reunion-proposal` | — | `proposed` — The mansion meeting marker does not prove acceptance of Johnny identity or agreement to a reunion. |
| Second Conflict / `silverhand.totentanz-leadership` | — | `royce`, `brick`, `patricia` — Leadership requires earlier-fate/cast joins. Nancy data and safe extraction need acquisition/exit proof, not cleanup alone. |
| Second Conflict / `silverhand.nancy-data` | — | `recovered` — Leadership requires earlier-fate/cast joins. Nancy data and safe extraction need acquisition/exit proof, not cleanup alone. |
| Second Conflict / `silverhand.nancy-extraction` | — | `safe` — Leadership requires earlier-fate/cast joins. Nancy data and safe extraction need acquisition/exit proof, not cleanup alone. |
| Second Conflict / `silverhand.reunion-lineup` | `denny`, `henry` | All authored keys mapped, subject to the subset/audience limits above. |
| A Like Supreme / `silverhand.reunion-performance` | `performed` | All authored keys mapped, subject to the subset/audience limits above. |
| A Like Supreme / `silverhand.archangel-gift` | — | `received` — Concert is mapped from the performed scene return. Archangel is a separate item transfer. |
| Rebel! Rebel! / `silverhand.sabotage` | — | `completed` — Transport action and escape need completed native outcomes. |
| Rebel! Rebel! / `silverhand.diner-followthrough` | — | `completed`, `abandoned` — Transport action and escape need completed native outcomes. |
| I Don't Wanna Hear It / `silverhand.backstage-resolution` | `reconciled`, `threatened` | All authored keys mapped, subject to the subset/audience limits above. |
| I Don't Wanna Hear It / `silverhand.uscracks-photo` | — | `taken` — Reconciliation is mapped only for the positive group-photo-choice subset after apology. Choosing the photograph is not proof it was taken. |
| Off the Leash / `silverhand.collaboration-event` | — | `present` — Actual kiss is mapped. Absence is unknown. Event attendance requires cast and prior-resolution joins. |
| Off the Leash / `silverhand.terrace-kiss` | `kissed` | `not-kissed` — Actual kiss is mapped. Absence is unknown. Event attendance requires cast and prior-resolution joins. |
| Boat Drinks / `silverhand.yacht-outcome` | — | `destroyed` — Intimacy fact is set at scene setup; yacht-burnt precedes final beach explosion. Finished events need later positive joins. |
| Boat Drinks / `silverhand.yacht-intimacy` | — | `occurred`, `not-occurred` — Intimacy fact is set at scene setup; yacht-burnt precedes final beach explosion. Finished events need later positive joins. |
| Boat Drinks / `silverhand.beach-commitment` | `committed`, `declined` | All authored keys mapped, subject to the subset/audience limits above. |
| Killing in the Name / `silverhand.swedenborg-discovery` | — | `bot-identified` — Router sequence, bot truth and actual report to Bes Isis need separate proof. |
| Killing in the Name / `silverhand.swedenborg-machine` | — | `left-running`, `disconnected`, `altered` — Router sequence, bot truth and actual report to Bes Isis need separate proof. |
| Killing in the Name / `silverhand.nancy-disclosure` | — | `truth`, `withheld` — Router sequence, bot truth and actual report to Bes Isis need separate proof. |
| The Ballad of Buck Ravers / `silverhand.buck-ravers-visit` | — | `visited` — Optional history conversation and vendor result need branch proof. |
| Gig: Psychofan / `silverhand.psychofan-guitar` | — | `delivered` — Recovered item ownership and completed handoff need quest/inventory proof. |
| Gig: Psychofan / `silverhand.psychofan-pants` | — | `recovered` — Recovered item ownership and completed handoff need quest/inventory proof. |
| Gig: Family Heirloom / `silverhand.recording-delivery` | — | `delivered` — Delivery, ownership and disclosure to Nancy are separate. |
| Gig: Family Heirloom / `silverhand.family-car` | — | `returned`, `not-returned` — Delivery, ownership and disclosure to Nancy are separate. |
| Gig: Family Heirloom / `silverhand.family-shoes` | — | `recovered` — Delivery, ownership and disclosure to Nancy are separate. |
| Gig: Hot Merchandise / `silverhand.rebeca-price-fate` | — | `killed`, `delivered-alive` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Gig: The Union Strikes Back / `silverhand.vic-vega-fate` | — | `killed`, `delivered-alive` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Gig: The Union Strikes Back / `silverhand.union-collateral` | — | `no-other-kills`, `others-killed` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Gig: Nasty Hangover / `silverhand.karl-ginsky-fate` | — | `saved`, `killed` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Gig: Nasty Hangover / `silverhand.kang-tao-payment` | — | `accepted`, `not-accepted` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Nocturne Op55N1 / `silverhand.final-route` | — | `arasaka`, `aldecaldos`, `rogue`, `solo`, `suicide`, `nusa` — Route availability, selection, romance call and commitment are independent. |
| Nocturne Op55N1 / `silverhand.rooftop-kerry-call` | — | `called` — Route availability, selection, romance call and commitment are independent. |
| For Whom the Bell Tolls / `silverhand.assault-commitment` | — | `committed` — Takeover, Rogue agreement, equipment and route launch need stage-specific proof. |
| For Whom the Bell Tolls / `silverhand.rogue-farewell-call` | — | `overheard` — Takeover, Rogue agreement, equipment and route launch need stage-specific proof. |
| Knockin' on Heaven's Door / `silverhand.weyland-recovery` | — | `recovered` — Rogue death is mapped. Weyland rescue is separate. Smasher deado is a hit marker, not proven death. |
| Knockin' on Heaven's Door / `silverhand.rogue-fate` | `killed` | All authored keys mapped, subject to the subset/audience limits above. |
| Knockin' on Heaven's Door / `silverhand.rogue-route-smasher-fate` | — | `killed`, `spared` — Rogue death is mapped. Weyland rescue is separate. Smasher deado is a hit marker, not proven death. |
| (Don't Fear) The Reaper / `silverhand.solo-assault-result` | — | `reached-mikoshi`, `fatal-failure` — Eligibility is not selection or completed assault. No percentage/timing shortcut. |
| (Don't Fear) The Reaper / `silverhand.solo-route-smasher-fate` | — | `killed`, `spared` — Eligibility is not selection or completed assault. No percentage/timing shortcut. |
| Belly of the Beast / `silverhand.saul-fate` | — | `killed` — Coordinate Aldecaldo lane for native fate/route proof; no inference from names. |
| Belly of the Beast / `silverhand.aldecaldo-route-smasher-fate` | — | `killed`, `spared` — Coordinate Aldecaldo lane for native fate/route proof; no inference from names. |
| Belly of the Beast / `silverhand.aldecaldo-mikoshi` | — | `reached` — Coordinate Aldecaldo lane for native fate/route proof; no inference from names. |
| Totalimmortal / `silverhand.arasaka-route-smasher-fate` | — | `killed`, `spared` — Do not substitute q116 for the separate Arasaka-route combat/mercy path. |
| Totalimmortal / `silverhand.arasaka-assault-companion` | — | `present`, `absent` — Do not substitute q116 for the separate Arasaka-route combat/mercy path. |
| Totalimmortal / `silverhand.yorinobu-confronted` | — | `completed` — Do not substitute q116 for the separate Arasaka-route combat/mercy path. |
| Where Is My Mind? / `silverhand.orbital-contract` | — | `signed`, `earth` — Medical state, visitor and contract belong to separate Arasaka predicates. |
| Where Is My Mind? / `silverhand.orbital-envoy` | — | `takemura`, `hellman` — Medical state, visitor and contract belong to separate Arasaka predicates. |
| Where Is My Mind? / `silverhand.orbital-kerry-call` | — | `spoke` — Medical state, visitor and contract belong to separate Arasaka predicates. |
| Changes / `silverhand.body-beneficiary` | — | `v`, `johnny` — Body/destination choices need positive final selections. |
| Changes / `silverhand.mikoshi-jackie` | — | `engram`, `pendant` — Body/destination choices need positive final selections. |
| Path of Glory / `silverhand.rogue-afterlife` | — | `alive-after-solo`, `absent-after-death` — Epilogue route, partner, messages and heist acceptance need separate proof. |
| Path of Glory / `silverhand.kerry-sendoff` | — | `present` — Epilogue route, partner, messages and heist acceptance need separate proof. |
| Path of Glory / `silverhand.crystal-palace-job` | — | `departed` — Epilogue route, partner, messages and heist acceptance need separate proof. |
| New Dawn Fades / `silverhand.temperance-guitar` | — | `given` — Body owner, counterpart departure and farewell need exact branch proof. |
| New Dawn Fades / `silverhand.temperance-memorials` | — | `v-only`, `v-and-rogue` — Body owner, counterpart departure and farewell need exact branch proof. |
| New Dawn Fades / `silverhand.departure` | — | `left-city` — Body owner, counterpart departure and farewell need exact branch proof. |
| Who Wants to Live Forever / `silverhand.surgery-departure` | — | `boarded`, `postponed` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Who Wants to Live Forever / `silverhand.surgery-goodbye` | — | `conciliatory`, `hostile` — No exact native branch/outcome/audience join reviewed; narrative remains conditional. |
| Things Done Changed / `silverhand.surgery-outcome` | — | `cured-with-cost` — Cure outcome, time gap and contact responses need Phantom Liberty epilogue proof. |
| Things Done Changed / `silverhand.kerry-contact` | — | `spoke` — Cure outcome, time gap and contact responses need Phantom Liberty epilogue proof. |
| Things Done Changed / `silverhand.tower-return` | — | `returned` — Cure outcome, time gap and contact responses need Phantom Liberty epilogue proof. |
