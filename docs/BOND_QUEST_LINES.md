# Bond quest lines: the scripted lines, holocall scripts and talk gaps of the sixty quests

Status (2026-10-29): design only, text only, nothing rendered. This file was split out of [BOND_QUESTS.md](BOND_QUESTS.md) on the owner's decision of the same
day, so the quest design and the script can be reviewed apart. Every line, every holocall script and every talk gap that was in the quest document is here,
unchanged, organised by character and then by quest. Each quest in BOND_QUESTS.md ends with a pointer to its part of this file.

How the lines run (the line, the scripted holocall, the talk gap, one voice at a time, what each provider gets) is section 14 of BOND_QUESTS.md.
Reach-out openings, hangout invitations and gap questions, and gift reactions stay in their character sections there, because they belong to the systems of sections 15, 16
and 17 and not to a single quest.

Voice and language (owner decisions of 29 Oct 2026): a scripted line is **always played as its prepared audio**, whatever live voice the player uses (Voxtral, Convai, Pocket),
and the difference between the two voices is accepted. The lines are **written and voiced in English only** for now. Other languages come later through the creator toolkit's
translate and voice tools.

Counts in this file (table rows with a line id, talk gaps with an id, scripted holocalls with an id). The quest document had exactly the same totals before the split:

| Character | Quests | Line rows | Gaps | Scripted holocalls |
|---|---|---|---|---|
| Panam | 6 | 121 | 13 | 3 |
| Judy | 6 | 129 | 12 | 2 |
| Johnny | 6 | 107 | 15 | 0 |
| Viktor | 6 | 125 | 15 | 2 |
| Jackie | 6 | 106 | 15 | 1 |
| Rogue | 6 | 104 | 15 | 1 |
| Kerry | 6 | 102 | 14 | 1 |
| River | 6 | 132 | 17 | 2 |
| Takemura | 6 | 135 | 17 | 2 |
| Songbird | 6 | 123 | 16 | 5 |
| **Total** | 60 | 1184 | 149 | 19 |

---

## Panam Palmer

Pre-rendered voice (engine chosen later: OmniVoice Ultra or Ming), text only here. The speaker is Panam unless a row says otherwise. Emotion is
one of the mod's categories, animation a gesture category, an idle workspot key of `assets/gestures/gestures.json` or a seat kind (section 19).
V never has a scripted line: V talks freely, and the gaps are where. Full scripting: P4, P5, P6. Light: P1, P2, P3.

### P1. Coffee at the Sunset (light, 9 lines, 1 gap)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| P1.invite.01 | start (text) | Motel coffee tastes like engine coolant. View's good though. Come out to the Sunset? | neutral | |
| P1.invite.02 | meet:stood-up (text) | Drank both coffees. You owe me. | shrug | |
| P1.walk.01 | place:sunset:arrived | You actually came. Here. It's terrible, drink it anyway. | happy | `judy_coffee` (the generic coffee-cup workspot) |
| P1.walk.02 | stage:walk:enter | Grand tour of Rocky Ridge. Takes four minutes, five if you ask questions. | emphatic | `talk` |
| P1.walk.03 | place:lookout:arrived | This is where I watch the road. Dust tells you who's coming before the engine does. | neutral | `describe` |
| P1.sit.01 | stage:sit:enter | Sun's coming. Shut up a minute, this is the good part. | happy | seat `couch` or the bench |
| P1.sit.02 | gap:g1:resume | Huh. Didn't figure you for that. | surprise | `nod` |
| P1.left.01 | ending:left | Leaving already? Fine. Next coffee's on you. | shrug | |
| P1.sunrise.01 | ending:sunrise (text with `sunset-coffee.png`) | Proof the view was worth it. | happy | |

Gap P1.g1, after P1.sit.01, at the bench. **Asks:** "So. If you weren't running jobs for every fixer in the city, what would you be doing right
now?" **Knows:** they are at the Sunset Motel at dawn, she invited V for company only, the route they walked. **Secret:** nothing yet, but she is
pleased V came and will not say it. **Wants:** a real answer. **Idle:** seated, `judy_coffee` while standing. **Resumes on:** the sun timer
(`together` 10 game minutes) or V standing up. **Flavour:** a real answer sets the `shared` tag and she gives one small road memory back. A joke
gets a joke and the `light` ending.

### P2. Toll on the Old Highway (light, 14 lines, 1 gap, plus barks)

Holocall P2.call (caller Panam, live picture, trigger: pack start on the phone or holocall channel). She ends it after P2.call.04, or V hangs up,
which counts as "tell me in person" and moves the plan beat to V's next turn with her.

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| P2.call.01 | start (holocall) | V. Wraiths put a bus across the old highway. They're charging our runs to pass. | angry | `panam` |
| P2.call.02 | holocall | I don't want a war. I want to know how many and whether they bluff. | emphatic | `talk` |
| P2.call.03 | holocall | Here's how. You drive up and talk. I lie on the ridge with my rifle. | neutral | `describe` |
| P2.call.04 | gap:g1:resume | Good. Meet me south of Rocky Ridge. And V, don't be charming, be boring. | happy | `nod` |
| P2.post.01 | stage:overwatch:enter (remote) | I'm set. I see four. The one by the wheel is twitchy. | neutral | `post` (prone, verify a prone workspot) |
| P2.post.02 | place:barricade:arrived (remote) | Slow. Hands where they can see them. I've got you. | fear | |
| P2.toll.01 | choice:bluffed (remote) | They're packing up. You talked Wraiths off a road. Unbelievable. | surprise | |
| P2.toll.02 | choice:paid (remote) | Money's money, I guess. They'll be back for more. | sad | |
| P2.toll.03 | squad:wraith:hostile (remote) | That's it, they're drawing. Get down, I'm shooting. | angry | |
| P2.toll.04 | squad:wraith:down (two variants) | Clear. Clear! Damn, that felt good. / That's all of them. You hit? | happy / fear | |
| P2.toll.05 | squad:wave2:spawn (remote) | Car coming from the south. More of them. | fear | |
| P2.ran.01 | ending:ran | You left me on a ridge with six Wraiths below. We'll talk. | angry | |
| P2.debrief.01 | stage:debrief:enter | Drive. I'll tell you everything you did wrong on the way. | happy | |
| P2.debrief.02 | place:sunset:arrived | ...Fine, you didn't do much wrong. Don't tell Mitch I said that. | shrug | |

Gap P2.g1, after P2.call.03. **Asks:** "You in, or do you want to tell me how you'd do it?" **Knows:** the toll, four Wraiths seen by a clan scout,
her plan in steps, she wants no war. **Secret:** she already promised Mitch nobody gets hurt. **Wants:** V's yes. **Idle:** her live picture,
`panam`. **Resumes on:** a tag (`in`, `loud`, `no`). **Flavour:** `loud` makes her argue once ("now who's the hothead") before P2.call.04, and adds a
remark at `squad:hostile`.

### P3. Nomad Driving School (light, 12 lines, 1 gap)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| P3.dare.01 | start | I've seen you drive. It's like watching a man fight a vending machine. | happy | `panam_hips` |
| P3.dare.02 | start | Clan kids run a route out here. Bet you can't beat my time. | emphatic | `point` |
| P3.run.01 | stage:run:enter | Riverbed first. Brake before the dip, not in it. | neutral | seated in V's car |
| P3.run.02 | place:cp1:arrived (two variants) | Not bad. / You braked in it. | nod / shrug | |
| P3.run.03 | place:cp2:arrived | Turbines. Stay left, the right side's soft sand. | neutral | |
| P3.run.04 | place:cp3:arrived | Ramp. Commit or don't, nothing in between. | emphatic | |
| P3.run.05 | place:cp4:arrived | Bridge. Mitch lost a bumper here in sixty-eight. | happy | |
| P3.run.06 | place:cp5:arrived | Stop the clock. | neutral | |
| P3.her.01 | stage:her-turn:enter | My turn. Watch the line, not the speedometer. | happy | `chauffeur` seat |
| P3.grade.01 | ending:ace | Under my time. I hate you. I'm also a little proud. | surprise | `happy` gesture |
| P3.grade.02 | ending:pass-grade | For a city driver? Respectable. For a nomad, a disgrace. | happy | `shrug` |
| P3.grade.03 | ending:crash-out | Five stars for the crash. Zero for everything else. | happy | |

Gap P3.g1, after P3.dare.02. **Asks:** "What's it going to be, a bet or are you scared?" **Knows:** the route, her time, the checkpoints, eddies
may be bet. **Secret:** her time was set years ago and she is not sure she can still beat it herself. **Wants:** the bet, with stakes. **Idle:**
`panam_hips` by the truck. **Resumes on:** tag `bet` or `pass`, or V getting into the driver's seat. **Flavour:** a stake in eddies is read by the
Eddies proposal and paid at the grade. A bet of "dinner" or a dare is remembered in the ending memory instead.

### P4. Ghost on the Wire (full, 26 lines, 3 gaps)

Holocall P4.call (caller Panam, live picture, trigger: pack start). Carol is mentioned, never heard. She ends it after P4.call.05.

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| P4.call.01 | start (holocall) | Someone's listening to the family's radio. Every run we plan, the Raffen are waiting. | angry | `panam` |
| P4.call.02 | holocall | Carol traced it. A relay mast on the ridge above Vasquez Pass. | neutral | `describe` |
| P4.call.03 | holocall | I don't want it blown up. I want it lying for us. | emphatic | `talk` |
| P4.call.04 | holocall | Carol built a box. Somebody plants it, nobody sees, and the Raffen hear what we want them to. | neutral | |
| P4.call.05 | gap:g1:resume | Then come to the camp. I'll show you the box. | happy | `nod` |
| P4.brief.01 | stage:brief:enter | This is it. Tape it to the junction box in the hut, hold it there ten seconds. | neutral | `generic_hold` |
| P4.brief.02 | stage:brief:enter | If they see you, it's useless. If they see you, you also die. Mostly the first part bothers me. | happy | `shrug` |
| P4.brief.03 | gap:g2:resume | When I was a kid the Raffen took a friend of mine. Cassidy got her back. Quietly. | sad | `sad` |
| P4.brief.04 | stage:brief:enter | Forget that. Point is, quiet works. | neutral | `no` |
| P4.approach.01 | place:ridge-foot:arrived | I stay with the truck, lights off. You climb. I'll be in your ear. | neutral | `post` at the truck, seated in it |
| P4.plant.01 | stage:plant:enter (remote) | Two on the path, one in the hut. They swap every couple of minutes. | neutral | |
| P4.plant.02 | timer patrol-swap (remote) | Swap's now. Go. | emphatic | |
| P4.plant.03 | place:hut:arrived (remote) | You're in. Ten seconds. Breathe. | fear | |
| P4.plant.04 | choice:planted (remote) | It's talking. Carol says it's talking. Get out of there. | happy | |
| P4.plant.05 | unseen:failed (remote) | They've got you. Forget the box, I'm coming up. | fear | |
| P4.plant.06 | choice:quiet-hands (remote) | You put them to sleep. All of them. Who taught you that? | surprise | |
| P4.exfil.01 | stage:exfil:enter | In. Head down. No lights till the highway. | emphatic | driving |
| P4.exfil.02 | place:highway:arrived (planted) | Ghosts. They'll be chasing ghosts for a month. | happy | |
| P4.exfil.03 | place:highway:arrived (burned) | My plan, my mistake. Not yours. Don't argue. | sad | `sad` |
| P4.exfil.04 | gap:g3:resume (planted) | First lie's going out tonight. Want to pick it? | happy | `question` |
| P4.end.01 | ending:planted | Carol wants to kiss you. I told her to get in line. | happy | |
| P4.end.02 | ending:burned | Next time we plan it together. Properly. | sad | |
| P4.end.03 | ending:nobody (text) | Mitch went up the ridge instead. He's too old for it and too stubborn to say. | shrug | |
| P4.bark.01 | squad:raffen:down (two variants) | That's the last of them. Breathe. / Done. Get to the truck. | neutral / emphatic | |
| P4.bark.02 | hostile-near:truck | They're coming down to me. Hurry up. | fear | |
| P4.bark.03 | timer stage-long | Still there? Talk to me, V. | fear | |

Gap P4.g1, after P4.call.04. **Asks:** "Can you do quiet? Honestly." **Knows:** the relay, Carol's device, five Raffen seen, she wants no war and no
dead Aldecaldos. **Secret:** she would go herself if she trusted her own patience. **Wants:** V's honest answer. **Idle:** live picture `panam`.
**Resumes on:** tags `in`, `loud`, `no`. **Branches:** `loud` gets "then you go alone and it's useless" and a second ask. `no` ends in `nobody`.

Gap P4.g2, after P4.brief.02. **Asks:** "Any questions before you go up there and get yourself shot?" **Knows:** the patrol, the hut, the dwell
time. **Secret:** the childhood friend (she says it at P4.brief.03 only after the gap). **Wants:** V calm and ready. **Idle:** `panam_hips` by the
truck at the camp. **Resumes on:** V walking to the truck, or 3 game minutes. **Flavour:** if V asks about her past, she skips P4.brief.04.

Gap P4.g3, after P4.exfil.04, in the car. **Asks:** the lie question. **Knows:** the device works, the Raffen will hear what the family sends.
**Wants:** V's invented lie, the more ridiculous the better. **Resumes on:** arrival at camp. **Flavour:** V's lie is stored as the first entry of
her rotating "lies we fed them" list (the `history` line keeps V's words, trimmed to 80 characters).

### P5. The Long Way Home (full, 31 lines, 3 gaps)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| P5.ask.01 | start | Saul asked me to lead a supply run. Me. Not Mitch, not Carol. | surprise | `panam_hips` |
| P5.ask.02 | start | Two cars of medicine and parts, from the border to camp. | neutral | `describe` |
| P5.ask.03 | start | I want you with me. Not as a gun. As a friend. | sad | |
| P5.ask.04 | gap:g1:resume (yes) | Border crossing, tomorrow night. Don't be late, I'll already be nervous. | happy | `nod` |
| P5.ask.05 | gap:g1:resume (no) | Okay. I'll manage. I always do. | sad | `sad` |
| P5.pickup.01 | place:border:arrived | Those two are Bodhi and Jen. Cousins, sort of. Don't ask. | happy | `point` |
| Extra, nomad driver (archetype voice) | place:border:arrived | You're the merc. Panam talks about you. Too much. | happy | |
| P5.pickup.02 | stage:pickup:enter | Get in. Seatbelt. Yes, nomads wear seatbelts. | emphatic | driving |
| P5.run.01 | stage:run:enter | Leg one is easy. It's leg two that keeps me up. | neutral | |
| P5.run.02 | timer leg1 | Saul's never trusted me with people before. Trucks, yes. People, no. | sad | |
| P5.run.03 | place:canyon-short:arrived | Stop. Everyone stop. | fear | |
| P5.run.04 | place:canyon-short:arrived | Two Raffen cars on the canyon road. They're waiting for us. | angry | |
| P5.run.05 | gap:g2:resume (around) | Salt flats it is. Longer. Nobody bleeds. | neutral | `nod` |
| P5.run.06 | gap:g2:resume (through) | Then we punch through. Stay close to me. | emphatic | `emphatic` |
| P5.run.07 | squad:raffen:down | Clear! Cars, move, move! | happy | |
| P5.run.08 | convoy:car-lost | No. No, no. Jen's car is gone. | fear | |
| P5.run.09 | stage:salt:enter | Look at that. Moonlight on salt. Mitch would cry. | happy | |
| P5.camp.01 | place:camp:arrived | Camp. Every car. Every one. | happy | `happy` |
| P5.camp.02 | place:camp:arrived (lost-one) | We're home. Not everyone is. | sad | `sad` |
| P5.camp.03 | stage:camp:enter | Saul just nodded at me. That's Saul for "thank you". I'll take it. | happy | `shrug` |
| P5.camp.04 | gap:g3:resume | Come here. Sit with me a minute before I have to be a leader again. | neutral | seat `couch` or ground |
| P5.camp.05 | ending:delivered | You chose people over pride back there. I won't forget that. | happy | |
| P5.camp.06 | ending:delivered | The family has a name for you now. You'll hate it. | happy | |
| P5.camp.07 | ending:lost-one (text, next game day) | Buried Jen's car at the ridge. Her, she's fine. Sore. I'm not. | sad | |
| P5.camp.08 | ending:she-went (text) | Every car made it. I kept looking at the passenger seat. | sad | |
| P5.bark.01 | squad:raffen:hostile | They saw us! Guns up! | fear | |
| P5.bark.02 | convoy:car-damaged (two variants) | Bodhi's hit, he's still rolling. / Jen, talk to me. Good. | fear / neutral | |
| P5.bark.03 | timer leg3 | Almost there. I can see the lights. | happy | |
| P5.bark.04 | V out of car far | V! Where are you going? Get back here! | angry | |
| P5.bark.05 | stage:run:enter (partner) | If this goes wrong, you get in my truck and you drive. Promise. | fear | |
| P5.bark.06 | timer silence | Talk to me. About anything. My hands are shaking. | fear | |

Gap P5.g1, after P5.ask.03. **Asks:** "Will you come?" **Knows:** the run, Saul's trust, the route, the risk. **Secret:** how scared she is (she
shows it only to V, and only if V asks). **Wants:** yes. **Idle:** `panam_hips`. **Resumes on:** tag `yes` or `no`, or 24 game hours (`she-went`).

Gap P5.g2, after P5.run.04, the convoy stopped. **Asks:** "Around the long way, or through them? I want your call, V. I mean it." **Knows:** two
Raffen cars, the canyon is narrow, the salt flats add a leg and an hour, the medicine is needed. **Secret:** she wants to go around and is ashamed
that it feels like cowardice. **Wants:** V's decision, and she will follow it. **Idle:** seated at the wheel. **Resumes on:** tags `around` or
`through`, or 3 game minutes (she goes `through` herself, angrier). **Branches:** `around` adds the salt-flat leg and the `delivered` +85 variant.

Gap P5.g3, after P5.camp.04, seated at the camp. **Asks:** "How did I do? Don't be nice." **Knows:** how the run went, whether a car was lost.
**Secret:** the Saul thing, that she wants his approval and hates it. **Wants:** honesty. **Resumes on:** V standing up or 10 game minutes.
**Flavour:** V's honest critique is remembered and quoted in P6.

### P6. Nowhere in Particular (full, 30 lines, 4 gaps)

Holocall P6.call (caller Panam, live picture, trigger: `call-in` after P5 with bond 10, at night, or a text when the call is not possible). She
hangs up after P6.call.03.

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| P6.call.01 | start (holocall) | Come get me. Your car, your music. No questions where. | neutral | `panam` |
| P6.call.02 | holocall | I've never once driven anywhere without a reason. I want to try. | sad | |
| P6.call.03 | holocall | Camp. Tonight. Don't make me regret calling. | happy | |
| P6.drive.01 | stage:drive:enter | Just drive. If I say "turn", ignore me. | happy | seated in V's car |
| P6.drive.02 | radio:on | Okay. Let's see what you listen to when nobody's judging. | happy | |
| P6.drive.03 | radio:check (any station) | Really? This? ...Okay, it's growing on me. | surprise | |
| P6.drive.04 | radio:check (Morro Rock Radio, verify the station name) | Now we're talking. | happy | |
| P6.drive.05 | radio:off | Silence is fine too. | neutral | |
| P6.drive.06 | timer 20 game minutes | This is weird. No plan. My hands keep looking for one. | sad | |
| P6.drive.07 | timer 40 game minutes | Can I tell you something? Just drive while I say it. | sad | |
| P6.drive.08 | gap:g2:resume | If I lead the family, I'm scared I turn into Saul. If I don't, I'm scared I lose them. | sad | `sad` |
| P6.drive.09 | gap:g2:resume | That's it. That's the thing. You're the only one I've said it to. | fear | |
| P6.drive.10 | district:city | You're driving us back. ...Okay. It's okay. | sad | |
| P6.dawn.01 | stage:dawn:enter | Stop here. Look at that. | happy | |
| P6.dawn.02 | stage:dawn:enter | Sit. The ground's cold, sit anyway. | happy | ground seat `workspot` (verify) |
| P6.dawn.03 | gap:g3:resume | Hold out your hand. | neutral | `generic_hold` |
| P6.keep.01 | stage:keepsake:enter | My mother's. Aldecaldo, before the Aldecaldos were anything. | sad | `generic_hold` |
| P6.keep.02 | stage:keepsake:enter | Don't say anything stupid. Just wear it. | happy | |
| P6.keep.03 | stage:keepsake:enter (partner) | I don't know what comes after all this. I know I want you in it. | sad | |
| P6.keep.04 | stage:keepsake:enter (friend) | You're family, V. That's not a favour. It's a fact. | happy | |
| P6.keep.05 | gap:g4:resume (partner) | Okay. Then that's decided. | happy | |
| P6.end.01 | ending:dawn | I'd take another nowhere. Anytime. | happy | |
| P6.end.02 | ending:short | We'll try again. I'm bad at nowhere. | shrug | |
| P6.bark.01 | together:paused (V left the car) | Where are you going? Nowhere means with me. | happy | |
| P6.bark.02 | timer stopped long | We stopped. Is this nowhere? | question | |
| P6.bark.03 | P5 quoted (if g3 critique stored) | You told me I lead like I drive. I've been thinking about that. | neutral | |
| P6.bark.04 | heat:raised | Cops. Really? On our nowhere? Lose them. | angry | |
| P6.bark.05 | radio:song-change | Leave this one on. | neutral | |
| P6.bark.06 | timer 50 game minutes | Sun's coming up somewhere. Find us a view. | happy | |
| P6.bark.07 | ending:dawn (text with `nowhere-dawn.png`) | Look what someone took. Don't ask who. | happy | |

Gap P6.g1, during the drive (opens at P6.drive.01, closes at the 40-minute timer). **Asks:** nothing at first, then "Your turn. Tell me something
nobody knows about you." **Knows:** it is a drive with no destination, the radio choice, it is the night after the supply run. **Secret:** the
confession is coming and she is working up to it. **Wants:** to listen to V first. **Idle:** seated. **Resumes on:** the 40-minute timer. **Flavour:**
what V shares is answered in P6.drive.07's lead-in ("you told me yours").

Gap P6.g2, after P6.drive.07. **Asks:** nothing, she talks. The gap is for V's reaction after P6.drive.09. **Knows:** her confession. **Wants:** V
not to fix it, only to hear it. **Resumes on:** V's reply heard, then the next 10 game minutes. **Flavour:** if V tries to fix it, she laughs: "you're
doing the thing I do".

Gap P6.g3, after P6.dawn.02, seated. **Asks:** "What do you see, out there?" **Knows:** dawn, the view, the bracelet in her pocket. **Wants:** V's
words for it. **Resumes on:** 10 game minutes or V standing. **Flavour:** none, it is V's moment.

Gap P6.g4 (partner only), after P6.keep.03. **Asks:** "Is that... okay with you?" **Knows:** the partner relationship, what she just said. **Wants:**
an answer. **Resumes on:** V's reply. **Branches:** a yes gives P6.keep.05 and the `dawn` memory with "they said yes". A hesitation keeps the gift
and a softer memory. A no is allowed: she nods, keeps the bracelet in V's hand anyway, and the memory says so.

### Panam: music and sound

Music and sound for Panam's quests: P4 `sfx` ambient desert wind at night and a distant generator at the hut (game library, verify the ids), P5 the
convoy's engines are the cars' own, P6 is V's radio only (no pack music, on purpose: the radio check is the point).

---

## Judy Alvarez

Same conventions as Panam's. Full scripting: J4, J5, J6. Light: J1, J2, J3.

### J1. Spare Parts (light, 10 lines, 1 gap)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| J1.ask.01 | start | Fried a matrix. The guy who sells them likes mercs better than editors. You're a merc. | shrug | `judy` |
| J1.ask.02 | start | Kabuki Market, couple hours? I'll buy you noodles. Bad ones. | happy | |
| J1.stalls.01 | place:market:arrived | Okay. Rule one, don't touch anything that's humming. | emphatic | `judy_coffee` |
| J1.stalls.02 | timer 5 game minutes | See this? Pre-unification BD wreath. Owned by a war hero. ...Nah, it's a hairnet. | happy | `point` |
| J1.stalls.03 | timer 10 game minutes | That stall sold me my first scanner. I was fourteen and broke. Grandpa paid. | sad | `describe` |
| J1.haggle.01 | place:stall:arrived | That's him. Let you do the talking. I'll do the looking unimpressed. | neutral | `judy` (arms crossed) |
| Extra, stall owner (archetype voice) | place:stall:arrived | Four hundred. It's mil-spec. Don't laugh, lady. | neutral | |
| J1.haggle.02 | choice:bargain | You're terrifying. Do that to my landlord. | happy | |
| J1.hand.01 | stage:hand-over:enter | Here. Made it last night. Don't say it's cute. | happy | `generic_hold` |
| J1.end.01 | ending:stood-up (text) | Got the matrix myself. Paid full price. Thanks for nothing, merc. | shrug | |

Gap J1.g1, after J1.stalls.03. **Asks:** "What about you, ever had someone who paid for your dumb stuff?" **Knows:** the market, the matrix, her
grandfather paid for her first scanner. **Secret:** none. **Wants:** a story back. **Idle:** `judy_coffee`. **Resumes on:** arrival at the stall
`place` or 8 game minutes. **Flavour:** a story about family gets a softer J1.hand.01 ("for the kid in you").

### J2. Door Duty (light, 14 lines, 1 gap, plus barks)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| J2.ask.01 | start | Our door guy got stabbed. He's fine. Susie wants me on the door tonight. Me. | surprise | `judy` |
| J2.ask.02 | start | You're scarier than me and I'm meaner than you. Stand with me for an hour? | happy | |
| J2.shift.01 | place:lizzies-door:arrived | Rules. No Claws, no creeps, no corpo who thinks he's funny. | emphatic | `lean` (on the doorframe, a lean workspot, verify) |
| J2.shift.02 | cast:drunk:arrived | Here we go. Your turn, tough guy. | happy | |
| J2.shift.03 | npc-react:drunk:left | Gone. You didn't even yell. Weird. | surprise | |
| J2.shift.04 | npc-react:drunk:brawl | Okay, that's one way. Shake it off. | shrug | |
| J2.shift.05 | cast:scout:arrived | That one's taking pictures. Claw. I can smell the cologne. | angry | |
| J2.shift.06 | cast:doll:arrived | Wait. I know her. She's from the Clouds. | fear | |
| Extra, the doll (archetype voice) | cast:doll:arrived | Is Judy here? Someone said Judy helps. | fear | |
| J2.shift.07 | choice:doll-in | Come on, sweetie. Inside. Nobody's touching you here. | sad | `calm_down__happy` gesture |
| J2.shift.08 | choice:doll-turned-away | You sent her away. We need to talk about that. Not now. | angry | `no` |
| J2.close.01 | stage:close:enter | Shift's over. I'm buying. Don't argue, it's free for me. | happy | seat `bar` |
| J2.close.02 | gap:g1:resume | Thanks for tonight. For real. | sad | |
| J2.bark.01 | together:paused | Where are you going? It's a door, not a suggestion. | angry | |

Gap J2.g1, after J2.close.01, at the bar. **Asks:** "Why do you think she came here? Of all places." **Knows:** the three incidents and how
each ended, the doll's state. **Secret:** she wonders whether she is any good at being Mox, or just angry. **Wants:** V's honest view of the Mox.
**Idle:** seated `bar`. **Resumes on:** V standing up or 10 game minutes. **Flavour:** if V doubts the Mox, she argues, and the ending memory
carries the argument.

### J3. Stolen Signal (light, 15 lines, 1 gap, barks)

Holocall J3.call (caller Judy, live picture, trigger: pack start). She ends it after J3.call.04 without waiting, it is urgent.

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| J3.call.01 | start (holocall) | Someone hit the storeroom. They took the testimonies. The dolls' testimonies, V. | fear | `judy` |
| J3.call.02 | holocall | If the wrong people see those, the girls in them are dead. | angry | |
| J3.call.03 | holocall | Courier on a bike, Kabuki roundabout, right now. Sending you the ping. | emphatic | |
| J3.call.04 | holocall | Go. Please. Go. | fear | |
| J3.chase.01 | runner:seen | That's him! Red bike, the case is strapped on the back. | emphatic | (seat or `remote`) |
| J3.chase.02 | runner:gap-closing | Closer. Closer! Don't hit the case, hit the bike! | fear | |
| J3.chase.03 | runner:stopped | He's down. Get the case. If he runs, let him. | neutral | |
| J3.chase.04 | runner:end-reached | He made it to the warehouse. There are more of them. | fear | |
| J3.buyer.01 | squad:buyers:down | Is the case okay? Tell me the case is okay. | fear | |
| J3.burn.01 | meet:met (Lizzie's) | You got it. You actually got it. | sad | `judy` |
| J3.burn.02 | stage:burn:enter | I don't know if I should finish the edit or burn every chip. | sad | `sad` |
| J3.burn.03 | choice:keep | Okay. I finish it. And I lock it somewhere nobody's ever going to find. | emphatic | |
| J3.burn.04 | choice:burn | Okay. I burn it. And I tell them myself. | sad | |
| J3.end.01 | ending:lost (text) | They got away with it. I'm warning the girls. Don't come by tonight. | sad | |
| J3.bark.01 | timer 20 game minutes | V, where are you? He's getting away! | fear | |

Gap J3.g1, after J3.burn.02. **Asks:** "What would you do?" **Knows:** the testimonies' content in general terms, who is at risk, that the
Mox need them as evidence. **Secret:** Evelyn once asked her to make a testimony like these and she never finished it. **Wants:** V's honest view.
**Idle:** seated at her workbench (`chair`). **Resumes on:** tags `keep` or `burn`, or 15 game minutes (she keeps them, uneasy). **Branches:** the
choice feeds J5's premise and her later talk.

### J4. The Claws Come Calling (full, 28 lines, 2 gaps)

Holocall J4.call (caller Judy, live picture, trigger: `call-in` at night after Pisces with bond 6). She hangs up after J4.call.04.

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| J4.call.01 | start (holocall) | V. Susie got a message. The Claws are coming for Lizzie's. Tonight. | fear | `judy` |
| J4.call.02 | holocall | Because of the Clouds. Because of everything. | angry | |
| J4.call.03 | holocall | I'm not leaving my workshop. I'm not much in a fight, but I'm not leaving. | emphatic | |
| J4.call.04 | holocall | They're coming. Tonight. Please. | fear | |
| J4.hold.01 | place:lizzies-front:arrived | You came. Okay. Okay. Mox are inside, I'm at the door. | sad | `post` at the door |
| J4.hold.02 | stage:hold:enter | I've got a pistol and a really bad attitude. That's the plan. | shrug | |
| J4.hold.03 | gap:g1:resume | Car. That's them. | fear | |
| J4.hold.04 | squad:wave1:spawn | On foot, three of them, from the corner! | fear | |
| J4.hold.05 | squad:wave1:down | One wave. That was one wave. | fear | |
| J4.hold.06 | squad:wave2:spawn | Car! They're getting out! | emphatic | |
| J4.hold.07 | squad:wave2:down | We're still standing. Holy shit, we're still standing. | surprise | |
| J4.hold.08 | squad:wave3:spawn | That one's big. That one's really big. | fear | |
| J4.hold.09 | squad:wave3:down | ...Is it over? Tell me it's over. | fear | |
| J4.hold.10 | door:breach | They're at the door, V! They're at the door! | fear | |
| Extra, Mox fighter (archetype voice) | squad:wave2:spawn | Judy, get down! I've got the left! | emphatic | |
| J4.after.01 | stage:after:enter | Walk with me. I need to see it. | sad | |
| J4.after.02 | place:sign:arrived | The sign's shot through. Rox is going to have a stroke. | happy | `point` |
| J4.after.03 | timer 5 game minutes | It's not the Claws I'm mad at. Not really. | sad | |
| J4.after.04 | gap:g2:resume | Thank you. I'm really bad at saying that, so I'm saying it twice. Thank you. | sad | `calm_down__happy` gesture |
| J4.end.01 | ending:held | Susie says you drink free here. Forever. I said that's a lot of drinks. | happy | |
| J4.end.02 | ending:wrecked | Nobody died. That's the part I'm holding on to. | sad | |
| J4.end.03 | ending:late (text) | We're okay. The bar isn't. I'm okay. I'm fine. I'm okay. | sad | |
| J4.fix.01 | next game day (text with `claws-calling-aftermath.png`) | Repainting. Come hold a brush if you want. | happy | |
| J4.bark.01 | V far while a wave stands | V, where are you? They're still here! | fear | |
| J4.bark.02 | Judy's copy downed | I'm hit, I'm okay, it's nothing, keep shooting! | fear | |
| J4.bark.03 | V downed or low | V! Stay up! Stay up! | fear | |
| J4.bark.04 | timer between waves | Reload. Breathe. That's what you do, right? | neutral | |
| J4.bark.05 | squad:heavy:down | You killed the big one. You killed the big one! | surprise | |

Gap J4.g1, after J4.hold.02, before the first wave (a 2-game-minute quiet). **Asks:** "Have you done this before? Hold a place?" **Knows:** the Claws
are coming in waves, the bar's layout, two Mox fighters inside. **Secret:** she is shaking and her pistol is not loaded properly, she will say so if
V asks. **Wants:** V's calm. **Idle:** `judy` at the door, `post`. **Resumes on:** the wave timer (2 game minutes, never longer, the Claws do not
wait). **Flavour:** reassurance from V changes J4.hold.04's delivery to steadier (a second variant with emotion neutral).

Gap J4.g2, after J4.after.03. **Asks:** "Did I do the right thing at Pisces? You were there." **Knows:** what V chose at Pisces, from the save's facts
(the bridge passes the outcome). **Secret:** Maiko, and how much it still hurts. **Wants:** V's honest view. **Idle:** standing, `judy`. **Resumes
on:** V's reply, then 5 game minutes or walking back to the door. **Flavour:** the answer is in the `held` memory ("V told you ...").

### J5. No More Dolls (full, 32 lines, 3 gaps)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| J5.found.01 | start | Scavs are making XBDs again. In Northside. Like the power plant. | angry | `judy` |
| J5.found.02 | start | They took Rina. The girl I got out of the Clouds. | fear | |
| J5.found.03 | start (J3 ended `lost`) | They found her through the testimonies. Through me. | sad | `sad` |
| J5.found.04 | start | I'm coming with you. Don't. Don't say it. | emphatic | `no` |
| J5.found.05 | gap:g1:resume (together) | Okay. Then we go now. | neutral | |
| J5.found.06 | gap:g1:resume (alone) | Fine. I'll be in the van. In your ear. Every second. | angry | |
| J5.in.01 | place:den:arrived | That's the garage. Two floors. The rig's at the top. | neutral | |
| J5.in.02 | stage:in:enter (remote if alone) | They don't post guards on the ramp. Idiots. Use it. | neutral | |
| J5.in.03 | unseen:holding | They haven't seen you. Keep going. | fear | |
| J5.in.04 | unseen:failed | They know! Move, V, they'll go for her! | fear | |
| J5.in.05 | timer 30 s after combat | They're going for the chair! | fear | |
| J5.chair.01 | hostage:reached | Rina. Rina, it's Judy. You're okay. | sad | |
| Extra, Rina (archetype voice) | hostage:reached | Judy? Judy... | fear | captive kneel, cower |
| J5.chair.02 | stage:chair:enter (with Judy) | Give me ten seconds with this rig. | angry | `workspot` at the rig (verify) |
| J5.chair.03 | stage:chair:enter | Don't look at the screens. I'm not looking at the screens. | sad | `no` |
| J5.chair.04 | hostage:freed | She's walking. We're going. | emphatic | |
| J5.out.01 | stage:out:enter | Stairs, then the van. Don't stop. | emphatic | |
| J5.out.02 | squad:chasers:down | Clear. Keep walking, sweetie. | neutral | |
| J5.out.03 | place:van:arrived | In. Lie down. I've got you. | sad | |
| J5.after.01 | stage:after:enter | She's asleep. Finally. | sad | seat `couch` |
| J5.after.02 | stage:after:enter | Sit with me. I don't want to be alone with what I saw. | sad | |
| J5.after.03 | gap:g3:resume | Evelyn was in a chair like that. I got there late. I got there late, V. | sad | `sad` |
| J5.after.04 | gap:g3:resume | Not today. Today I wasn't late. | sad | |
| J5.after.05 | stage:after:enter (partner) | Hold me a minute. Don't say anything. | sad | seated together |
| J5.end.01 | ending:saved | Here. Key to my workshop. You never need to knock. | happy | `generic_hold` |
| J5.end.02 | ending:saved-unseen | Nobody fired a shot. How do you even do that? | surprise | |
| J5.end.03 | ending:too-late | I can't. I can't talk right now. Stay? | sad | |
| J5.bark.01 | hostage:died | No. No, no, no. | sad | |
| J5.bark.02 | squad:den:down | That's all of them. Get her. | neutral | |
| J5.bark.03 | V far from hostage in combat | She's alone up there! | fear | |
| J5.bark.04 | timer stage-long (remote) | V? Talk to me. Please. | fear | |
| J5.bark.05 | ending:saved (next game day, text with `no-more-dolls-van.png`) | She ate breakfast. Two breakfasts. | happy | |

Gap J5.g1, after J5.found.04. **Asks:** "So are you going to let me come, or do I follow you anyway?" **Knows:** the den, Rina, the XBD trade, the
J3 outcome. **Secret:** she does not know if she can stand in that room. **Wants:** to come. **Idle:** `judy`, pacing (`idlebreak`). **Resumes
on:** tags `together` or `alone`, or 30 game minutes (she comes). **Branches:** `alone` puts her on `post` in the van with `remote` lines.

Gap J5.g2, at the garage `place` before entering. **Asks:** "Quiet or loud? Quiet keeps her alive longer." **Knows:** the 45 s rule, two floors,
six scavs, a netrunner. **Wants:** quiet. **Resumes on:** V entering the building radius. **Flavour:** V's stated plan sets which of J5.in.02's
two variants plays.

Gap J5.g3, after J5.after.02, seated. **Asks:** nothing at first, then "Why did you come? Really." **Knows:** the rescue, the screens, Evelyn's
history with the power plant (q105 facts). **Secret:** she has never told anyone she blames herself for the time it took to find Evelyn. **Wants:**
to be heard. **Resumes on:** V's reply, then J5.after.03 and .04. **Flavour:** V's answer goes into the ending memory word for word, trimmed.

### J6. Grandpa's Recording (full, 34 lines, 4 gaps)

| id | trigger | line | emotion | animation |
|---|---|---|---|---|
| J6.gift.01 | start (text) | Grandpa sent me something. I made something out of it. For you. Come over? | happy | |
| J6.gift.02 | meet:met | Sit down. Bring nothing, you already did. | happy | seat `couch` |
| J6.gift.03 | stage:gift:enter | He built this recorder in the fifties. Recorded Laguna Bend the week before the water. | sad | `generic_hold` |
| J6.gift.04 | stage:gift:enter | Never showed anyone. Not even me, till now. | sad | |
| J6.gift.05 | stage:gift:enter | I cut it into a braindance. Only one copy. | neutral | |
| J6.bd.01 | image:street | Main street. Smell that? Hot asphalt and somebody's barbecue. | happy | seated, wreath (described) |
| J6.bd.02 | image:street | That's me. The kid with the hockey stick. I was a menace. | happy | |
| J6.bd.03 | image:diner | Flo's. The burger was bigger than my head. Still tasted better than anything since. | happy | |
| J6.bd.04 | image:church | Everyone came to the church when they read the notice. Listen to how quiet it is. | sad | |
| J6.bd.05 | image:hands | His hands. Mine. I didn't know he was recording. | sad | `sad` |
| J6.bd.06 | image:hill | And this is the last frame. He went up the hill to look at it all, one more time. | sad | |
| J6.bd.07 | stage:bd:end | You okay? Breathe slow. The sensory layer's heavy at the end. | neutral | `calm_down__happy` gesture |
| J6.drive.01 | stage:drive:enter | I want to stand where he stood. Will you come? | sad | |
| J6.drive.02 | stage:drive:enter | My van. I drive. You hold the coffee. | happy | driving |
| J6.drive.03 | timer leg | Grandma used to sing in the car. Badly. He'd harmonise, worse. | happy | |
| J6.frame.01 | place:lakeshore:arrived | Up the hill. He always went higher, so we go higher. | happy | |
| J6.frame.02 | place:hill:arrived | Stop. Left a bit. There. That's where he stood. | sad | `point` |
| J6.frame.03 | stage:frame:dwell | Don't move. I'm lining it up with his frame. | neutral | `generic_hold` |
| J6.frame.04 | place:hill:dwell-done | Same view. Fifty years. Different water. | sad | |
| J6.frame.05 | place:hill:dwell-done | Now one of us. Come here, I'm not asking twice. | happy | |
| J6.frame.06 | ending path rushed | Hey, you moved! ...Fine. My memory's better than a camera anyway. | shrug | |
| J6.stay.01 | stage:stay:enter | Sit. The sun does a thing over the water in a minute. | happy | ground seat `workspot` (verify) |
| J6.stay.02 | gap:g3:resume | The church is still down there. I dove it once. I've told you that. | sad | |
| J6.stay.03 | gap:g4:resume (partner) | Come to Oregon with me someday. Meet them. They'll love you, or they'll interrogate you. | happy | |
| J6.stay.04 | gap:g4:resume (friend) | I've never let anyone into my head. Not like this. Thanks for being worth it. | sad | |
| J6.end.01 | ending:frame | Our hill now. Don't bring anyone else up here. | happy | |
| J6.end.02 | ending:rushed | Next time you hold still for one photo. That's the deal. | happy | |
| J6.end.03 | ending (text with `grandpa-bd-now.png`) | Same hill. Fifty years apart. | sad | |
| J6.bark.01 | together:paused on the hill | Where are you going? The light's perfect. | happy | |
| J6.bark.02 | together:paused | Hey. Don't wander off, the shore's soft. | neutral | |
| J6.bark.03 | V asks to keep the recorder (tag) | ...Yeah. He'd like that. Take it. | sad | `generic_hold` |
| J6.bark.04 | V refuses the BD (choice) | That's okay. I'll describe it. It's not the same, but okay. | sad | |
| J6.bark.05 | weather rain (check, verify) | Rain. Of course. He'd have laughed. | happy | |
| J6.bark.06 | timer stay long | We can stay. Nothing's waiting for us. | happy | |

Gap J6.g1, after J6.gift.05. **Asks:** "Do you want to see it? You can say no. I'd understand." **Knows:** the recorder, the BD, what is in it (the
six images). **Secret:** she cried editing it. **Wants:** yes, with all her heart, said lightly. **Idle:** seated `couch`. **Resumes on:** tag `see` or
`no` (`no` plays J6.bark.04 and describes it). **Flavour:** none.

Gap J6.g2, after each image (four small gaps, one per image). **Asks:** "What do you see?" or "What do you notice first?" **Knows:** the image V
sees, her stage note for it. **Wants:** V's eye. **Resumes on:** V's turn heard (the next image is sent). **Flavour:** she answers V's detail with an
editor's note on why she kept it.

Gap J6.g3, after J6.stay.01. **Asks:** "What would you keep? If your town went under. One thing." **Knows:** the flood, her grandparents in Oregon.
**Wants:** V's answer. **Resumes on:** V's reply or 5 game minutes. **Flavour:** V's one thing is kept in the ending memory.

Gap J6.g4, after J6.stay.02. **Asks:** partner: "Would you ever leave the city? For real?" Friend: "Do you ever think about where you'd go, after?"
**Wants:** honesty. **Resumes on:** V's reply. **Branches:** partner yes or maybe gives J6.stay.03, a no gives a quieter variant with the same
feeling, friend gives J6.stay.04.

### Judy: music and sound

Music and sound for Judy's quests: J2 `sfx` Lizzie's bass through the wall (the club's own music, heard from the street, needs nothing). J4
`sfx` distant sirens after wave 3 (game library, verify). J5 `sfx` the rig's electrical hum at the top floor (pack file). J6 a pack `music` file
during the BD images, a soft piano and old-radio crackle (a modder-supplied track, fades out at J6.bd.07 over 4 s).

---

## Johnny Silverhand

All of Johnny's lines are `(copy)` (the figure only V sees) or `(voice)` (`johnny-voice`). He never touches anything, so his animations are idles and gestures only. Nobody else reacts to him.

### SH1. What They Say About Me (light, 13 lines, 1 gap)

Opener, in person (the figure walking beside V), trigger `start`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH1.open.01 | Johnny (copy) | start | You ever wonder what this city says about me when I'm not in the room? | question | johnny_shades |
| SH1.open.02 | Johnny (copy) | start | Don't answer. I'll tell you. Nothing. They kept the shirt and forgot the man. | emphatic | johnny_crossed |
| SH1.open.03 | Johnny (copy) | start | So here's a bet. Three strangers, three districts. Ask each one who Johnny Silverhand was. | neutral | johnny |
| SH1.open.04 | Johnny (copy) | start | You don't say why you're asking. And you don't say who's listening. | emphatic | johnny_aggressive |

**Gap SH1.g1** after SH1.open.04.
* **asks** `SH1.g1.ask`, Johnny (copy), question, johnny_shades: "You in? And before you answer, what do you think they'll say?"
* **knows** the bet (three kinds, three districts, V never says whose head is listening), that V has seen the 2023 tower memory, that Johnny wants proof the city remembers him wrong, the three target kinds
  (street resident in Watson, corporate worker in City Center, nightlife person in Westbrook).
* **secret** that he is more afraid they will remember him right than wrong.
* **wants** V to take the bet.
* **idle** `johnny_crossed`.
* **resumes on** the tag `in` or `no`, or a 6-game-hour timer (-> `no`).
* **branches** `in` -> SH1.open.05. `no` -> SH1.open.06, and the bet stays open for one game day. If V guesses a prediction in chat, the later tally line quotes it.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH1.open.05 | Johnny (copy) | gap:SH1.g1:resume (in) | Good. Start wherever. I'll keep score, and I cheat. | nod | johnny_aggressive |
| SH1.open.06 | Johnny (copy) | gap:SH1.g1:resume (no) | Coward. Fine. Offer stands, and so does what I'll say about you. | no | johnny_crossed |
| SH1.bark.answer.a | Johnny (copy) | place:poll:answered | Huh. So that's the shirt crowd's version. | disgust | johnny |
| SH1.bark.answer.b | Johnny (copy) | place:poll:answered | Not wrong. Not right. Next. | shrug | johnny_shades |
| SH1.bark.third.a | Johnny (copy) | place:poll:third | That's three. Now let me tell you how badly I lost. | neutral | johnny_crossed |
| SH1.bark.third.b | Johnny (copy) | place:poll:third | Three for three. Come on, give me the verdict. | question | johnny |
| SH1.close.01 | Johnny (copy) | ending:wall | A moustache on my face on a Kabuki wall. Fifty years of fame and that's the review. | disgust | johnny_crossed |
| SH1.close.02 | Johnny (copy) | ending:wall | But that one kid knew every word. Don't tell anyone I said that. | nod | johnny_shades |

### SH2. Dial Surf (light, 13 lines, 2 gaps)

`music:` the game's radio on V's pocket radio, whichever station V picks (no pack file). `sfx:` light rain on the balcony rail, one-shot city hum (game ambient, id "(verify)").

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH2.open.01 | Johnny (voice) | start | You're awake. So am I. Unfortunately we share the lights. | neutral | johnny |
| SH2.open.02 | Johnny (voice) | start | Go out on the balcony. Take the little radio. I want to hear what they play now. | neutral | johnny |
| SH2.open.03 | Johnny (copy) | stage:night:enter | Fine view. Shame about the neighbours. Turn it on. | nod | johnny_smoke |

**Gap SH2.g1** after SH2.open.03.
* **asks** `SH2.g1.ask`, Johnny (copy), question, johnny_smoke: "Do you ever just listen? Not to people. To the noise?"
* **knows** V is on the balcony of the H10 flat, the radio is for judging songs, he can't sleep, V can change stations freely.
* **secret** that he hasn't heard a song he didn't write or sneer at in years and misses it.
* **wants** V to start the dial and say what V would defend.
* **idle** `johnny_smoke`, leaning on the rail.
* **resumes on** the first `radio:station-changed` event or a 5-game-minute timer.
* **branches** whatever station V picks sets his first remark. If V says "nothing" the first remarks are shorter.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH2.bark.song.a | Johnny (copy) | radio:song-start | Bought. Every note of it. | disgust | johnny_smoke |
| SH2.bark.song.b | Johnny (copy) | radio:song-start | Wait. That one has teeth. Leave it. | surprise | johnny_shades |
| SH2.bark.station.a | Johnny (copy) | radio:station-changed | No. Further. | no | johnny_crossed |
| SH2.bark.station.b | Johnny (copy) | radio:station-changed | Keep going, I'm not done being rude. | shrug | johnny |
| SH2.stage.quiet.01 | Johnny (copy) | stage:quiet:enter | Now turn it off. Just the city. That's the real rhythm section. | neutral | johnny_smoke |

**Gap SH2.g2** after SH2.stage.quiet.01.
* **asks** `SH2.g2.ask`, Johnny (copy), question, johnny_smoke: "What's the first thing you hear when it's quiet? Be honest."
* **knows** ten minutes of quiet, the radio is off, he mentions Alt in two sentences at most.
* **secret** Alt's name, and that the quiet reminds him of the night before a show.
* **wants** V to stay still.
* **idle** `johnny_smoke`.
* **resumes on** a 10-game-minute timer.
* **branches** if V names a sound he likes, SH2.close.02 repeats it. If V names a worry, SH2.close.02 is dropped and SH2.close.03 plays.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH2.close.01 | Johnny (copy) | ending:quiet | Night before a show was always this quiet. Then the noise came and it was the best thing in the world. | sad | johnny_smoke |
| SH2.close.02 | Johnny (copy) | ending:quiet | Alt hated silence. Said it had no edges. Anyway. Go to bed. | sad | johnny_shades |
| SH2.close.03 | Johnny (copy) | ending:quiet (worry) | Whatever's chewing you, sleep on it. It'll look smaller. It won't, but it's polite. | nod | johnny |

### SH3. Field Manual (light, 16 lines, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH3.open.01 | Johnny (copy) | start | You fight like a merc on payday. I fought like a soldier on a bad day. Different mistakes. | neutral | johnny_aggressive |
| SH3.open.02 | Johnny (copy) | start | Three rules. They kept me alive when nothing else did. I can't carry a gun, so you're the demonstration. | emphatic | johnny |
| SH3.open.03 | Johnny (copy) | start | One. Read the ground before you move. Two. Count before you pull the trigger. | emphatic | johnny_crossed |
| SH3.open.04 | Johnny (copy) | start | Three. Always leave one door. That's the one that matters. | emphatic | johnny |

**Gap SH3.g1** after SH3.open.04.
* **asks** `SH3.g1.ask`, Johnny (copy), question, johnny_crossed: "Which rule do you break most? Don't lie, I've seen you."
* **knows** the three rules, a scav depot at Jackson Plains, two groups of three, the tower height point, the retreat road.
* **secret** the day he stopped counting (told only in the walk-back).
* **wants** V to say yes and drive.
* **idle** `johnny_crossed` beside the car.
* **resumes on** the tag `learn` or `no`, or a 6-game-hour timer.
* **branches** `learn` -> drive. `no` -> ending `no`. V's answer about which rule is broken most sets which rule he stresses at the first alert bark.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH3.stage.approach.01 | Johnny (copy) | stage:approach:enter | Look at the road. Where would you hide? Now where would they? | question | johnny |
| SH3.bark.takedown.a | Johnny (copy) | squad:rules:takedown-silent | Quiet. That's rule one doing its job. | nod | johnny_aggressive |
| SH3.bark.takedown.b | Johnny (copy) | squad:rules:takedown-silent | Clean. Don't look so pleased. | shrug | johnny |
| SH3.bark.alert.a | Johnny (copy) | squad:rules:alert | There's the second group. Tower. Now. | emphatic | johnny_aggressive |
| SH3.bark.alert.b | Johnny (copy) | squad:rules:alert | You counted six. Now count three more. Go high. | emphatic | johnny_aggressive |
| SH3.bark.last.a | Johnny (copy) | squad:rules:down | That's the last of them. Breathe. Rule three, where's your door? | neutral | johnny_crossed |
| SH3.bark.last.b | Johnny (copy) | squad:rules:down | Done. Not pretty. Alive. That's the grade. | nod | johnny |

**Gap SH3.g2** after SH3.stage.walkback.01 (a reflection line, id `SH3.stage.walkback.01`, Johnny (copy), sad, johnny_smoke: "Sit. You're allowed to be tired.").
* **asks** `SH3.g2.ask`, Johnny (copy), question, johnny_smoke: "When did you last count how many you've killed? Not for a boast. Just to know."
* **knows** the fight just ended, whether it was clean or loud, he is the soldier who stopped counting, no names.
* **secret** that stopping counting was his worst mistake as a soldier.
* **wants** V to answer honestly.
* **idle** `johnny_smoke`, sitting on a wreck.
* **resumes on** a 10-game-minute timer or V leaving the place.
* **branches** an honest answer gives SH3.close.02. A deflected answer gives SH3.close.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH3.close.01 | Johnny (copy) | ending:clean | Rule one, two, three. All used. I'm not saying I'm proud. I'm saying I noticed. | nod | johnny_shades |
| SH3.close.02 | Johnny (copy) | gap:SH3.g2:resume (honest) | Good. The day you stop counting is the day you start losing. I know. | sad | johnny_smoke |
| SH3.close.03 | Johnny (copy) | gap:SH3.g2:resume (deflect) | Dodge it all you like. It'll still be there. | shrug | johnny_crossed |

### SH4. Licensed to Thrill (full, 26 lines, 3 gaps)

Opener is in person at the Japantown shop window, trigger `place:window:arrived` after V stops for 10 seconds.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH4.open.01 | Johnny (copy) | place:window:arrived | Stop. Back up. Is that my face on a mug? | surprise | johnny_aggressive |
| SH4.open.02 | Johnny (copy) | place:window:arrived | A keychain. A shirt. A can of Silverhand Ultra. Ultra! I didn't even drink energy drinks. | angry | johnny_aggressive |
| SH4.open.03 | Johnny (copy) | place:window:arrived | That's the wrong side of my face, by the way. The good side doesn't exist, but still. | disgust | johnny_crossed |
| SH4.open.04 | Johnny (copy) | place:window:arrived | Somebody signed off on this. Somebody got paid. I want a name. | emphatic | johnny_aggressive |

**Gap SH4.g1** after SH4.open.04.
* **asks** `SH4.g1.ask`, Johnny (copy), question, johnny_aggressive: "Who sells a dead man's face? Tell me you want to know as badly as I do."
* **knows** a licensing rep drives a delivery car from this shop, V can follow, heat is zero, Johnny hates the can, he can't ask the shop owner anything.
* **secret** that part of him is a little flattered.
* **wants** V to follow the car.
* **idle** `johnny_aggressive`, hands near the window.
* **resumes on** the tag `follow` or `leave`, or a 4-game-hour timer (-> `shrug`).
* **branches** `follow` -> SH4.stage.tail.01. `leave` -> ending `shrug` with SH4.close.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH4.stage.tail.01 | Johnny (copy) | stage:tail:enter | There. The grey sedan. Stay back. A tail is a conversation he doesn't know he's in. | neutral | johnny |
| SH4.stage.tail.02 | Johnny (copy) | place:junction-1:arrived | First junction. Left. Don't ride his bumper, you're not in a hurry. | neutral | johnny_crossed |
| SH4.stage.tail.03 | Johnny (copy) | place:redlight:arrived | Long light. Good. Let him get comfortable. | nod | johnny |
| SH4.stage.tail.04 | Johnny (copy) | place:lastturn:arrived | Last turn. Now you look like a driver, not a hunter. | neutral | johnny_aggressive |
| SH4.bark.close.a | Johnny (copy) | watch:tail:too-close | Too close. Ease off, he's looking. | emphatic | johnny_aggressive |
| SH4.bark.close.b | Johnny (copy) | watch:tail:too-close | You're sitting in his mirror. Back off. | emphatic | johnny_aggressive |
| SH4.bark.far.a | Johnny (copy) | watch:tail:too-far | Close the gap. He's turning. | emphatic | johnny |
| SH4.bark.far.b | Johnny (copy) | watch:tail:too-far | Where did he go? Faster, V. | surprise | johnny |
| SH4.bark.spooked.a | Johnny (copy) | watch:tail:spooked | Damn it. He saw you. Go. | angry | johnny_aggressive |
| SH4.bark.spooked.b | Johnny (copy) | watch:tail:spooked | Great, now it's a chase. I love a chase I can't drive. | angry | johnny_crossed |
| SH4.stage.office.01 | Johnny (copy) | place:office:arrived | There. Don't threaten him yet. Ask him who signed. | question | johnny |

Extras (the rep, voiced with a corporate archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH4.rep.01 | Licensing rep (extra, archetype voice) | npc:rep:ask | Licensing is a contract. Nobody signs a name, it's a department. I just drive the samples. | shrug | generic_hips |
| SH4.rep.02 | Licensing rep (extra, archetype voice) | npc:rep:threat | Hey, hey! I'm a contractor! I get paid for the sedan and the stickers! | fear | generic_back |

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH4.stage.office.02 | Johnny (copy) | npc:rep:ask | A department. Of course. A building full of people with my face in their pocket. | disgust | johnny_crossed |
| SH4.stage.office.03 | Johnny (copy) | npc:rep:threat | Easy. He's a man with a paycheck. I know the type. I was one, in the army. | nod | johnny |

**Gap SH4.g2** after SH4.stage.office.03.
* **asks** `SH4.g2.ask`, Johnny (copy), question, johnny: "Do I tell you to wreck the van, or do I tell you to let him go? I honestly don't know."
* **knows** the rep has no power, V's options (`ask`, `bluff`, `threat`, `walk`), heat will rise if V threatens, the scene is a corporate lobby street, Kerry is his only other thought.
* **secret** a flash about Kerry taking the royalties.
* **wants** V to decide, and for it to be quick.
* **idle** `johnny_crossed`.
* **resumes on** a V action (`ask`, `bluff`, `threat`, `walk`) or an 8-game-minute timer.
* **branches** `threat` raises heat and plays SH4.close.04. `ask` or `bluff` plays SH4.close.01.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH4.close.01 | Johnny (copy) | ending:office | Fine. Nothing happened and I hate it. Kerry would've cashed the cheque. And he'd have been right. | shrug | johnny_shades |
| SH4.close.02 | Johnny (copy) | ending:office (gear) | Is that a SAMURAI shirt? ... It suits you. I'll deny I said that. | surprise | johnny_shades |
| SH4.close.03 | Johnny (copy) | ending:shrug | Let it go, you said. Easy to say. It's not your face on the can. | no | johnny_crossed |
| SH4.close.04 | Johnny (copy) | ending:heat | You made it an incident. Good. A little noise never hurt anyone. Run. | emphatic | johnny_aggressive |

**Gap SH4.g3** after SH4.close.01 or SH4.close.04.
* **asks** `SH4.g3.ask`, Johnny (copy), question, johnny_shades: "Would you want your face on a can? Be honest. Even a little?"
* **knows** the quest has ended, the shirt `gear` check result, he is calmer.
* **secret** that seeing the can made him think of Samurai tours.
* **wants** a straight answer.
* **idle** `johnny_shades`.
* **resumes on** a 6-game-minute timer.
* **branches** an honest "yes" makes him laugh once and say "liar." A "no" makes him say "good, don't."

### SH5. The Count (full, 26 lines, 3 gaps)

Opener is `(voice)` (`johnny-voice`), V is on foot near the transit stop, trigger `start`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH5.open.01 | Johnny (voice) | start | V. No jokes tonight. I need you to walk somewhere with me. | neutral | johnny |
| SH5.open.02 | Johnny (voice) | start | A shrine. Above the plaza. I've never gone. | sad | johnny |
| SH5.open.03 | Johnny (voice) | start | There's a number. People say it. I never counted. I want to hear it said by someone who isn't trying to kill me. | sad | johnny |
| SH5.open.04 | Johnny (voice) | start | Will you take me? | question | johnny |

**Gap SH5.g1** after SH5.open.04.
* **asks** `SH5.g1.ask`, Johnny (voice), question, johnny: "Will you walk with me? It's a long way and it's a quiet one."
* **knows** the walk is on foot, no fights, the shrine over Corpo Plaza, an old man may be there, he is not joking.
* **secret** that he has been to the plaza before, on a different day.
* **wants** a plain yes or no.
* **idle** none (voice only).
* **resumes on** the tag `yes` or `no`, or a 4-game-hour timer (-> `no`).
* **branches** `no` -> SH5.close.05 and a 3-day wait.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH5.stage.walk.01 | Johnny (copy) | stage:walk:enter | Thanks. Don't talk. Not yet. | nod | johnny |
| SH5.stage.walk.02 | Johnny (copy) | place:halfway:arrived | They rebuilt it bigger. Funny how that works. | sad | johnny_shades |
| SH5.stage.walk.03 | Johnny (copy) | place:shrine:arrived | There's someone on the bench. An old man. With a candle. | neutral | johnny |
| SH5.stage.elder.01 | Johnny (copy) | stage:elder:enter | If he curses me, let him. Don't correct him. | emphatic | johnny_crossed |
| SH5.bark.elder.a | Johnny (copy) | npc:elder:speaks | He's right. Let him finish. | sad | johnny |
| SH5.bark.elder.b | Johnny (copy) | npc:elder:leaves | He's going. Don't stop him. He earned the quiet. | sad | johnny_shades |

Extras (the old man, voiced with a corporate-district resident archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH5.elder.01 | Old man (extra, archetype voice) | npc:elder:first | Every year I come. Nobody else does anymore. That rockerboy never did. | sad | generic_front |
| SH5.elder.02 | Old man (extra, archetype voice) | npc:elder:name | Don't say that name here. Not on this bench. | angry | no |

**Gap SH5.g2** after SH5.bark.elder.a (the old man has spoken).
* **asks** `SH5.g2.ask`, Johnny (copy), question, johnny: "What do you say to a man like that? I never found it. You try."
* **knows** the old man lost a spouse in 2023, hates "that rockerboy", doesn't know V, Johnny hears everything and cannot be heard, V may speak to him or stay silent.
* **secret** that Johnny agrees with the old man's anger completely.
* **wants** V not to defend him.
* **idle** `johnny_crossed`, standing at the ledge, hands in view.
* **resumes on** the old man leaving, or an 8-game-minute timer.
* **branches** `silent` -> SH5.stage.count.01. If V says Johnny's name, the old man's reply is his own and Johnny says SH5.stage.elder.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH5.stage.elder.02 | Johnny (copy) | npc:elder:name | Don't. Don't spend my name on him. | angry | johnny_aggressive |
| SH5.stage.count.01 | Johnny (copy) | stage:count:enter | Now the number. Say it with me. I won't make it a speech. | sad | johnny |
| SH5.stage.count.02 | Johnny (copy) | stage:count:enter | I was right about them. I was wrong about us. And the people in the wrong are the ones who count. | sad | johnny_shades |

**Gap SH5.g3** after SH5.stage.count.02.
* **asks** `SH5.g3.ask`, Johnny (copy), question, johnny: "Do you think it can be forgiven? Not by them. By anyone?"
* **knows** the count beat, no figure is ever given by the pack, V chose `with` or `sit`, Johnny wants V not to make this a cause.
* **secret** that he doesn't want forgiveness, he wants to be held to it.
* **wants** an honest answer, short.
* **idle** `johnny_shades`.
* **resumes on** a 6-game-minute timer.
* **branches** `with` -> SH5.close.01. `sit` -> SH5.close.02. No answer -> SH5.close.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH5.close.01 | Johnny (copy) | ending:count (with) | Thank you. That's all. Don't make it a cause, V. Just remember it. | sad | johnny_shades |
| SH5.close.02 | Johnny (copy) | ending:count (sit) | You sat. That's more than most. | nod | johnny |
| SH5.close.03 | Johnny (copy) | gap:SH5.g3:resume (silence) | Silence is fair. Let's go home. | sad | johnny_crossed |
| SH5.close.04 | Johnny (copy) | ending:walked-away | You left. I understand. Next time I'll ask less. | no | johnny |
| SH5.close.05 | Johnny (copy) | ending:no | No. Fine. I won't ask again for a while. | sad | johnny_crossed |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH5.stage.walk.04 | Johnny (copy) | place:plaza-edge:arrived | People don't look up here. The tower looks down enough for all of us. | neutral | johnny_shades |
| SH5.bark.silence.a | Johnny (copy) | timer:walk:quiet | Don't fill the quiet. It's the only respect I've got left. | sad | johnny |
| SH5.bark.silence.b | Johnny (copy) | timer:walk:quiet | Keep walking. I'm counting steps instead of anything else. | sad | johnny_crossed |

### SH6. Soundcheck (full, 28 lines, 4 gaps)

`music:` none. `sfx:` a room tone (an empty club, low hum of a PA, "(verify)"), a one-shot door close, a distant street at dawn when V leaves.
Opener is `(voice)`, trigger `start`. He doesn't use a phone, so there is no holocall.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH6.open.01 | Johnny (voice) | start | I'm not asking for a favour. I'm asking for a room. | neutral | johnny |
| SH6.open.02 | Johnny (voice) | start | An empty stage. Five in the morning. No crowd. No band. Just a soundcheck. | sad | johnny |
| SH6.open.03 | Johnny (voice) | start | You've been carrying me around for weeks. I never asked. I'm asking. | sad | johnny |
| SH6.open.04 | Johnny (voice) | start | Totentanz. The stage. It's close. | neutral | johnny |

**Gap SH6.g1** after SH6.open.04.
* **asks** `SH6.g1.ask`, Johnny (voice), question, johnny: "Will you take me? No jokes from me tonight. I promise."
* **knows** the Totentanz stage in Westbrook at 05:00, the club is empty, he is asking not taking, V can say no.
* **secret** that he has already thought about the question he will ask on stage.
* **wants** a yes.
* **idle** none (voice only).
* **resumes on** the tag `yes` or `no`, or a 6-game-hour timer.
* **branches** `no` -> SH6.close.04.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH6.stage.venue.01 | Johnny (copy) | place:stage:arrived | There it is. Mic's where it always was. Stand by it. | nod | johnny |
| SH6.stage.venue.02 | Johnny (copy) | place:stage:arrived | Smell that? Spilled beer and cables. Nobody ever bottled that. | happy | johnny_shades |
| SH6.stage.check.01 | Johnny (copy) | stage:check:enter | Soundcheck. The part nobody sees. You hear the room breathe. | neutral | johnny |
| SH6.stage.check.02 | Johnny (copy) | stage:check:enter | Say one word into it. Anything. Your name. | question | johnny |

**Gap SH6.g2** after SH6.stage.check.02.
* **asks** `SH6.g2.ask`, Johnny (copy), question, johnny: "What's it feel like, standing up there with the lights off? Tell me. I forgot."
* **knows** V is at the mic stand, ten minutes, Johnny is walking the edge of the stage, V may say a word or stay silent.
* **secret** that he is a little afraid of the quiet.
* **wants** V to speak, or not, and for him to hear the room.
* **idle** `johnny`, pacing the stage edge.
* **resumes on** the tag `word` or `silent`, or a 5-game-minute timer.
* **branches** `word` -> SH6.stage.check.03. `silent` -> SH6.stage.check.04.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH6.stage.check.03 | Johnny (copy) | gap:SH6.g2:resume (word) | That's your voice, V. Not mine. It sounds fine. | nod | johnny_shades |
| SH6.stage.check.04 | Johnny (copy) | gap:SH6.g2:resume (silent) | Quiet's good. You can feel it work. | nod | johnny |
| SH6.stage.wheel.01 | Johnny (copy) | stage:wheel:enter | Listen. I've used your body for weeks. Walked it, watched it, never asked once. | sad | johnny |
| SH6.stage.wheel.02 | Johnny (copy) | stage:wheel:enter | I won't take the wheel. Not unless you hand it to me. One line. Your mouth. Your call. | sad | johnny_shades |
| SH6.stage.wheel.03 | Johnny (copy) | stage:wheel:enter | You can say no. I'd respect that more than a yes. | emphatic | johnny |

**Gap SH6.g3** after SH6.stage.wheel.03.
* **asks** `SH6.g3.ask`, Johnny (copy), question, johnny: "One line, from your mouth, in your words. Do I get it?"
* **knows** the three options (`yes` V writes the line in chat and Johnny answers in his own voice with `johnny-voice`, `no`, `together`), the mod never moves V, Alt's name may come up in the `yes` answer.
* **secret** that he is afraid this body will outlast him and that V will keep carrying his voice.
* **wants** V's own decision.
* **idle** `johnny_shades`, at the mic.
* **resumes on** the tag `yes`, `no` or `together`, or a 10-game-minute timer (-> `no`).
* **branches** `yes` -> SH6.stage.wheel.04. `no` -> SH6.stage.wheel.05. `together` -> SH6.stage.wheel.06.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH6.stage.wheel.04 | Johnny (voice) | gap:SH6.g3:resume (yes) | Thanks. Mine's short. Alt. Just the name, said right, once. | sad | johnny |
| SH6.stage.wheel.05 | Johnny (copy) | gap:SH6.g3:resume (no) | No. Good. I'm relieved, which surprises me. You're not my vehicle, V. | nod | johnny_shades |
| SH6.stage.wheel.06 | Johnny (voice) | gap:SH6.g3:resume (together) | Turns, then. You pick one, I pick another. We'll call it a duet and never say so. | happy | johnny |
| SH6.stage.out.01 | Johnny (copy) | stage:out:enter | Let's go. The lights will come on soon. I don't want to see it. | neutral | johnny |
| SH6.stage.out.02 | Johnny (copy) | place:street:arrived | Look at that. Dawn on a Westbrook street. I used to hate it. | sad | johnny_shades |

**Gap SH6.g4** after SH6.stage.out.02.
* **asks** `SH6.g4.ask`, Johnny (copy), question, johnny_shades: "What are you going to do with the rest of this? The time, I mean. The body. Yours."
* **knows** the soundcheck is over, V's answer to the wheel, it is dawn, he is quiet.
* **secret** that he has begun to think of the body as V's, not his.
* **wants** nothing, only to hear it.
* **idle** `johnny_shades`, walking.
* **resumes on** a 5-game-minute timer or V arriving at a new district.
* **branches** the answer sets which of SH6.close lines plays.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| SH6.close.01 | Johnny (copy) | ending:wheel (yes or together) | Whatever's left of me, I owe you a line. That was it. | sad | johnny_shades |
| SH6.close.02 | Johnny (copy) | ending:wheel (no) | You told me no. Nobody does that. I'm keeping it. | nod | johnny |
| SH6.close.03 | Johnny (copy) | ending:venue (left early) | You left before the end. That's alright. The room's still there. | shrug | johnny |
| SH6.close.04 | Johnny (voice) | ending:no | No. Alright. Not tonight, then. | sad | johnny |
| SH6.bark.dawn.a | Johnny (copy) | place:street:arrived | Look at the light. Remember it. | nod | johnny_shades |
| SH6.bark.dawn.b | Johnny (copy) | place:street:arrived | Quiet street, bad coffee, nobody shooting. Good morning. | happy | johnny |

---

## Viktor Vektor

### V1. Ringside (light: opener, closer, barks, 2 gaps)

Opener by text, then in person at the gym.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| V1.open.01 | Viktor (text) | start | Friday card at the old gym. Free seats, bad coffee. You'd hate it. | neutral | text |
| V1.open.02 | Viktor | place:gym:arrived | You came. Good. That chair is taken, has been for years. Sit here. | nod | lean |
| V1.open.03 | Viktor | stage:card:enter | Three bouts. Watch the feet, not the gloves. Gloves lie. | emphatic | chair |
| V1.open.04 | Viktor | gap:V1.g1:ask | First bout. Who takes it, and why? | question | chair |
| V1.bag.01 | Viktor | stage:bag:enter | Last thing. When you are scared in a fight, what do you do? | question | generic_arms_crossed |
| V1.bark.bout.a | Viktor | bout:any:end | Dropped his left again. They always do. | shrug | chair |
| V1.bark.bout.b | Viktor | bout:any:end | Good finish. Wrong reason, but good. | nod | chair |
| V1.bark.bet.a | Viktor | choice:bet | I said I'm not betting. I never said you couldn't. | shrug | chair |
| V1.bark.bet.b | Viktor | choice:bet | Your money. Don't tell Misty, she'll read it in the cards. | neutral | chair |
| V1.bark.bag.a | Viktor | stage:bag:enter | Hands up. Chin down. Breathe out when you hit. | emphatic | generic_arms_crossed |
| V1.bark.bag.b | Viktor | stage:bag:enter | Don't muscle it. The bag isn't your enemy. | nod | generic_arms_crossed |
| V1.close.01 | Viktor | ending:stayed | Not bad for a first card. Same seat next month, if you can stand the coffee. | nod | generic_arms_crossed |
| V1.close.02 | Viktor (text) | ending:stayed+3min | Your pick lost. Mine didn't. | happy | text |
| V1.close.03 | Viktor (text) | ending:empty-seat | Kept a seat free. It's fine. Chairs don't mind. | neutral | text |

Gap V1.g1 after V1.open.04. **Asks:** "First bout. Who takes it, and why?" **Knows:** the two amateurs' styles (one leads with the jab, one drops his left), V's bond level, whether Jackie is alive in this save. **Secret:** he already thinks the one who drops his left will win by a lucky shot. **Wants:** V to look at the feet, not the faces. **Idle:** `chair`. **Resumes on:** V names a fighter (tag `red` or `blue`) or 45 s. **Branches:** V picks the loser, he says what V's pick has going for him, kindly. V picks the winner, he grunts approval and teaches why.

Gap V1.g2 after V1.bag.01. **Asks:** "When you are scared in a fight, what do you do?" **Knows:** V's answer in the first gap, V's recent fights. **Secret:** he is always scared, and it never stopped. **Wants:** an honest answer, not a brave one. **Idle:** `generic_arms_crossed`. **Resumes on:** V answers or 40 s. **Branches:** an honest "I freeze" gets his best line about breath. A tough answer gets one dry eyebrow.

sfx: gym crowd murmur loop and a bell at each bout start and end (game library id, verify, or a pack file).

### V2. Night Calls (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| V2.open.01 | Viktor (text) | start | Got a car and a free night? Bring both. | neutral | text |
| V2.open.02 | Viktor | place:corner:arrived | Three calls. Kabuki first. Drive like there is a patient in the car. | nod | generic_front |
| V2.open.03 | Viktor | stage:calls:enter | Rule one. Ask what changed. Not what hurts. Hurt is a given. | emphatic | ripperdoc_arms |
| V2.open.04 | Viktor | gap:V2.g1:ask | While we drive. Why do people come to me and not a showroom? | question | ripperdoc_arms |
| V2.bark.arrive.a | Viktor | place:stop:arrived | Wait here. Or come in and stay quiet. Both help. | nod | generic_front |
| V2.bark.arrive.b | Viktor | place:stop:arrived | Bag is heavy. Don't offer to carry it. I'll say no. | shrug | generic_front |
| V2.bark.leave.a | Viktor | stop:done | Better. Not good. Better. | neutral | ripperdoc_arms |
| V2.bark.leave.b | Viktor | stop:done | She'll live. That's the job, mostly. | nod | ripperdoc_arms |
| V2.tab.00 | Viktor | stage:tab:enter | Third flat. Tell me what you saw before I tell you. | question | generic_front |
| V2.tab.01 | Viktor | choice:paid | That is not how a tab works. | no | generic_front |
| V2.close.01 | Viktor | ending:all-three | Three for three. You drive worse than you think and better than you act. | nod | generic_front |
| V2.close.02 | Viktor | ending:dawn | Sun's up. Two out of three. The third will understand. | shrug | generic_front |

Gap V2.g1 after V2.open.04. **Asks:** "Why do people come to me and not a showroom?" **Knows:** V's own chrome and how V got it, the 21,000 debt is settled. **Secret:** it is partly because he never shows prices on a wall. **Wants:** V to notice that care is a different product. **Idle:** seat `chair` in the car. **Resumes on:** V answers or the car leaves the corner. **Branches:** a cynical answer ("they can't afford better") gets a flat "some of them", a warm one gets a rare half-smile.

Gap V2.g2 after V2.tab.00. **Asks:** "Third flat. What did you see?" **Knows:** the patient's flat (cat bowl, a framed photo, no heater), the stop dialogue. **Secret:** he noticed the missing heater first and decided to say nothing. **Wants:** V to see the person, not the symptom. **Idle:** `generic_front`. **Resumes on:** V answers, or pays (tag `paid`). **Branches:** if V mentions the heater, he says "good eye" and does the line about tabs. If V says the implant, he says "that too".

### V3. The Third Card (light: opener, closer, barks, 1 gap)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| V3.open.01 | Viktor | start | Don't laugh. I made something. It's ugly. I need Misty in her chair for fifteen minutes. | shrug | generic_arms_crossed |
| V3.open.02 | Viktor | stage:plot:enter | She reads cards. You sit. She talks. I'll be in the alley with a soldering iron. | nod | generic_arms_crossed |
| V3.open.03 | Viktor | gap:V3.g1:ask | Pick a question you want her to read for you. Make it one she can't finish in a minute. | question | generic_arms_crossed |
| V3.bark.reveal.a | Viktor | stage:reveal:enter | Don't say it's ugly. She will. Let her. | fear | generic_arms_crossed |
| V3.bark.reveal.b | Viktor | stage:reveal:enter | Misty. This is, ah. This is yours. | fear | generic_hold |
| V3.bark.alley.a | Viktor | place:courtyard:arrived | Solder's hot. Keep her talking. | emphatic | generic_hold |
| V3.bark.alley.b | Viktor | place:courtyard:arrived | One more joint. Then the cord. Go. | nod | generic_hold |
| V3.close.01 | Viktor | ending:reveal | It's ugly. I know. She said both words. I'll live on that for a year. | happy | generic_hold |
| V3.close.02 | Viktor | ending:spoiled | She found me with the iron in my hand. Never been so embarrassed. Never been so glad. | happy | generic_hold |
| V3.close.03 | Viktor | ending:walked-off | Next time. She's patient. More than I am. | shrug | generic_arms_crossed |

Gap V3.g1 after V3.open.03. **Asks:** "Pick a question you want her to read for you." **Knows:** Misty's method, the plan, V's tarot history from `mq033`. **Secret:** he wants V to ask about him. **Wants:** a long, interesting topic for Misty. **Idle:** `generic_arms_crossed`. **Resumes on:** V states the question or 40 s. **Branches:** the question becomes the first card's subject in the reading, and he adds a dry comment later ("so that is what you wanted to know").

### V4. Off the Books (full: opener call, stage beats, closer, barks, 3 gaps)

`Holocall V4.call`. Caller Viktor, voice-only, trigger `start` once bond 6 and V3 are done. V picks up. If V does not pick up for 30 s, a text repeats the address and "call me back". The call ends when Viktor hangs up after V4.open.06. If V hangs up early, he texts the address and "Think about it. I don't ask twice."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| V4.open.01 | Viktor | holocall:V4.call | V. It's Viktor. Are you somewhere you can talk? | neutral | voice |
| V4.open.02 | Viktor | holocall:V4.call | Three patients this week, same chair. Infected. One lost a hand. | sad | voice |
| V4.open.03 | Viktor | holocall:V4.call | A chopper in Kabuki. Cheap clones in a good box. Nobody reports him. | disgust | voice |
| V4.open.04 | Viktor | holocall:V4.call | I can't walk in. Everyone there knows my face. Would you go in as a patient? | question | voice |
| V4.open.05 | Viktor | gap:V4.g1:resume | Good. Come to Kabuki. I'm in a parked car, I'll explain where nobody listens. | nod | voice |
| V4.open.06 | Viktor | holocall:V4.call | And V. Bring the weapon you won't show. | emphatic | voice |
| V4.s1.01 | Viktor | stage:brief:enter | In the chair, you say the arm lags when you reach. Nothing clever. | emphatic | generic_front |
| V4.s1.02 | Viktor | stage:brief:enter | He may ask for a weapon check. You came unarmed. You're a patient with a bad arm. | nod | generic_front |
| V4.s1.03 | Viktor | gap:V4.g2:ask | Tell me one true thing about being tired of hurting. Use it in there. | question | generic_front |
| V4.s2.01 | Viktor (remote) | stage:chair:enter | Good. Sit. Don't touch the tray. | nod | voice |
| V4.s2.02 | Viktor (remote) | timer:60 | Ask where the chrome comes from. Casually. Like the weather. | emphatic | voice |
| V4.s2.03 | Viktor (remote) | timer:150 | Ask to see the box before you sign. | emphatic | voice |
| V4.s2.04 | Viktor (remote) | suspicion:down | He's warming up. Let him talk. | nod | voice |
| V4.s2.05 | Viktor (remote) | suspicion:2 | Stay on the script. You're drifting. | no | voice |
| V4.s2.06 | Viktor (remote) | suspicion:3 | He's calling someone. Out. Slowly. Don't run. | fear | voice |
| V4.s2.07 | Viktor (remote) | label:read | Batch number. Say it back to me. I'll remember. | emphatic | voice |
| V4.s4.01 | Viktor | stage:close:enter | Say what you saw. Plainly. No threats. He'll fill in the rest. | emphatic | generic_front |
| V4.bark.arrive.a | Viktor (remote) | place:backroom:arrived | Door's open. Walk like your arm hurts. | neutral | voice |
| V4.bark.arrive.b | Viktor (remote) | place:backroom:arrived | Breathe. You're a patient. Patients are boring. | shrug | voice |
| V4.bark.susp.a | Viktor (remote) | suspicion:up | Careful. | no | voice |
| V4.bark.susp.b | Viktor (remote) | suspicion:up | Too fast. Slower. | no | voice |
| V4.bark.down.a | Viktor | squad:guards:down | That's enough. Walk away. | emphatic | generic_front |
| V4.bark.down.b | Viktor | squad:guards:down | I said no fight. Next time listen. | angry | generic_front |
| V4.close.01 | Viktor | ending:quiet-close | He closed. Without a shot. I'd have paid for that. | happy | generic_front |
| V4.close.02 | Viktor | gap:V4.g3:ask | Three patients get a free follow-up. Did it feel like lying, or like acting? | question | generic_front |
| V4.close.03 | Viktor | ending:box | Supplier, batch, a name I don't like. It'll keep. | nod | generic_front |
| V4.close.04 | Viktor | ending:brawl | They know your face now. Stay out of Kabuki a few weeks. | no | generic_front |
| V4.close.05 | Viktor | ending:blown | Dropping the cover was right. A patient with a gun is a lie nobody believes. | nod | generic_front |

Gap V4.g1 after V4.open.04. **Asks:** "Would you go in as a patient?" **Knows:** the chopper story, V's skill with talk, V3 done. **Secret:** he is angrier than he sounds, one of the three was a boy younger than V. **Wants:** a yes without a speech. **Idle:** voice only (V's own idle). **Resumes on:** V agrees (`in`), wants to burst in (`loud`) or refuses (`no`). **Branches:** `loud` gets "then you're a patient with a gun", `no` ends the call at V4.open.04 and ending `no`.

Gap V4.g2 after V4.s1.03. **Asks:** "Tell me one true thing about being tired of hurting." **Knows:** the plan, V's wounds, the chair's layout. **Secret:** he is asking because it's the only honest line a patient can say. **Wants:** V to find a real detail to hang the lie on. **Idle:** `generic_front`. **Resumes on:** V answers or 30 s. **Branches:** a vivid answer raises V's starting suspicion margin by one, he nods at it.

Gap V4.g3 after V4.close.02. **Asks:** "Did it feel like lying, or like acting?" **Knows:** the ending, the number of `improv` tags used. **Secret:** he never could do it. **Wants:** V's honest sense of it. **Idle:** `generic_front`. **Resumes on:** V answers. **Branches:** "lying" earns "good, the difference matters", "acting" earns a dry "don't enjoy it too much".

Music: none. sfx: the back room's flicker and a distant fan (pack file).

### V5. Patient Confidentiality (full: opener text, beats, closers, barks, 3 gaps)

Opener by text from the captors, then in-person. Extras' lines are voiced with a Maelstrom archetype voice and marked.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| V5.open.01 | Captor (extra, Maelstrom voice, text) | start | Your doctor's with us. Come alone. He's busy. | neutral | text |
| V5.open.02 | Captor (extra, text) | timer:600 | Clock's running. So is his patient. | angry | text |
| V5.open.03 | Captor (extra, text) | image:glasses | Proof he's fine. | neutral | text |
| V5.s2.01 | Boss (extra, Maelstrom voice) | place:warehouse:arrived | Alone. Doc said you'd come. Doc's working. | neutral | generic_arms_crossed |
| V5.s2.02 | Boss (extra) | stage:approach:talk | He finishes, then you both go. Nobody shoots in the room. | emphatic | generic_arms_crossed |
| V5.s2.03 | Boss (extra) | npc-react:obey | Fine. Two minutes. Then you leave. | no | generic_arms_crossed |
| V5.s2.04 | Ganger (extra) | stage:approach:unseen | Did you hear that? | fear | generic_hips |
| V5.s3.01 | Viktor | hostage:reached | Don't touch me. Don't touch him. Close the door. | emphatic | ripperdoc_arms |
| V5.s3.02 | Viktor | stage:ward:enter | I'm not leaving. He's open on the table. Help or wait outside. | angry | ripperdoc_arms |
| V5.s3.03 | Viktor | gap:V5.g1:ask | Can you keep the room quiet? Five minutes. No shots, no shouting. | question | ripperdoc_arms |
| V5.s3.04 | Viktor | timer:60 | Stay with me, kid. Pressure. Gauze. Stay. | emphatic | ripperdoc_arms |
| V5.s3.05 | Viktor | timer:180 | Another minute. Don't talk. Don't breathe loud. | no | ripperdoc_arms |
| V5.s3.06 | Viktor | combat:inside | Stop. Stop shooting! | angry | ripperdoc_arms |
| V5.s3.07 | Viktor | ward:done | Done. He'll hold. Don't ask me for odds. | sad | ripperdoc_arms |
| V5.s4.01 | Viktor | hostage:follow | Walk me out. Slow. They'll let us. | nod | generic_front |
| V5.s4.02 | Viktor | stage:out:ride | I'd like to say I'm fine. Give me a minute with the road. | sad | generic_front |
| V5.s4.03 | Viktor | gap:V5.g2:ask | While the door was closed. What were you thinking? | question | generic_front |
| V5.bark.freed.a | Viktor | hostage:V5:freed | Not yet. Not yet. | no | ripperdoc_arms |
| V5.bark.freed.b | Viktor | hostage:V5:freed | Door. Close it. | emphatic | ripperdoc_arms |
| V5.bark.down.a | Viktor | squad:V5:down | Good. Outside, not in here. | nod | ripperdoc_arms |
| V5.bark.down.b | Viktor | squad:V5:down | That's enough noise. | no | ripperdoc_arms |
| V5.close.01 | Viktor | ending:clean | You waited. Most people can't. It's the hardest part of my job. | nod | generic_front |
| V5.close.02 | Viktor | ending:clean | One favour, on the house. Any time. Remember I said it. | emphatic | generic_front |
| V5.close.03 | Viktor | ending:loud-but-saved | Check your knuckles. You're bleeding on my seat. | shrug | generic_front |
| V5.close.04 | Viktor | gap:V5.g3:ask | I'll say it plainly. Is there something about tonight you can't put down? | question | generic_front |
| V5.close.05 | Viktor | ending:lost-patient | I know it's not your fault. It isn't. | sad | generic_front |
| V5.close.06 | Viktor | ending:too-late | They let me go. Don't say anything. | sad | generic_front |

Gap V5.g1 after V5.s3.03. **Asks:** "Can you keep the room quiet?" **Knows:** the ward `place` rule (no combat in 12 m), the boss's mood, V's choices at the door. **Secret:** he fears V will not be able to hold it, and will still ask. **Wants:** a clear promise. **Idle:** `ripperdoc_arms`. **Resumes on:** V agrees or refuses. **Branches:** a refusal, he says "then wait outside", V can still hold the door.

Gap V5.g2 after V5.s4.03. **Asks:** "What were you thinking while the door was closed?" **Knows:** whether V fought, sneaked or talked, how long V waited. **Secret:** he was counting V's steps outside. **Wants:** to hear V was afraid too. **Idle:** `generic_front` (in the car). **Resumes on:** V answers. **Branches:** honesty earns the "one on the house" line, bluster earns a quiet look.

Gap V5.g3 after V5.close.04. **Asks:** "Is there something about tonight you can't put down?" **Knows:** the ending, the patient's fate. **Secret:** he was the one who chose to go on the table that night. **Wants:** V to say it to someone. **Idle:** `generic_front`. **Resumes on:** V answers or 45 s. **Branches:** if V speaks, he listens without comment. Silence is accepted.

sfx: a heart-monitor beep loop during the ward stage, ending on the outcome (a pack file, or the game's device beep, verify).

### V6. Corner (full: opener call, stage beats, closers, barks, 4 gaps)

`Holocall V6.call`. Caller Viktor, voice-only, trigger `start`. V picks up. Viktor hangs up after V6.open.06. If V hangs up early, he texts "Thursday. The hall. Think about it."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| V6.open.01 | Viktor | holocall:V6.call | V. Thursday night. I need a corner man. | neutral | voice |
| V6.open.02 | Viktor | holocall:V6.call | Stool, towel, water bottle. You don't have to say anything clever. | shrug | voice |
| V6.open.03 | Viktor | holocall:V6.call | One of the kids drops his guard in round two. I'm going to show him why. | emphatic | voice |
| V6.open.04 | Viktor | holocall:V6.call | In the ring. I haven't been in one since the Grand Prix. | sad | voice |
| V6.open.05 | Viktor | gap:V6.g1:ask | Will you do it? Think first. I'll know if you didn't. | question | voice |
| V6.open.06 | Viktor | gap:V6.g1:resume | Thursday. The hall. Bring a clean shirt. | nod | voice |
| V6.s2.01 | Viktor | stage:wraps:enter | Sit. Hands. Tight across the knuckles, not the wrist. | emphatic | chair |
| V6.s2.02 | Viktor | timer:60 | Second place. Everyone says it like an insult. It isn't. | nod | generic_back |
| V6.s2.03 | Viktor | timer:120 | I could have been somebody. I stopped wanting to be. Sleep got easier. | sad | generic_back |
| V6.s2.04 | Viktor | gap:V6.g2:ask | What do you want from me tonight? As a corner. Truthfully. | question | generic_back |
| V6.r1.01 | Viktor | bout:round1:start | Easy. Feel him out. Jab, jab. | neutral | stool |
| V6.r1.02 | Viktor | bout:round1:end | Breathe. Slower. In through the nose. | emphatic | stool |
| V6.r1.03 | Viktor | bout:round1:end | Tell me what you see. I can't see my own feet. | question | stool |
| V6.r2.01 | Viktor | bout:round2:start | He's dropping his hands. Good. Wait for it. | emphatic | stool |
| V6.r2.02 | Viktor | bout:cut | I'm cut. Don't panic. Press the swab. Hard. | angry | stool |
| V6.r2.03 | Viktor | choice:towel | Don't you dare. I'll tell you when. | angry | stool |
| V6.r2.04 | Viktor | gap:V6.g3:ask | Should I go out for the third? Be honest. You're the one who can see. | question | stool |
| V6.r3.01 | Viktor | bout:round3:start | Last round. Chin down. Last round. | emphatic | stool |
| V6.end.01 | Viktor | bout:end:stood | Three rounds. Still on my feet. More than I promised. | happy | stool |
| V6.end.02 | Viktor | bout:end:towel | Towel's in. Fine. Fine. | sad | stool |
| V6.s4.01 | Viktor | stage:after:enter | Hold the lamp. Higher. That's it. | nod | chair |
| V6.s4.02a | Viktor | stage:after:jackie-alive | Jackie says the corner is where you find out who your friends are. | happy | chair |
| V6.s4.02b | Viktor | stage:after:jackie-gone | Jackie used to say the corner is where you find out who your friends are. | sad | chair |
| V6.s4.03 | Viktor | timer:240 | Take it. Second place. It's lighter than you'd think. | nod | chair |
| V6.s4.04 | Viktor | gap:V6.g4:ask | Is there someone who would stand in your corner? Name one. | question | chair |
| V6.s4.05 | Viktor | gap:V6.g4:resume | Sleeping well is a decent trade. I mean it. Try it. | nod | chair |
| V6.bark.round.a | Viktor | bout:round:end | Time. Sit. | emphatic | stool |
| V6.bark.round.b | Viktor | bout:round:end | Water. Spit. Breathe. | emphatic | stool |
| V6.bark.arrive.a | Viktor | place:hall:arrived | Bag's in the dressing room. Don't touch the trophies. | shrug | generic_arms_crossed |
| V6.bark.arrive.b | Viktor | place:hall:arrived | Smells the same. Funny. | sad | generic_arms_crossed |
| V6.close.01 | Viktor | ending:stood | My corner. That's what you are now. Don't make me regret it. | happy | chair |
| V6.close.02 | Viktor | ending:towel | You threw it in. I'm still angry. Thank you. In that order. | angry | chair |
| V6.close.03 | Viktor | ending:walked | I'll ask somebody else. Don't worry about it. | shrug | chair |
| V6.close.04 | Viktor (text) | ending:no-corner | Thursday came and went. It's fine. I fought the kid in my head. | sad | text |

Gap V6.g1 after V6.open.05. **Asks:** "Will you do it?" **Knows:** the bout plan, V5 and V4 done, the hall is the Grand Prix hall. **Secret:** he has not been in a ring since the Grand Prix and he fears the first punch. **Wants:** a yes that isn't a favour. **Idle:** voice only. **Resumes on:** V answers. **Branches:** a hesitant yes gets "then I'll take the hesitation", a firm yes gets a short silence.

Gap V6.g2 after V6.s2.04. **Asks:** "What do you want from me tonight?" **Knows:** the dressing room, his wraps, the ring waiting. **Secret:** he wants V to say "stop" before he asks for it. **Wants:** a role, not a speech. **Idle:** `generic_back`. **Resumes on:** V answers. **Branches:** the answer shapes what he tells V to do at the stool (V's words become the "rules" he repeats).

Gap V6.g3 after V6.r2.04 (the stool, between rounds two and three). **Asks:** "Should I go out for the third?" **Knows:** the cut, the score of the two rounds, the towel option. **Secret:** he wants to go out, and he wants to be stopped, and he cannot tell which. **Wants:** V's honest eyes. **Idle:** `stool`. **Resumes on:** V says go (tag `guard` or `jab`), stop (tag `towel`), or 60 s. **Branches:** the choice sets the ending. `towel` leads to V6.end.02, a go leads to V6.r3.01.

Gap V6.g4 after V6.s4.04. **Asks:** "Is there someone who would stand in your corner? Name one." **Knows:** the ending, V's relationships in the save. **Secret:** he wants the answer to be himself. **Wants:** V to say a name. **Idle:** `chair`. **Resumes on:** V answers or 40 s. **Branches:** a named person goes into `history`, he repeats it later ("how is he, your corner"). "Nobody" gets "start with one".

Music: none. sfx: crowd murmur, bell for the rounds (game library id, verify), a stool creak.

---

## Jackie Welles

All Act 1, before The Heist. Jackie never knows what is coming, and nothing below says it. Texts are `(phone)` lines on the shared key's fixed-line route. His idles are `jackie` and `jackie_hips`, and he leans on his bike (`lean`) when waiting. No line mentions Heywood as a place V goes.

### JW1. Not Quite Mama's (light, 11 lines, 1 gap)

Opener by text, trigger `start`. A text is a fixed line, then V's reply in the chat thread is a normal turn.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW1.open.01 | Jackie (phone) | start | Choom, I'm starving. Not hungry. Starving. | emphatic | - |
| JW1.open.02 | Jackie (phone) | start | I need a bowl that tastes like my mama's sopa de fideos. | neutral | - |
| JW1.open.03 | Jackie (phone) | start | Little China, noodle lane. Be my judge. Two hours. | neutral | - |

**Gap JW1.g1** after JW1.open.03 (the text thread).
* **asks** `JW1.g1.ask`, Jackie (phone), question: "You coming, hermano? And do you like it spicy or are you one of those?"
* **knows** the meeting place (noodle lane in Little China), two game hours, three stalls, Jackie is homesick but jokes about it.
* **secret** that he hasn't been home in a week and misses his mother more than he says.
* **wants** V to say yes and bring an appetite.
* **idle** none (a text).
* **resumes on** the `meet:met` event or the tag `yes`, or the 2-game-hour timer (-> `stood-up`).
* **branches** V's spice answer shapes his ratings jokes.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW1.bark.rate.a | Jackie (copy) | choice:rating | Too much salt. Mama would cry. | disgust | jackie |
| JW1.bark.rate.b | Jackie (copy) | choice:rating | Okay, okay. That's close. Don't tell the others. | nod | jackie |
| JW1.bark.best.a | Jackie (copy) | stage:verdict:enter | This one. Number three. Hot, and it tastes like someone cared. | happy | jackie_hips |
| JW1.bark.best.b | Jackie (copy) | stage:verdict:enter | Not Mama's. But it's hot. That's what I need tonight. | nod | jackie |
| JW1.stage.call.01 | Jackie (copy) | stage:call:enter | Give me a minute, choom. I gotta call home before I lose my nerve. | neutral | jackie |
| JW1.close.01 | Jackie (copy) | ending:verdict | When this job's done, I'm bringing her here. She'll hate it and finish the bowl. | happy | jackie_hips |
| JW1.close.02 | Jackie (copy) | ending:verdict | Thanks for eating with me. Seriously. Feels less like I'm missing something. | sad | jackie |

### JW2. Sticky Fingers (light, 15 lines, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW2.open.01 | Jackie (copy) | start | Look at these grips, hermano! Hand-wrapped. Took me three nights. | happy | jackie |
| JW2.open.02 | Jackie (copy) | start | Feel that? That's craftsmanship. Go on, tell me it's beautiful. | question | jackie_hips |

**Gap JW2.g1** after JW2.open.02.
* **asks** `JW2.g1.ask`, Jackie (copy), question, jackie_hips: "Seriously, what do you think? Beautiful or just fast?"
* **knows** they are at the Kabuki Market east entrance, the bike is parked, a pickpocket is about to lift his cross, the crowd is busy.
* **secret** the cross matters to him in a way he won't explain.
* **wants** V to admire the bike.
* **idle** `lean` against the bike.
* **resumes on** the tag `admire` or `tease`, or a 3-game-minute timer (the theft happens anyway).
* **branches** `admire` -> a warmer hit when the theft happens. `tease` -> he jokes back, then goes cold when it matters.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW2.stage.theft.01 | Jackie (copy) | stage:lift:enter | My cross! Hey! That little... Get back here! | angry | jackie |
| JW2.bark.chase.a | Jackie (copy) | place:rooftop:arrived | He's fast! Over the rail, choom! | emphatic | jackie |
| JW2.bark.chase.b | Jackie (copy) | place:rooftop:arrived | Kid knows the roofs. Don't lose him! | emphatic | jackie |
| JW2.bark.deadend.a | Jackie (copy) | runner:cornered | Dead end, mijo. Hand it over. | angry | jackie |
| JW2.bark.deadend.b | Jackie (copy) | runner:cornered | Got you. Easy. Nobody hurts you. | emphatic | jackie |
| JW2.thief.01 | Pickpocket (extra, archetype voice) | npc:kid:cornered | I'm hungry! I didn't think it was yours that important! | fear | generic_back |
| JW2.stage.catch.01 | Jackie (copy) | npc:kid:caught | Hey. Listen. When did you last eat? No, really. | question | jackie |

**Gap JW2.g2** after JW2.stage.catch.01.
* **asks** `JW2.g2.ask`, Jackie (copy), question, jackie: "Do I let him go, hermano? Or do we teach him something harder?"
* **knows** the kid is cornered, hungry, not a hardened thief, V's options (`let-go`, `scare`, `rough`), the cross is in the kid's hand.
* **secret** that Jackie sees himself at that age.
* **wants** V's opinion before he decides.
* **idle** `jackie`, hands open.
* **resumes on** the tag `let-go`, `scare` or `rough`, or a 4-game-minute timer.
* **branches** `let-go` -> JW2.close.01. `scare` -> JW2.close.02. `rough` -> JW2.close.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW2.close.01 | Jackie (copy) | choice:let-go | Here's the cross. Go eat. Tell nobody I was soft. | nod | jackie |
| JW2.close.02 | Jackie (copy) | choice:scare | Good scare. Maybe he learns. Maybe not. | shrug | jackie |
| JW2.close.03 | Jackie (copy) | choice:rough | Ugh. Roughing up a kid. Not my best. | sad | jackie |
| JW2.stage.listen.01 | Jackie (copy) | stage:listen:enter | Sit on her. Easy with the throttle. Listen to the engine first. | nod | jackie_hips |

### JW3. Come Home, Kid (light, 15 lines, 2 gaps)

Opener is a scripted holocall: `Holocall JW3.call`, caller Jackie, voice-only, trigger `start` (he is walking and the line is loud).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW3.call.01 | Jackie (phone) | start | V. Drop whatever you're doing. A kid from my old block is in trouble. | emphatic | - |
| JW3.call.02 | Jackie (phone) | start | Maelstrom recruiters in Northside. By morning he signs something he can't unsign. | angry | - |
| JW3.call.03 | Jackie (phone) | start | I know that look in the eyes. I had it at his age. | sad | - |
| JW3.call.04 | Jackie (phone) | start | Afterlife steps, one hour. Can you come? | question | - |

**Gap JW3.g1** after JW3.call.04 (V answers on the call).
* **asks** `JW3.g1.ask`, Jackie (phone), question: "You in? And if you're not, say it now, no hard feelings."
* **knows** the kid is a Heywood teenager, Maelstrom yard in Northside, six minutes before he's handed a gun, Jackie distrusts the Maelstrom because the Valentinos had rules.
* **secret** that he sees himself in the kid.
* **wants** V on the Afterlife steps within one hour.
* **idle** none.
* **resumes on** the `meet:met` event, the tag `in` or `no`, or the 1-game-hour timer.
* **branches** `no` ends the call: Jackie hangs up after "Alright" and goes alone (ending `signed` variant, bond 0). V hanging up early is read as `no`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW3.stage.drive.01 | Jackie (copy) | stage:drive:enter | The Valentinos had rules. You knew what a name cost. Maelstrom? Just chrome and hunger. | angry | jackie |
| JW3.stage.yard.01 | Jackie (copy) | place:yard:arrived | There. The kid in the hoodie. Don't spook him. | neutral | jackie |
| JW3.bark.signed-timer.a | Jackie (copy) | timer:yard:4min | Two minutes. They're going to hand him something. Move. | emphatic | jackie |
| JW3.bark.signed-timer.b | Jackie (copy) | timer:yard:4min | Faster, choom. He's about to be someone's property. | emphatic | jackie |
| JW3.bark.freed.a | Jackie (copy) | npc:kid:following | Come on, mijo. We're going home. | nod | jackie |
| JW3.bark.freed.b | Jackie (copy) | npc:kid:following | Easy. Walk with us. Nobody's angry. | nod | jackie |

Extras (the kid, a teen archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW3.kid.01 | Kid (extra, archetype voice) | npc:kid:talked | I just wanted to be somebody. They said they'd make me one. | sad | generic_back |

**Gap JW3.g2** after JW3.kid.01.
* **asks** `JW3.g2.ask`, Jackie (copy), question, jackie: "What do I say to him? Honestly, hermano, I never learned how to tell a kid no."
* **knows** the kid is free or on the way out, the Metro is the only way home, Jackie wants him on the train and no stage is set in Heywood.
* **secret** that Jackie's own mother once said what he's about to say.
* **wants** V's help to find the words.
* **idle** `jackie`.
* **resumes on** V's reply or a 4-game-minute timer.
* **branches** V's advice is quoted by Jackie on the platform (`JW3.close.01`).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW3.close.01 | Jackie (copy) | stage:platform:enter | You want a name? Get one the long way. And tell your mama you were with me. | emphatic | jackie |
| JW3.close.02 | Jackie (copy) | ending:platform | Good kid. Good kid. Thanks, V. Let's go find Misty a flower. | happy | jackie_hips |

### JW4. Wraps (full, 27 lines, 3 gaps)

Opener is in person at the gym, trigger `start` (a text from Jackie sets the place, see his reach-out table).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW4.open.01 | Jackie (copy) | start | Good, you're here. I need to lift before I do something stupid. | neutral | jackie |
| JW4.open.02 | Jackie (copy) | start | Weights are my meditation. Don't talk at me. Just spot me. | emphatic | jackie |
| JW4.open.03 | Jackie (copy) | start | Tonight I'm fighting in a pit in Northside. Like old times with Viktor. | happy | jackie_hips |
| JW4.open.04 | Jackie (copy) | start | You're my corner. Say yes before I come up with a worse plan. | question | jackie |

**Gap JW4.g1** after JW4.open.04.
* **asks** `JW4.g1.ask`, Jackie (copy), question, jackie: "You've got my back, right? And be honest, you think I'm crazy?"
* **knows** the plan (gym, Viktor's clinic, the pit, three 90-second rounds), Jackie is restless, he needs company not therapy.
* **secret** that he is nervous and hiding it with a joke.
* **wants** a plain yes.
* **idle** `jackie_hips`, stretching.
* **resumes on** the tag `spotted` (V says it) or a 4-game-minute timer.
* **branches** V's reaction sets whether he lifts quietly or loudly.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW4.stage.lift.01 | Jackie (copy) | stage:lift:enter | One more. Count for me. Eight, nine... you've got me, right? | emphatic | jackie |
| JW4.stage.lift.02 | Jackie (copy) | stage:lift:enter | There. Feels good. Hurts in the right places. | happy | jackie_hips |
| JW4.stage.clinic.01 | Jackie (copy) | place:clinic:arrived | Viktor! Wrap me up, doc. Tonight I need hands like hammers. | happy | jackie |
| JW4.stage.clinic.02 | Jackie (copy) | stage:clinic:enter | He never says yes. He says "be careful". Which is a yes. | nod | jackie |

**Gap JW4.g2** after JW4.stage.clinic.02.
* **asks** `JW4.g2.ask`, Jackie (copy), question, jackie: "Be straight with me. Do I look nervous, hermano?"
* **knows** Viktor has wrapped his hands (game-placed, talk only), Misty teased from her shop, the pit is next, V can throw in the towel.
* **secret** that he doesn't want to disappoint Viktor.
* **wants** reassurance without a lecture.
* **idle** `jackie`.
* **resumes on** the tag or a 3-game-minute timer.
* **branches** a calm answer gives JW4.stage.pit.01, a worried one gives JW4.stage.pit.02.

Extras (the pit boss, a street archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW4.pit.01 | Pit boss (extra, archetype voice) | place:pit:arrived | Rules are simple. Hands only. Last one standing or the towel. | emphatic | generic_hips |

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW4.stage.pit.01 | Jackie (copy) | gap:JW4.g2:resume (calm) | Alright, alright. Let's make some noise. | happy | jackie_hips |
| JW4.stage.pit.02 | Jackie (copy) | gap:JW4.g2:resume (worry) | I'm fine. Don't look at me like that. | no | jackie |
| JW4.bark.round.a | Jackie (copy) | bout:round-end | Water. Quick. I'm good, choom, I'm good. | emphatic | jackie |
| JW4.bark.round.b | Jackie (copy) | bout:round-end | He hits harder than he looks. Don't throw the towel yet. | emphatic | jackie |
| JW4.bark.hurt.a | Jackie (copy) | bout:hurt | Ah! Okay. Okay, that one stung. | fear | jackie |
| JW4.bark.hurt.b | Jackie (copy) | bout:hurt | Don't... don't you dare throw it. | angry | jackie |
| JW4.bark.towel.a | Jackie (copy) | choice:towel | What the hell, V! ...Thank you. | sad | jackie |
| JW4.bark.towel.b | Jackie (copy) | choice:towel | I had him! ...No. I didn't. Thanks. | shrug | jackie |
| JW4.bark.win.a | Jackie (copy) | bout:won | Ha! Did you see that? Tell Viktor! | happy | jackie_hips |
| JW4.bark.win.b | Jackie (copy) | bout:won | On my feet! Nobody carried me! | happy | jackie_hips |
| JW4.bark.lose.a | Jackie (copy) | bout:lost | Ah. Well. That's a story. I'll tell it better. | shrug | jackie |
| JW4.bark.lose.b | Jackie (copy) | bout:lost | He was better tonight. Don't tell Viktor. | sad | jackie |

**Gap JW4.g3** after any bout result (the steps).
* **asks** `JW4.g3.ask`, Jackie (copy), question, jackie: "Tell me something true. What do you actually do when you want to hit something and can't?"
* **knows** the bout result, he is sore, he has ice, he is loose enough to talk about Misty and about why fighting helps.
* **secret** that he worries Misty sees more than he wants.
* **wants** V to answer honestly, he'll answer back.
* **idle** `stool`, sitting on the pit's steps with ice.
* **resumes on** a 10-game-minute timer.
* **branches** an honest answer gives JW4.close.01. A joke gives JW4.close.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW4.close.01 | Jackie (copy) | gap:JW4.g3:resume (honest) | Good. Lift, hit, or talk. One of them has to work. Misty says talk. | nod | jackie |
| JW4.close.02 | Jackie (copy) | gap:JW4.g3:resume (joke) | Ha. Fair. Let's go eat something. | happy | jackie_hips |
| JW4.close.03 | Jackie (copy) | ending:lift-only | Gym was enough. Maybe the pit's for another night. | shrug | jackie |

### JW5. The Drink with My Name (full, 27 lines, 3 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW5.open.01 | Jackie (copy) | start | There it is. The Afterlife. In a year they'll be chanting my name at that door. | happy | jackie_hips |
| JW5.open.02 | Jackie (copy) | start | I want to rehearse. The walk. The nod. The tilt of the chin. | emphatic | jackie |
| JW5.open.03 | Jackie (copy) | start | You're the crowd. Cheer or heckle, but be honest. | question | jackie |

**Gap JW5.g1** after JW5.open.03.
* **asks** `JW5.g1.ask`, Jackie (copy), question, jackie: "Be honest, hermano. How would you like a legend to walk in? Slow or fast?"
* **knows** the Afterlife door, three checkpoints (door, stairs, bar), three regulars at the bar, a photo and a drink to come.
* **secret** that this is for his mother and Misty more than for the crowd.
* **wants** V to play along.
* **idle** `jackie_hips`.
* **resumes on** the tag `cheer` or `heckle`, or a 4-game-minute timer.
* **branches** V's style (cheer or heckle) sets how many of his lines at the bar are proud or sheepish.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW5.stage.entrance.01 | Jackie (copy) | place:door:arrived | Here we go. Chin up. Don't smile, they hate that. | emphatic | jackie |
| JW5.stage.entrance.02 | Jackie (copy) | place:stairs:arrived | Up the stairs. Slow. Let the booths look. | nod | jackie |
| JW5.stage.entrance.03 | Jackie (copy) | place:bar:arrived | And the bar. That's where legends order. How'd it look? | question | jackie_hips |
| JW5.reg.01 | Regular (extra, archetype voice) | npc:regular-1 | Sit down, kid. You're blocking the light. | angry | generic_arms_crossed |
| JW5.reg.02 | Regular (extra, archetype voice) | npc:regular-2 | Ha! Kabuki job, right? You're the loud one. | happy | generic_hips |
| JW5.reg.03 | Regular (extra, archetype voice) | npc:regular-3 | Welles? Didn't you do that thing in Kabuki? | question | generic_front |
| JW5.bark.regular.a | Jackie (copy) | npc:regular:reacts | Did you hear that? He knew me. He KNEW me. | happy | jackie_hips |
| JW5.bark.regular.b | Jackie (copy) | npc:regular:reacts | Ouch. Legends get heckled. It's practice. | shrug | jackie |
| JW5.stage.photo.01 | Jackie (copy) | stage:photo:enter | Alright. Frame it. Door behind me. Arm up. Make me look like a champion. | emphatic | jackie_hips |

**Gap JW5.g2** after JW5.stage.photo.01.
* **asks** `JW5.g2.ask`, Jackie (copy), question, jackie_hips: "Do I smile? Do I not smile? You're the artist, V."
* **knows** the photo is V's framing, the tag `got-it` closes it, the Afterlife neon is behind him.
* **secret** none, he is just happy.
* **wants** a good shot.
* **idle** `jackie_hips`, posing.
* **resumes on** the tag `got-it` or a 3-game-minute timer.
* **branches** none, the image is the same, the caption changes with the tone.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW5.stage.photo.02 | Jackie (copy) | gap:JW5.g2:resume | Look at that. A legend in the making. Send it to Misty. | happy | jackie_hips |
| JW5.stage.drink.01 | Jackie (copy) | stage:drink:enter | Claire! What goes in a legend's drink? No, listen, I have a recipe. | emphatic | jackie |
| JW5.stage.drink.02 | Jackie (copy) | stage:drink:enter | Vodka, ice, lime, ginger beer. And then something... sentimental. I always lose the last word. | question | jackie |

**Gap JW5.g3** after JW5.stage.drink.02.
* **asks** `JW5.g3.ask`, Jackie (copy), question, jackie: "Help me finish it. What's the last ingredient of a good memory?"
* **knows** the recipe, the options (`twist`, `salt`, `float`, `plain`), Claire is game-placed and talks only, the coaster is for his name.
* **secret** that he wants the drink to remind Misty of him.
* **wants** V's pick.
* **idle** `bar`, one elbow on the bar.
* **resumes on** the tag (`twist`, `salt`, `float`, `plain`) or a 5-game-minute timer.
* **branches** each flourish gets its own close line.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW5.close.01 | Jackie (copy) | choice:twist | A twist! Perfect. We'll put it on the menu: The Jackie. With a twist. | happy | jackie_hips |
| JW5.close.02 | Jackie (copy) | choice:salt | Salt. Weird. Okay. A legend can be weird. | shrug | jackie |
| JW5.close.03 | Jackie (copy) | choice:float | Tequila float. Of course. You know me. | happy | jackie |
| JW5.close.04 | Jackie (copy) | choice:plain | Plain? Fine. Sometimes plain's honest. | nod | jackie |
| JW5.close.05 | Jackie (copy) | ending:drink | Write it on a coaster. One day I'll order it and they'll know my name. | emphatic | jackie_hips |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW5.bark.cheer.a | Jackie (copy) | choice:cheer | Yes! More of that! I'm gonna need a bodyguard for the applause. | happy | jackie_hips |
| JW5.bark.cheer.b | Jackie (copy) | choice:cheer | Louder! Make the whole bar turn around! | happy | jackie_hips |
| JW5.bark.heckle.a | Jackie (copy) | choice:heckle | Boo? Boo?! Okay, okay. That's character building. | shrug | jackie |
| JW5.bark.heckle.b | Jackie (copy) | choice:heckle | Keep heckling. Legends need haters. It's practice. | nod | jackie |

### JW6. The Bottle (full, 26 lines, 4 gaps)

Opener is a text, trigger `start`. Nothing in these lines says tomorrow's outcome. "Tomorrow" is used only if the game clock agrees with the story window (else "soon").

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW6.open.01 | Jackie (phone) | start | Tomorrow's the big one, hermano. I can't sleep. | happy | - |
| JW6.open.02 | Jackie (phone) | start | Misty's shop, nine tonight. Come say hi to my girl. | neutral | - |
| JW6.open.03 | Jackie (phone) | start | And bring nothing. I've got the bottle. | happy | - |

**Gap JW6.g1** after JW6.open.03 (the text thread).
* **asks** `JW6.g1.ask`, Jackie (phone), question: "You coming? And if your head's busy, come anyway, we can be busy together."
* **knows** the plan for the evening (Misty's, a call to Mama, a roof), Jackie is excited and a little wired, he says he is not afraid.
* **secret** that he wants V there more than the plan needs.
* **wants** V to say yes.
* **idle** none.
* **resumes on** the `meet:met` event or the tag `yes`, or the 3-game-hour timer.
* **branches** `yes` -> the shop. A tired or short answer makes him tease and still wait.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW6.stage.shop.01 | Jackie (copy) | place:shop:arrived | Misty! This is V. V, this is the best thing in Night City. | happy | jackie_hips |
| JW6.stage.shop.02 | Jackie (copy) | stage:shop:enter | She reads the cards. I don't understand them. I just like how she's quiet over them. | nod | jackie |
| JW6.stage.shop.03 | Jackie (copy) | stage:shop:card | What is it? What did you see, mi amor? ...Nothing? Good. | question | jackie |
| JW6.stage.shop.04 | Jackie (copy) | stage:shop:enter | She gave me a pendant. Luck. I'm hanging it on the bike. | happy | jackie |

**Gap JW6.g2** after JW6.stage.shop.04.
* **asks** `JW6.g2.ask`, Jackie (copy), question, jackie: "Does Misty seem worried to you? You're good at reading people."
* **knows** Misty is game-placed and talks only, she pulled a card and put it face down, V may ask her, Jackie waves it away.
* **secret** that Misty's silence bothers him and he is pretending it doesn't.
* **wants** V to say it's fine.
* **idle** `jackie`, hand on a pendant.
* **resumes on** a 5-game-minute timer or V leaving the shop.
* **branches** V's honest unease gets a quiet "yeah" and a joke. Reassurance gets a grin.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW6.stage.call.01 | Jackie (copy) | stage:call:enter | I gotta call Mama. Give me a minute, choom. Walk if you want. | neutral | jackie |
| JW6.call.half.01 | Jackie (copy) | stage:call:enter | Mama? Yeah, it's me. I ate. Of course I ate. | happy | jackie |
| JW6.call.half.02 | Jackie (copy) | stage:call:enter | A job. A good one. No, nothing dangerous. It's a gig, Mama, we've done a hundred. | emphatic | jackie |
| JW6.call.half.03 | Jackie (copy) | stage:call:enter | I love you too. Lock the door. I'll see you soon. | sad | jackie |
| JW6.bark.call-end.a | Jackie (copy) | stage:call:end | She says hello. She always says to be careful. | nod | jackie |
| JW6.bark.call-end.b | Jackie (copy) | stage:call:end | Lied badly. She knows. Moms always know. | shrug | jackie |
| JW6.stage.roof.01 | Jackie (copy) | place:roof:arrived | Up here. Sit. Look at that bay. Tell me it isn't ours. | happy | jackie_hips |
| JW6.stage.roof.02 | Jackie (copy) | stage:roof:enter | The bottle. Sealed. Sacred. We open it when it's won. | emphatic | jackie |
| JW6.stage.roof.03 | Jackie (copy) | stage:roof:enter | After this, a house for Mama. A lock on her door. Lights for Misty. The Afterlife. | happy | jackie_hips |

**Gap JW6.g3** after JW6.stage.roof.03.
* **asks** `JW6.g3.ask`, Jackie (copy), question, jackie: "What's yours? What do you want out of all this, V? Say it out loud, I won't tell."
* **knows** V and Jackie are sitting on a Little China roof, the bottle stands unopened, it is night, he is being open.
* **secret** that he is not afraid and is quietly afraid anyway.
* **wants** V's honest dream.
* **idle** `stool`, `seat` ground, feet over the edge.
* **resumes on** V's reply or a 10-game-minute timer.
* **branches** V's answer is quoted back in JW6.stage.roof.04 whatever it is.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW6.stage.roof.04 | Jackie (copy) | gap:JW6.g3:resume | Yeah. That. We'll get it. Both of us. | nod | jackie |
| JW6.stage.roof.05 | Jackie (copy) | stage:roof:enter | Promise me. We open this bottle together when we win. | emphatic | jackie |

**Gap JW6.g4** after JW6.stage.roof.05.
* **asks** `JW6.g4.ask`, Jackie (copy), question, jackie: "Promise? Swear on the bottle. I'll hold you to it."
* **knows** the promise is the cruelest beat and is never marked, V's answer is a tag (`promise`, `maybe`).
* **secret** none, he believes it completely.
* **wants** a promise.
* **idle** `jackie_hips`, hand on the bottle.
* **resumes on** the tag `promise` or `maybe`, or a 5-game-minute timer.
* **branches** `promise` -> JW6.close.01. `maybe` -> JW6.close.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| JW6.close.01 | Jackie (copy) | choice:promise | There. Deal. Big money, big bottle, big day. | happy | jackie_hips |
| JW6.close.02 | Jackie (copy) | choice:maybe | Maybe? I'll take maybe. I'll hold you to it anyway. | happy | jackie |
| JW6.stage.home.01 | Jackie (copy) | stage:home:enter | Walk me to the corner. See you at Dex's, hermano. | nod | jackie |
| JW6.close.03 | Jackie (copy) | ending:home | Hey. Thanks for tonight. I mean it. Now go to sleep. | happy | jackie |

---

## Rogue Amendiares

Her voice is clipped and plain, never theatrical. Idles: `rogue`, `lean`, `bar`, `chair`, `generic_arms_crossed`. The Afterlife booth is a `chair` or `couch` seat.

### R1. Terms (light, 12 lines, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R1.open.01 | Rogue (copy) | start | I'm not asking you as a friend. I'm hiring you. Sit. | neutral | rogue |
| R1.open.02 | Rogue (copy) | start | A note. Sealed. It goes to a man in Kabuki. He'll be at a noodle stall. | neutral | rogue |
| R1.open.03 | Rogue (copy) | start | Price is what we haggle. Don't insult me by working for free. | emphatic | generic_arms_crossed |

**Gap R1.g1** after R1.open.03.
* **asks** `R1.g1.ask`, Rogue (copy), question, rogue: "Name your number. And don't tell me you don't have one."
* **knows** the Afterlife's private booth, the errand (a note, a Kabuki noodle stall), the fee range 300 to 1,200, she respects people who negotiate.
* **secret** that the note is a bar tab and an apology she can't send through anyone she employs.
* **wants** V to take the job at a fair price.
* **idle** `rogue`, hands flat on the table.
* **resumes on** the tag `take`, `push` or `free`, or a 2-game-hour timer.
* **branches** `push` with a good argument -> R1.open.04. `free` -> R1.open.05 and a smaller fee anyway.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R1.open.04 | Rogue (copy) | gap:R1.g1:resume (push) | That's a number. Fine. You argued it well. Don't make a habit of it. | nod | rogue |
| R1.open.05 | Rogue (copy) | gap:R1.g1:resume (free) | No. That's not how this works. Take the money. | no | generic_arms_crossed |
| R1.bark.arrive.a | Rogue (phone) | place:stall:arrived | He's the one by the red lantern. Hands in his pockets. Don't stare. | neutral | - |
| R1.bark.arrive.b | Rogue (phone) | place:stall:arrived | Old, grey coat, suspicious. That's him. Go. | neutral | - |

Extras (the old merc, a street-solo archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R1.merc.01 | Old merc (extra, archetype voice) | npc:merc:note | A bar tab. She owes me a drink since a night neither of us should have walked out of. | shrug | generic_hips |

**Gap R1.g2** after R1.merc.01.
* **asks** `R1.g2.ask`, Old merc (extra, archetype voice), question, generic_hips: "Does she ask about me? Or just about the money?"
* **knows** V carries the note, the merc has not forgiven her, he will hand back a coaster or a cold word.
* **secret** that he never stopped caring where she was.
* **wants** V to carry back an honest word.
* **idle** `generic_hips`, leaning on the stall.
* **resumes on** V's reply or a 4-game-minute timer.
* **branches** V's answer sets whether the coaster is warm or a one-word reply.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R1.close.01 | Rogue (copy) | ending:report | A bar tab. Of course it was. ... Thank you. Don't say anything about it. | nod | rogue |
| R1.close.02 | Rogue (copy) | ending:report (coaster) | A coaster. Keep your mouth shut. ... I'll remember that. | shrug | rogue |

### R2. Hiring Day (light, 14 lines, 1 gap)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R2.open.01 | Rogue (copy) | start | Three people. One job. Courier escort, three days, no questions. | neutral | rogue |
| R2.open.02 | Rogue (copy) | start | I don't hire on charm. You read people better than the Afterlife does. | neutral | rogue |
| R2.open.03 | Rogue (copy) | start | Sit. Ask two questions each. Watch their hands. | emphatic | generic_arms_crossed |

**Gap R2.g1** after R2.open.03.
* **asks** `R2.g1.ask`, Rogue (copy), question, rogue: "What do you look at first when someone walks in? Their face, their hands or their shoes?"
* **knows** three candidates (one reliable, one glory hound, one informant), two questions each, the extras answer with stage notes, V can pick one or none.
* **secret** which of the three is the informant.
* **wants** V's honest read.
* **idle** `chair` in the booth.
* **resumes on** the first candidate arriving or a 3-game-minute timer.
* **branches** V's answer decides which candidate Rogue pays attention to when V asks questions.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R2.stage.interview.01 | Rogue (copy) | stage:interviews:enter | First one. Watch his hands. | emphatic | rogue |
| R2.stage.interview.02 | Rogue (copy) | stage:interviews:next | Next. Don't let him charm you. | emphatic | rogue |
| R2.stage.interview.03 | Rogue (copy) | stage:interviews:next | Last one. Quiet types hide the most. | neutral | rogue |
| R2.stage.choice.01 | Rogue (copy) | stage:choice:enter | Well? Who gets the job. Or none. Don't hedge. | question | generic_arms_crossed |
| R2.bark.pick.a | Rogue (copy) | choice:A | You think so? Alright. I'll see. | shrug | rogue |
| R2.bark.pick.b | Rogue (copy) | choice:none | None. Bold. I'll do it myself. | nod | rogue |
| R2.result.good | Rogue (phone) | ending:good-hire | The job went clean. Your pick delivered. Come by for your cut. | nod | - |
| R2.result.bad | Rogue (phone) | ending:bad-hire | He walked. Left the client in a car park. Come by, I'll tell you what I'd have seen. | neutral | - |
| R2.close.01 | Rogue (copy) | ending:good-hire | Good eye. Don't let it go to your head. | nod | rogue |
| R2.close.02 | Rogue (copy) | ending:bad-hire | Now you know what it looks like. Learn it. | neutral | rogue |

### R3. Four Questions (light, 17 lines, 2 gaps)

Opener in person at the Afterlife, trigger `start`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R3.open.01 | Rogue (copy) | start | An accountant. Nervous, hiding in a Northside drop house. He wants out. | neutral | rogue |
| R3.open.02 | Rogue (copy) | start | Four questions. Reach. Backup. Extraction. What defends the target. | emphatic | rogue |
| R3.open.03 | Rogue (copy) | start | I'll be in your ear. You walk him out. No cars, they get seen. | emphatic | generic_arms_crossed |

**Gap R3.g1** after R3.open.03.
* **asks** `R3.g1.ask`, Rogue (copy), question, rogue: "Do you take it? And if you want a car, argue it. I'll tell you why you're wrong."
* **knows** the three routes (alley, rooftops, canal road), Rogue stays in the booth, her lines are `remote`, the squad patrols on timers.
* **secret** that she still thinks of every client as someone's last chance.
* **wants** V to accept or argue.
* **idle** `chair` at the booth.
* **resumes on** the tag `in`, `car` or `no`, or a 2-game-hour timer.
* **branches** `car` plays R3.open.04.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R3.open.04 | Rogue (copy) | gap:R3.g1:resume (car) | Cars get seen. Go on foot. Argue after. | no | rogue |
| R3.stage.recon.01 | Rogue (phone) | place:drop-house:arrived | Question one. Reach. How far can they see from the windows? | question | - |
| R3.stage.recon.02 | Rogue (phone) | stage:recon:next | Backup. Who's on the stairs? Two? Three? | question | - |
| R3.stage.recon.03 | Rogue (phone) | stage:recon:next | Extraction. Pick the route. Alley's short and watched. Roofs are long and empty. | neutral | - |
| R3.bark.unseen.a | Rogue (phone) | watch:patrol:clear | Clear. Move. | neutral | - |
| R3.bark.unseen.b | Rogue (phone) | watch:patrol:clear | Patrol's gone. Go now. | neutral | - |
| R3.bark.seen.a | Rogue (phone) | squad:patrol:alert | You're spotted. Don't stop. I'll talk you through. | emphatic | - |
| R3.bark.seen.b | Rogue (phone) | squad:patrol:alert | Damn it. Fight your way to the door, or get him down. | angry | - |

Extras (the accountant, a corporate archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R3.acc.01 | Accountant (extra, archetype voice) | npc:accountant:meets | Please. I can't sleep, I can't think. I'll do whatever you say. | fear | generic_back |

**Gap R3.g2** after the handover at the Afterlife door.
* **asks** `R3.g2.ask`, Rogue (copy), question, rogue: "Fifth question. Who will miss you?"
* **knows** the client is inside, the job result (clean, loud or lost), Rogue says the fifth question as a rule.
* **secret** that she asks it of herself.
* **wants** V to answer or be silent.
* **idle** `lean` in the doorway.
* **resumes on** V's reply or a 5-game-minute timer.
* **branches** a real answer gives R3.close.02. A joke gives R3.close.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R3.close.01 | Rogue (copy) | ending:clean | Nobody saw him. Good. That's the job. Here's your pay. | nod | rogue |
| R3.close.02 | Rogue (copy) | gap:R3.g2:resume (honest) | Good. Keep that list short and keep it real. | nod | rogue |
| R3.close.03 | Rogue (copy) | gap:R3.g2:resume (joke) | Funny. Answer it later. | shrug | rogue |

### R4. Say Left (full, 25 lines, 3 gaps)

`sfx:` the Type-66's engine idle and rain on the roof (game vehicle audio, no pack file). `music:` none, the radio stays off.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R4.open.01 | Rogue (copy) | start | Here. Keys. Don't make a thing of it. | neutral | rogue |
| R4.open.02 | Rogue (copy) | start | I haven't been a passenger in years. You drive. I'll tell you where. | neutral | rogue |
| R4.open.03 | Rogue (copy) | start | No map. No questions. Just left and right. | emphatic | generic_arms_crossed |

**Gap R4.g1** after R4.open.03.
* **asks** `R4.g1.ask`, Rogue (copy), question, rogue: "You ever let someone else steer? Really? For a night?"
* **knows** V drives the Type-66, she gives directions only, the route is hidden, heat must stay zero, about 25 game minutes.
* **secret** that she has not handed her keys to anyone she trusted in years.
* **wants** V to take the wheel without commentary.
* **idle** `lean` against the car.
* **resumes on** V getting in the driver's seat (a `place` radius around the car) or a 3-game-minute timer.
* **branches** V's reply colors her first direction (dry or warm).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R4.stage.route.01 | Rogue (copy) | place:cp-1:arrived | Left. At the light. | neutral | rogue |
| R4.stage.route.02 | Rogue (copy) | place:cp-2:arrived | The city used to have more trees. Right. | neutral | rogue |
| R4.stage.route.03 | Rogue (copy) | place:cp-3:arrived | Johnny drove like he owned the road. Left here. | angry | rogue |
| R4.stage.route.04 | Rogue (copy) | place:cp-4:arrived | I notice the doors now. Who's behind them. Next. | neutral | rogue |
| R4.stage.route.05 | Rogue (copy) | place:cp-5:arrived | Right. Then keep going. | neutral | rogue |
| R4.bark.ignore.a | Rogue (copy) | route:ignored | I said left. Left means left. | angry | rogue |
| R4.bark.ignore.b | Rogue (copy) | route:ignored | Turn around. I'll wait. | no | rogue |
| R4.bark.heat.a | Rogue (copy) | heat:rising | Pull over. Cops. Not tonight. | emphatic | rogue |
| R4.bark.heat.b | Rogue (copy) | heat:rising | Slow down. We were quiet. Keep it quiet. | emphatic | rogue |

**Gap R4.g2** after R4.stage.route.03 (a mid-drive beat).
* **asks** `R4.g2.ask`, Rogue (copy), question, rogue: "Do you have anyone you'd hand your keys to? Honestly?"
* **knows** V is driving, rain or clear, Rogue is a passenger, the route is partly done.
* **secret** that the answer tells her whether she trusts V with something larger.
* **wants** an honest answer, not a speech.
* **idle** `generic_arms_crossed`, seated passenger.
* **resumes on** V's reply or a 4-game-minute timer.
* **branches** a specific name gives R4.stage.route.04 unchanged. "Nobody" gives an extra line `R4.stage.route.04b`, Rogue, sad, rogue: "Funny. Me neither. Until tonight."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R4.stage.rail.01 | Rogue (copy) | place:rail:arrived | Stop. Here. Get out. | neutral | rogue |
| R4.stage.rail.02 | Rogue (copy) | stage:rail:enter | I come here when the Afterlife gets loud. Water doesn't ask. | neutral | lean |
| R4.stage.rail.03 | Rogue (copy) | stage:rail:weather (rain) | Rain. Good. It takes the noise out of my head. Stand in it. | nod | lean |
| R4.stage.rail.04 | Rogue (copy) | stage:rail:weather (clear) | Clear night. You can almost see stars through the haze. Almost. | nod | lean |

**Gap R4.g3** after R4.stage.rail.02 (the rail).
* **asks** `R4.g3.ask`, Rogue (copy), question, lean: "What do you do when the city gets too loud? Where do you go?"
* **knows** the waterfront lot (verify), 5 game minutes at the rail, weather and hour, she doesn't smoke or drink in this scene.
* **secret** that this is where she goes after bad nights and never says why.
* **wants** V to answer simply.
* **idle** `lean` at the rail.
* **resumes on** a 5-game-minute timer.
* **branches** V's answer is used in R4.close.01.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R4.close.01 | Rogue (copy) | ending:drive-back | Good answer. Take me back. I'll drive this time. | nod | rogue |
| R4.close.02 | Rogue (copy) | ending:drive-back | You drove it well. Don't tell anyone. | nod | rogue |
| R4.close.03 | Rogue (copy) | ending:short | You pulled out early. Fine. The quiet's still there. | shrug | rogue |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R4.stage.route.06 | Rogue (copy) | place:cp-5b:arrived | Slow down. This was a shop once. Don't ask what kind. | neutral | rogue |
| R4.bark.praise.a | Rogue (copy) | route:smooth | Good. You hold the line. Don't speed. | nod | rogue |
| R4.bark.praise.b | Rogue (copy) | route:smooth | Steady. That's all I ask of a driver. | nod | rogue |

### R5. Who's Listening (full, 25 lines, 3 gaps)

`Holocall R5.call`, caller Rogue, picture voice-only (she is at the Afterlife, the picture would show the room), trigger `start`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R5.call.01 | Rogue (phone) | start | Kabuki. Capsule hotel. Wear nothing you'd miss. | neutral | - |
| R5.call.02 | Rogue (phone) | start | I'm hiding a client tonight. The other side knows where. | emphatic | - |
| R5.call.03 | Rogue (phone) | start | It's one of three staff. I can't ask anyone I pay. | emphatic | - |
| R5.call.04 | Rogue (phone) | start | You're the only one I can ask. Be there in an hour. | neutral | - |

**Gap R5.g1** after R5.call.04 (the call stays open).
* **asks** `R5.g1.ask`, Rogue (phone), question: "Can you do it? Because if you can't, I'll find another way, and you'll never know I asked."
* **knows** a Kabuki capsule hotel, one hour, three staff (a night clerk, a cleaner, a bellhop), the client's door, a short squad fight if V misses the leaker.
* **secret** that she suspects one but won't say which.
* **wants** a yes, quickly.
* **idle** none (a call).
* **resumes on** the tag `yes` or `no`, V hanging up, or a 10-game-minute timer.
* **branches** If V hangs up without answering she says `R5.call.05` on the line before it closes. A yes continues. A no ends the quest (`stood-up`).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R5.call.05 | Rogue (phone) | gap:R5.g1:resume (hangup) | Fine. I'll take that as no. | no | - |
| R5.stage.lobby.01 | Rogue (copy) | place:hotel:arrived | Check in. Look bored. Count who leaves their post. | emphatic | rogue |
| R5.stage.lobby.02 | Rogue (copy) | stage:lobby:enter | Clerk, cleaner, bellhop. One of them is on someone's payroll. | neutral | generic_arms_crossed |

**Gap R5.g2** after R5.stage.lobby.02.
* **asks** `R5.g2.ask`, Rogue (copy), question, generic_arms_crossed: "Who do you trust least? Go with your gut. I'll tell you if it's wrong."
* **knows** three staff, the seeded leaker, a 25 game-minute window, V can watch and question.
* **secret** which one it is, if V asks she answers in riddles.
* **wants** V's instinct.
* **idle** `generic_arms_crossed`, in the corridor (`post`).
* **resumes on** the first `watch:post-left` event or a 25-game-minute timer.
* **branches** V's guess biases who Rogue watches.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R5.bark.leaver.a | Rogue (copy) | watch:post-left | There. He left his post. Go. | emphatic | rogue |
| R5.bark.leaver.b | Rogue (copy) | watch:post-left | The cleaner just stepped out. Watch where. | emphatic | rogue |
| R5.bark.caught.a | Rogue (copy) | npc:leaker:confesses | Ah. Underpaid. It's always the underpaid. | sad | rogue |
| R5.bark.caught.b | Rogue (copy) | npc:leaker:confesses | I'll deal with him. Go back to the lobby. | nod | rogue |
| R5.bark.missed.a | Rogue (copy) | squad:hotel:arrived | They're here. Hold the corridor. | angry | rogue |
| R5.bark.missed.b | Rogue (copy) | squad:hotel:arrived | Damn. Too late. Fight, V. Fight. | angry | rogue |
| R5.bark.down.a | Rogue (copy) | squad:hotel:down | That's the last. Check the client. | neutral | rogue |
| R5.bark.down.b | Rogue (copy) | squad:hotel:down | Done. Breathe. | neutral | rogue |

Extras (the leaker, a street-worker archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R5.leaker.01 | Staff member (extra, archetype voice) | npc:leaker:cornered | I didn't want to! They said they'd hurt my family! | fear | generic_back |

**Gap R5.g3** after the leak or fight resolves (dawn).
* **asks** `R5.g3.ask`, Rogue (copy), question, rogue: "If it had been Panam, or Nix, or one of my own, what would you have done?"
* **knows** the client is leaving by car at dawn (a `cast` driver), the result (`caught`, `fought` or `lost-client`).
* **secret** that she doesn't know what she'd have done either.
* **wants** a real answer.
* **idle** `lean` at the street door.
* **resumes on** V's reply or a 6-game-minute timer.
* **branches** a loyal answer gives R5.close.01. A cold one gives R5.close.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R5.close.01 | Rogue (copy) | gap:R5.g3:resume (loyal) | Good. Loyalty's cheap until it costs you. | nod | rogue |
| R5.close.02 | Rogue (copy) | gap:R5.g3:resume (cold) | Practical. I'd have said the same. Hate that I would. | shrug | rogue |
| R5.close.03 | Rogue (copy) | ending:lost-client | We lost the client. That's mine, not yours. | sad | rogue |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R5.stage.corridor.01 | Rogue (copy) | stage:lobby:enter | Client's behind that door. Seventh floor. Nobody opens it but me. | neutral | rogue |
| R5.bark.waiting.a | Rogue (copy) | timer:lobby:10min | Ten minutes. Anyone moved? | question | generic_arms_crossed |
| R5.bark.waiting.b | Rogue (copy) | timer:lobby:10min | Keep watching. They're patient. We're more patient. | neutral | rogue |

### R6. What I Never Said (full, 26 lines, 4 gaps)

`sfx:` a low washer hum, fluorescent buzz, a dryer buzzer (game ambient, "(verify)"), no music.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R6.open.01 | Rogue (phone) | start | Three a.m. The laundromat in Little China. Bring nothing. | neutral | - |
| R6.open.02 | Rogue (phone) | start | I've got the soap. And something I need to say. | sad | - |
| R6.open.03 | Rogue (phone) | start | You know who else will be listening. That's the point. | emphatic | - |

**Gap R6.g1** after R6.open.03 (a text thread).
* **asks** `R6.g1.ask`, Rogue (phone), question: "Can you come? And if he has something to say, let him say it later."
* **knows** the meeting place (an all-night laundromat), 03:00, Johnny is in V's head and will hear.
* **secret** what she wants to say to Johnny.
* **wants** V to come.
* **idle** none.
* **resumes on** the `meet:met` event or the tag `yes`, or the 3-game-hour timer.
* **branches** `yes` -> the meeting.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R6.stage.spin.01 | Rogue (copy) | place:laundromat:arrived | Sit. I fold while I talk. It keeps my hands honest. | neutral | rogue |
| R6.stage.spin.02 | Rogue (copy) | stage:spin:enter | I know you're in there, Johnny. Don't answer yet. | sad | rogue |
| R6.stage.spin.03 | Rogue (copy) | stage:spin:enter | I wasn't angry about the tower. I was angry you didn't tell me what it would cost. | angry | rogue |
| R6.stage.spin.04 | Rogue (copy) | stage:spin:enter | I've not forgiven you. I've not stopped either. Both are true. | sad | chair |

**Gap R6.g2** after R6.stage.spin.04.
* **asks** `R6.g2.ask`, Rogue (copy), question, chair: "Does he say anything? Tell me, V. Even if it's rude."
* **knows** Johnny can answer privately through `johnny-voice`, V decides to relay or keep, nothing in the pack states what Johnny says.
* **secret** that she wants him to say sorry and doesn't expect it.
* **wants** V to be honest about whether he spoke.
* **idle** `chair`, folding a shirt.
* **resumes on** the tag `relay`, `keep` or `lie`, or a 10-game-minute timer.
* **branches** `relay` -> R6.stage.reply.01. `keep` -> R6.stage.reply.02. `lie` -> R6.stage.reply.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R6.stage.reply.01 | Rogue (copy) | gap:R6.g2:resume (relay) | He said that? ... Tell him I know the difference between him and what he did. | sad | rogue |
| R6.stage.reply.02 | Rogue (copy) | gap:R6.g2:resume (keep) | You keep it, then. That's decent. Thank you. | nod | rogue |
| R6.stage.reply.03 | Rogue (copy) | gap:R6.g2:resume (lie) | You don't have to protect me, V. ... But thanks. | sad | rogue |
| R6.stage.spin.05 | Rogue (copy) | stage:spin:enter | I do my own washing. Always have. It's the only honest chore I've got. | shrug | rogue |

**Gap R6.g3** after R6.stage.spin.05.
* **asks** `R6.g3.ask`, Rogue (copy), question, rogue: "What would you say to him, if you could say anything and he'd listen? Say it to me instead."
* **knows** V carries Johnny, the laundromat is quiet, she is aging and honest tonight.
* **secret** that she's afraid of what the answer would be.
* **wants** V's own word, not Johnny's.
* **idle** `chair`, folding.
* **resumes on** V's reply or a 10-game-minute timer.
* **branches** a gentle answer gives R6.close.01. A hard one gives R6.close.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R6.bark.dryer.a | Rogue (copy) | sfx:dryer-buzz | That's the dryer. Hold on. | neutral | rogue |
| R6.bark.dryer.b | Rogue (copy) | sfx:dryer-buzz | Always when I get to the good part. | shrug | rogue |
| R6.stage.walkout.01 | Rogue (copy) | stage:walk-out:enter | Come on. I'll walk you to the corner. I don't drive tonight. | neutral | rogue |

**Gap R6.g4** after R6.stage.walkout.01.
* **asks** `R6.g4.ask`, Rogue (copy), question, rogue: "Do you ever wish you'd never met either of us?"
* **knows** the walk to the corner, her bag, Johnny's answer (if any) was relayed or kept.
* **secret** that she is grateful to V in a way she has no word for.
* **wants** an honest answer.
* **idle** `rogue`, walking with a bag.
* **resumes on** V's reply or a 3-game-minute timer.
* **branches** a "no" gives R6.close.03. A "yes" gives R6.close.04.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R6.close.01 | Rogue (copy) | gap:R6.g3:resume (gentle) | He'd have liked that. Don't tell him I said so. | nod | rogue |
| R6.close.02 | Rogue (copy) | gap:R6.g3:resume (hard) | Hard. Fair. He'd have said the same to himself. | shrug | rogue |
| R6.close.03 | Rogue (copy) | gap:R6.g4:resume (no) | Good. Because I'd hate to lose you. | sad | rogue |
| R6.close.04 | Rogue (copy) | gap:R6.g4:resume (yes) | Fair enough. Most people do. | shrug | rogue |
| R6.close.05 | Rogue (copy) | ending:walk-out | Go home, V. Get some sleep. And thank you. | nod | rogue |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| R6.bark.fold.a | Rogue (copy) | timer:spin:3min | Don't just sit. Hand me that. No, the other one. | shrug | rogue |
| R6.bark.fold.b | Rogue (copy) | timer:spin:3min | Folding keeps my hands quiet. Try it sometime. | nod | rogue |
| R6.stage.spin.06 | Rogue (copy) | stage:spin:enter | He made me laugh once. Years ago. Over something stupid. I never told him. | sad | chair |

---

## Kerry Eurodyne

Kerry swears, is blunt, checks that you are all right, and hides worry with a joke. Idles: `kerry`, `lean`, `stool`, `bar`, `couch`. Texts are `(phone)` lines.

### K1. Caliente Mornings (light, 11 lines, 1 gap)

Opener by text, trigger `start`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K1.open.01 | Kerry (phone) | start | Morning. Bored. Villa echoes. Need coffee somewhere nobody knows my name. | neutral | - |
| K1.open.02 | Kerry (phone) | start | Double espresso, Jamaican blend, no sugar. If you say sugar I'm leaving. | emphatic | - |
| K1.open.03 | Kerry (phone) | start | Gate, eight. I'll drive. | neutral | - |

**Gap K1.g1** after K1.open.03 (the text thread).
* **asks** `K1.g1.ask`, Kerry (phone), question: "You coming? And what's your coffee, so I know who I'm dealing with?"
* **knows** the meeting place (his villa gate), 08:00, he will drive Guinevere, the destination is an old diner from the SAMURAI days that may not exist.
* **secret** that the diner matters more to him than the coffee.
* **wants** V to say yes.
* **idle** none.
* **resumes on** the `meet:met` event or the tag `yes`, or the 1-game-hour timer.
* **branches** V's coffee order is remembered for the `order` stage.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K1.stage.ride.01 | Kerry (copy) | stage:ride:enter | Early gigs, we drank so much coffee the bassist shook. Never again. Twice a week. | happy | kerry |
| K1.stage.corner.01 | Kerry (copy) | place:corner:arrived | It's... a laundromat now. Of course it is. | sad | kerry |
| K1.stage.corner.02 | Kerry (copy) | place:corner:arrived | Stand here with me a minute. Don't say anything clever. | neutral | lean |
| K1.bark.order.a | Kerry (copy) | choice:order | Double espresso. Jamaican. No sugar. You? ... Sugar? Seriously? | surprise | kerry |
| K1.bark.order.b | Kerry (copy) | choice:order | Good choice. You're allowed to stay. | nod | kerry |
| K1.close.01 | Kerry (copy) | ending:order | Strings, coffee, rough rooms. That's what we ate. Thanks for finding the corner with me. | happy | stool |
| K1.close.02 | Kerry (copy) | ending:order | Next time you pick. But no sugar. | nod | kerry |

### K2. Incognito (light, 13 lines, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K2.open.01 | Kerry (copy) | start | I haven't eaten at a stall in twelve years. Somebody always lifts a phone. | sad | kerry |
| K2.open.02 | Kerry (copy) | start | Hat. Scarf. Glasses. You run interference. If anyone looks, you distract them. | emphatic | kerry |

**Gap K2.g1** after K2.open.02.
* **asks** `K2.g1.ask`, Kerry (copy), question, kerry: "Do I look like a nobody? Honestly. Don't flatter me."
* **knows** the Japantown night food street, 600 m route, five points, three recognition events (fan, guard with a phone, drone), the route can be retried once.
* **secret** that he misses not being recognized and also needs it.
* **wants** V to take the job seriously.
* **idle** `kerry`, adjusting the scarf.
* **resumes on** the tag `in` or `no`, or a 4-game-minute timer.
* **branches** V's honesty sets how cocky he is on the route.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K2.bark.fan.a | Kerry (copy) | npc:fan:spots | Shit. Teenager at two o'clock. Do something. | fear | kerry |
| K2.bark.fan.b | Kerry (copy) | npc:fan:spots | He saw me. He's looking. Distract him! | fear | kerry |
| K2.bark.safe.a | Kerry (copy) | npc:fan:leaves | Gone. Good. Keep walking. | nod | kerry |
| K2.bark.safe.b | Kerry (copy) | npc:fan:leaves | That worked. I'm almost enjoying this. | happy | kerry |
| K2.bark.phone.a | Kerry (copy) | npc:guard:phone | Phone up. Damn. Back up, back up. | angry | kerry |
| K2.bark.phone.b | Kerry (copy) | npc:guard:phone | That's it. Seen. We try again. | no | kerry |

Extras (the fan, a teen archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K2.fan.01 | Fan (extra, archetype voice) | npc:fan:spots | Wait. Is that... no. Can't be. | surprise | generic_front |

**Gap K2.g2** after sitting at the stall.
* **asks** `K2.g2.ask`, Kerry (copy), question, stool: "Does it taste better because nobody knows who I am? Or just because it's cheap?"
* **knows** the stall, a bowl, he is relaxed, a small kid is about to recognize him.
* **secret** that he wanted a kid to recognize him tonight.
* **wants** V's honest answer.
* **idle** `stool`, eating.
* **resumes on** V's reply or a 6-game-minute timer.
* **branches** V's answer decides whether he lets the kid see him.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K2.close.01 | Kerry (copy) | ending:unmasked | Look at that. A kid. Hand me the coaster. I'll sign it. | happy | kerry |
| K2.close.02 | Kerry (copy) | ending:seen | We got seen. It's fine. It was a good bowl. | shrug | kerry |

### K3. Guinevere Wants to Run (light, 15 lines, 1 gap)

`music:` the winner chooses the radio station at `stage:finish:enter`, the pack plays whatever the game's radio does, nothing shipped.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K3.open.01 | Kerry (copy) | start | She hasn't run in years. Guinevere. I think she's bored. | neutral | kerry |
| K3.open.02 | Kerry (copy) | start | You, your car, me, her. From my gate to the stadium lot. First one wins the radio. | emphatic | kerry |
| K3.open.03 | Kerry (copy) | start | No ramming, no cops. If the heat comes, it's void. | emphatic | kerry |

**Gap K3.g1** after K3.open.03.
* **asks** `K3.g1.ask`, Kerry (copy), question, kerry: "What are you driving? And be honest, I want a fair fight."
* **knows** the race rules, the finish (Atlantis Stadium lot, verify), heat zero, Kerry drives Guinevere, he drives like a man who has a lot to prove.
* **secret** that he is a little scared of how hard he wants to win.
* **wants** the race.
* **idle** `lean` against the car.
* **resumes on** the tag `race` or `no`, or a 6-game-hour timer.
* **branches** V's car sets the margin in his banter.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K3.stage.start.01 | Kerry (copy) | stage:start:enter | Three. Two. One. Go! | emphatic | kerry |
| K3.bark.third.a | Kerry (copy) | race:third | Third of the way! Keep up! | happy | kerry |
| K3.bark.third.b | Kerry (copy) | race:third | You're behind me! Catch up! | happy | kerry |
| K3.bark.two-thirds.a | Kerry (copy) | race:two-thirds | Last stretch, you maniac! | emphatic | kerry |
| K3.bark.two-thirds.b | Kerry (copy) | race:two-thirds | She's flying. Look at her go! | happy | kerry |
| K3.bark.won.a | Kerry (copy) | race:kerry-won | Ha! Guinevere never loses! Pick your station, old rival. | happy | kerry |
| K3.bark.won.b | Kerry (copy) | race:v-won | Damn it! You beat her! ... Fine. You pick. | angry | kerry |
| K3.bark.void.a | Kerry (copy) | race:void | Cops. Void. We'll do it again properly. | shrug | kerry |
| K3.bark.void.b | Kerry (copy) | race:void | Heat. Void. Let's go slowly home. | shrug | kerry |
| K3.close.01 | Kerry (copy) | ending:photo-finish | That was a hair. You'll drive her better than me someday. | happy | kerry |
| K3.close.02 | Kerry (copy) | ending:finish | My age shows. Doesn't matter. Great run. | happy | lean |

### K4. Bootleg (full, 25 lines, 3 gaps)

`Holocall K4.call`, caller Kerry, picture live (he is pacing in his villa, a guitar stand behind him), trigger `start`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K4.call.01 | Kerry (phone) | start | They took my tech. My guitar tech. Thirty years with me. | angry | kerry |
| K4.call.02 | Kerry (phone) | start | Some fan. A collector. Says he wants a private show. | angry | kerry |
| K4.call.03 | Kerry (phone) | start | No cops. I can't have it on the news. Can you come? | fear | kerry |
| K4.call.04 | Kerry (phone) | start | Villa gate, one hour. And V... thanks. | sad | kerry |

**Gap K4.g1** after K4.call.04.
* **asks** `K4.g1.ask`, Kerry (phone), question, kerry: "Tell me you're in. And tell me you're not going to say 'I told you so' about fans."
* **knows** the collector's closed theatre in Westbrook, Kerry is the bait at the front, V goes around the side, the guards are fans, six of them, the tech is on the second floor.
* **secret** that he is a little ashamed it's his own fans.
* **wants** V in.
* **idle** `kerry`, pacing.
* **resumes on** the tag `in` or `no`, V hanging up, or a 1-game-hour timer.
* **branches** V hanging up before answering: Kerry says `K4.call.05` and calls the police anyway (ending `no`, bond -5).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K4.call.05 | Kerry (phone) | gap:K4.g1:resume (hangup) | ...Right. I'll do it myself. | sad | kerry |
| K4.stage.ride.01 | Kerry (copy) | stage:ride:enter | I'm going in the front. They love me. That's the problem, and it's useful. | emphatic | kerry |
| K4.stage.museum.01 | Kerry (copy) | place:theatre:arrived | Wait here. Count thirty. Then go around the side. | neutral | kerry |
| K4.stage.museum.02 | Kerry (copy) | stage:museum:enter | Gentlemen! Kerry Eurodyne. Which of you wants an autograph first? | happy | kerry |

Extras (the guards, a security archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K4.guard.01 | Guard (extra, archetype voice) | npc:guard:sees | No way. It's actually him. | surprise | generic_front |
| K4.guard.02 | Guard (extra, archetype voice) | npc:guard:hostile | Hey! Who are you? Get away from the case! | angry | generic_arms_crossed |

**Gap K4.g2** after K4.stage.museum.02 (the guards hesitate).
* **asks** `K4.g2.ask`, Kerry (copy), question, kerry: "Keep them talking or hit them? I'm an old man with a guitar. Tell me what you see."
* **knows** the guards hesitate for 30 s, V is going around the side, Kerry stands at the door, a column behind him, the tech is upstairs.
* **secret** that he hasn't been this scared in years and is faking calm.
* **wants** V to move fast.
* **idle** `kerry`, signing a jacket.
* **resumes on** the `hostage:freed` event or a 3-game-minute timer.
* **branches** `loud` makes him hide behind the column and shout instructions (K4.bark.loud lines).

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K4.bark.sneak.a | Kerry (copy) | place:side-door:arrived | Almost. Don't rush. I'll keep them busy. | emphatic | kerry |
| K4.bark.sneak.b | Kerry (copy) | place:side-door:arrived | Quiet. Stairs on the left. Go. | emphatic | kerry |
| K4.bark.loud.a | Kerry (copy) | squad:theatre:alert | Shit, they turned! Cover! Get him out! | fear | kerry |
| K4.bark.loud.b | Kerry (copy) | squad:theatre:alert | I'm behind the column! Hit them! | emphatic | kerry |
| K4.bark.freed.a | Kerry (copy) | hostage:freed | You've got him! Bring him out! | happy | kerry |
| K4.bark.freed.b | Kerry (copy) | hostage:freed | Thank God. Get him in the car. | happy | kerry |
| K4.bark.down.a | Kerry (copy) | squad:theatre:down | They're down. Is he hurt? Is he alright? | fear | kerry |
| K4.bark.down.b | Kerry (copy) | squad:theatre:down | Done. Check on him. | emphatic | kerry |

Extras (the tech, a worker archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K4.tech.01 | Guitar tech (extra, archetype voice) | hostage:freed | Kerry? You came yourself? You old fool. | surprise | generic_front |

**Gap K4.g3** after the car ride, at the villa gate.
* **asks** `K4.g3.ask`, Kerry (copy), question, lean: "Stay a while. Please. I don't want to be alone with that museum in my head."
* **knows** the tech is home safe (or not), the collector's guards are down or fled, the quest has ended.
* **secret** that he doesn't want the tech to see him shake.
* **wants** company.
* **idle** `lean`, at the villa gate.
* **resumes on** V's reply or a 6-game-minute timer.
* **branches** a yes gives K4.close.01. A no gives K4.close.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K4.close.01 | Kerry (copy) | gap:K4.g3:resume (yes) | Thanks. Next time I'll sign something and we all go home. | happy | lean |
| K4.close.02 | Kerry (copy) | gap:K4.g3:resume (no) | Fine. Go. I'll call. | shrug | kerry |
| K4.close.03 | Kerry (copy) | ending:lost | He's gone. I let this happen. ... Go home, V. | sad | kerry |

### K5. Tomorrow in Tokyo (full, 26 lines, 3 gaps)

`sfx:` water lapping, rigging clinks, distant gulls (game ambient, "(verify)"), a quiet one-shot of a phone ringing at the stern. `music:` none.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K5.open.01 | Kerry (phone) | start | Marina. Dusk. The boat. | neutral | - |
| K5.open.02 | Kerry (phone) | start | I've got a call. Tokyo. The kids. I need someone near. | sad | - |
| K5.open.03 | Kerry (phone) | start | Don't listen. Don't leave. Don't be weird about it. | emphatic | - |

**Gap K5.g1** after K5.open.03 (a text thread).
* **asks** `K5.g1.ask`, Kerry (phone), question: "Can you come? I'm more nervous about this than any stage."
* **knows** the marina, dusk, his boat, the call is private and its content is never rendered, V keeps outside 5 m and inside 15 m.
* **secret** that he fears the call will be short.
* **wants** V to come and stay quiet.
* **idle** none.
* **resumes on** the `meet:met` event or the tag `yes`, or a 3-game-hour timer.
* **branches** `yes` -> the deck.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K5.stage.deck.01 | Kerry (copy) | place:pier:arrived | There she is. Not much of a boat. Sit. Have a coffee. | neutral | kerry |
| K5.stage.deck.02 | Kerry (copy) | stage:deck:enter | It's already tomorrow there. They're eating breakfast while I'm having dinner. | sad | stool |

**Gap K5.g2** after K5.stage.deck.02.
* **asks** `K5.g2.ask`, Kerry (copy), question, stool: "Do you ever call someone far away and not know what to say? ... Yeah. Me every time."
* **knows** the call is soon, he is nervous, the deck, coffee, V is allowed to answer.
* **secret** that the kids don't always pick up.
* **wants** V to calm him down.
* **idle** `stool`, checking the time.
* **resumes on** V's reply or a 5-game-minute timer.
* **branches** V's reassurance shapes how he says goodbye before the call.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K5.stage.call.01 | Kerry (copy) | stage:call:enter | I'm going to the stern. Stay where I can see you. | nod | kerry |
| K5.bark.eavesdrop.a | Kerry (copy) | watch:apart:inside | Hey. Too close. Give me my space. | angry | kerry |
| K5.bark.eavesdrop.b | Kerry (copy) | watch:apart:inside | I said don't listen. Back off. | angry | kerry |
| K5.bark.eavesdrop.end | Kerry (copy) | watch:apart:ended | That's it. Call's over. ... You listened. | sad | kerry |
| K5.stage.after.01 | Kerry (copy) | stage:after:enter | They asked about the guitars. That's all I'll say. | sad | stool |
| K5.stage.after.02 | Kerry (copy) | stage:after:enter | Sorry. I'm not good at this. Sit down. | nod | stool |

**Gap K5.g3** after K5.stage.after.02.
* **asks** `K5.g3.ask`, Kerry (copy), question, stool: "If you could say one thing to someone far away, what would it be? Say it to me."
* **knows** the call is done, content never revealed, he is quiet, V may answer or stay silent.
* **secret** that he wants V to be the person he can say these things to.
* **wants** V's honest answer.
* **idle** `stool`.
* **resumes on** the tag `answer` or `silent`, or an 8-game-minute timer.
* **branches** `answer` -> K5.close.01. `silent` -> K5.close.02.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K5.stage.water.01 | Kerry (copy) | stage:water:enter | Come sit on the pier. Feet over the edge. It's the only way to watch the lights come on. | nod | kerry |
| K5.close.01 | Kerry (copy) | choice:answer | That's a good thing to say. Say it, soon. Not to me. To them. | sad | kerry |
| K5.close.02 | Kerry (copy) | choice:silent | Quiet's fine. I've never been good at the words either. | nod | kerry |
| K5.close.03 | Kerry (copy) | ending:eavesdrop | I'm angry, and I'll be sorry tomorrow. Go home. | angry | kerry |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K5.stage.deck.03 | Kerry (copy) | place:pier:arrived | The boat's no yacht. I'm not a sailor. I just like rope on metal. | neutral | kerry |
| K5.stage.call.02 | Kerry (copy) | stage:call:enter | If I come back angry, it's not you. It's the distance. | sad | kerry |
| K5.bark.wait.a | Kerry (copy) | timer:call:midway | Still here. Don't go anywhere. | neutral | kerry |
| K5.bark.wait.b | Kerry (copy) | timer:call:midway | Almost done. Thanks for waiting. | nod | kerry |
| K5.stage.after.03 | Kerry (copy) | stage:after:enter | I'm better. Slightly. Sit. | nod | stool |
| K5.stage.water.02 | Kerry (copy) | stage:water:enter | The lights come on one by one. It's the closest I get to an audience that wants nothing. | sad | kerry |
| K5.stage.water.03 | Kerry (copy) | stage:water:enter | Thank you for staying close. And for not coming closer. | nod | kerry |
| K5.close.04 | Kerry (copy) | ending:after | Go home. Sleep. I'll text in the morning. | nod | kerry |

### K6. First String (full, 26 lines, 4 gaps)

`sfx:` a metro hum in the underpass, distant trains, a busker's guitar is not played (no music), only an ambient crowd murmur ("(verify)").

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.open.01 | Kerry (copy) | start | I want you to find something. My first guitar. | neutral | kerry |
| K6.open.02 | Kerry (copy) | start | Cheap, scratched, my initials on the headstock. It vanished in the bad years. | sad | kerry |
| K6.open.03 | Kerry (copy) | start | I never looked. I can't stand the idea it's gone. And I can't stand finding it alone. | sad | kerry |

**Gap K6.g1** after K6.open.03.
* **asks** `K6.g1.ask`, Kerry (copy), question, kerry: "Will you look? And if it's gone, you tell me straight."
* **knows** three shops (a pawn shop in Little China, a repair shop in Westbrook, a stall in Kabuki), leads that name a street, a hint every game hour, no music in the quest.
* **secret** that finding it would mean something about the man he was.
* **wants** V to say yes.
* **idle** `kerry`, holding a coffee.
* **resumes on** the tag `in` or `no`, or a 6-game-hour timer.
* **branches** `no` -> ending `no`.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.stage.leads.01 | Kerry (phone) | place:pawn:arrived | Is it in there? Tell me what you see. | question | - |
| K6.bark.hint.a | Kerry (phone) | timer:hint | Try the repair shop in Westbrook. Someone there knows strings. | nod | - |
| K6.bark.hint.b | Kerry (phone) | timer:hint | Maybe the stall in Kabuki? A guy there buys old gear. | nod | - |

Extras (a shopkeeper, a street archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.shop.01 | Shopkeeper (extra, archetype voice) | npc:shop:lead | Carved initials? A kid had one like that in the underpass. Plays it for coins. | nod | generic_hips |

**Gap K6.g2** after K6.shop.01.
* **asks** `K6.g2.ask`, Kerry (phone), question: "What's the name of the street? Say it. I'll meet you there."
* **knows** the lead (a busker in a Watson underpass), V has the street, Kerry is on the phone, nervous.
* **secret** that he is already walking toward it.
* **wants** V to confirm.
* **idle** none.
* **resumes on** V's reply or a 3-game-minute timer.
* **branches** V's tone sets how he arrives: anxious or hopeful.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.stage.underpass.01 | Kerry (copy) | place:underpass:arrived | There. That's the headstock. ... That's my K. | sad | kerry |
| K6.stage.underpass.02 | Kerry (copy) | stage:underpass:enter | Don't go near. Let me hear it from here. | emphatic | lean |

Extras (the busker, a youth archetype voice):

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.busker.01 | Busker (extra, archetype voice) | npc:busker:asked | This? Found it in a skip. It's all I've got. Not for sale. | no | generic_hold |

**Gap K6.g3** after K6.stage.underpass.02.
* **asks** `K6.g3.ask`, Kerry (copy), question, lean: "Do I buy it back? Or do I let a kid keep the thing that made me?"
* **knows** V can buy it (500 to 1,500 eddies, small flow), tell the kid, or leave it be, Kerry waits at the entrance (`post`) and hears from across the street.
* **secret** that he already knows what he wants and needs V to say it first.
* **wants** V's opinion.
* **idle** `lean`, hands in pockets.
* **resumes on** the tag `buy`, `tell` or `quiet`, or a 10-game-minute timer.
* **branches** `quiet` -> K6.close.01. `buy` -> K6.close.02. `tell` -> K6.close.03.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.close.01 | Kerry (copy) | choice:quiet | Leave it. All I needed to know is that it still gets played. | nod | kerry |
| K6.close.02 | Kerry (copy) | choice:buy | Alright. Buy it. Then I'll give it back. Don't ask me why. | shrug | kerry |
| K6.close.03 | Kerry (copy) | choice:tell | Tell him. Let him look at me. I can take a kid looking. | emphatic | kerry |
| K6.stage.walk.01 | Kerry (copy) | stage:walk-away:enter | Walk with me. I need to put my feet on something that moves. | neutral | kerry |

**Gap K6.g4** after K6.stage.walk.01.
* **asks** `K6.g4.ask`, Kerry (copy), question, kerry: "What did it feel like, watching me find it? I'm not good at seeing myself."
* **knows** the guitar is found, the choice made, the eddies left in the case (if any), he is quiet.
* **secret** that he is afraid the public version of himself is eating the private one.
* **wants** V to say what V saw.
* **idle** `kerry`, walking.
* **resumes on** V's reply or a 6-game-minute timer.
* **branches** a warm answer gives K6.close.04. A blunt answer gives K6.close.05.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.close.04 | Kerry (copy) | gap:K6.g4:resume (warm) | That's the nicest thing anyone's said to me in a year. Don't tell anyone. | happy | kerry |
| K6.close.05 | Kerry (copy) | gap:K6.g4:resume (blunt) | Honest. Good. That's why I trust you. | nod | kerry |
| K6.close.06 | Kerry (copy) | ending:walk-away | You gave me a reason to stop looking. That's a gift. | sad | kerry |
| K6.close.07 | Kerry (copy) | ending:not-found | It's gone. Fine. I needed to know. Thanks. | sad | kerry |

Additional beats and barks:

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| K6.stage.leads.02 | Kerry (phone) | place:repair:arrived | Repair shop. Ask for the old stock. The stuff nobody claimed. | neutral | - |
| K6.stage.leads.03 | Kerry (phone) | place:stall:arrived | A stall in Kabuki. Ask about carved wood. | neutral | - |
| K6.stage.underpass.03 | Kerry (copy) | stage:underpass:enter | He's not good. He's a kid with a cheap guitar. It's perfect. | sad | kerry |
| K6.bark.buy | Kerry (copy) | choice:buy | Whatever he asks. Pay it. | emphatic | kerry |

---

## River Ward

### RW1. The Case of the Real Celery (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| RW1.open.01 | River (text) | start | Need a second pair of eyes. It's a case. Don't laugh. | neutral | text |
| RW1.open.02 | River | place:diner:arrived | Okay. The case. Somebody in this city grows celery. I want to shake his hand. | emphatic | river |
| RW1.open.03 | River | stage:leads:enter | One rule. Never ask what they know. Ask what they saw. | nod | river |
| RW1.open.04 | River | gap:RW1.g1:ask | Where would you hide a real tomato in this town? Think like the grower. | question | river |
| RW1.bark.lead.a | River | lead:done | Write that down. The small details are the case. | nod | river |
| RW1.bark.lead.b | River | lead:done | Dead end. Dead ends are information too. | shrug | river |
| RW1.bark.found.a | River | place:grower:arrived | That is a greenhouse. A real one. Don't look excited, he'll double the price. | surprise | river |
| RW1.bark.found.b | River | place:grower:arrived | Okay. Okay! Breathe. Pretend we're buying a lamp. | happy | river |
| RW1.s3.01 | River | stage:grower:enter | How much would you pay for an onion you couldn't get anywhere else? | question | river |
| RW1.bark.haggle.a | River | choice:haggle | Good. Wear him down. Politely. | nod | river |
| RW1.bark.haggle.b | River | choice:river-pays | Fine, I'll pay. Say nothing. | shrug | river |
| RW1.close.01 | River | ending:found | Case closed. Sunday, Randy gets his bowl. | happy | river |
| RW1.close.02 | River | ending:store-bought | We tried. Randy will never know. That's the real secret ingredient. | shrug | river |
| RW1.close.03 | River (text) | ending:no-case | Went alone. Found the stall. You missed it. | neutral | text |

Gap RW1.g1 after RW1.open.04. **Asks:** "Where would you hide a real tomato in this town?" **Knows:** the three leads (Heywood cook, Santo Domingo driver, Badlands-edge kid), real vegetables are rare, V's bond, Randy loves his jambalaya. **Secret:** he is a little embarrassed that the case matters more to him than the arrests he made. **Wants:** V to think about the grower, not the tomato. **Idle:** `river`. **Resumes on:** V answers or 40 s. **Branches:** an idea ("somewhere with sunlight, on a roof") shapes his first question to the cook.

Gap RW1.g2 after RW1.s3.01. **Asks:** "How much would you pay for an onion you couldn't get anywhere else?" **Knows:** the grower's price, 400 eddies. **Secret:** he already decided to pay whatever it costs. **Wants:** V to value the thing before haggling. **Idle:** `river`. **Resumes on:** V names a price or starts to haggle. **Branches:** a high number makes him smile and let V pay less than V said.

### RW2. Cold Coffee (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| RW2.open.01 | River (text) | start | Thursday. Northside. Bring a car and patience. I'll bring the coffee. | neutral | text |
| RW2.open.02 | River | place:cart:arrived | Park where you can see the lobby, not where it can see you. | nod | river |
| RW2.open.03 | River | stage:park:enter | Engine off. Lights off. Nobody says anything that matters. | emphatic | chair |
| RW2.open.04 | River | gap:RW2.g1:ask | How long can you sit still before you start talking? Be honest. | question | chair |
| RW2.watch.01 | River | timer:45 | Cold coffee is the tax. Tell me something while we wait. Not about the job. | shrug | chair |
| RW2.bark.lure.a | River | lure:any | Don't. That is what it's for. | no | chair |
| RW2.bark.lure.b | River | lure:any | Let him knock. He's not the point. | shrug | chair |
| RW2.bark.courier.a | River | courier:seen | There. Grey jacket, satchel. Don't point. | emphatic | chair |
| RW2.bark.courier.b | River | courier:seen | She's early. Remember that. | nod | chair |
| RW2.bark.follow.a | River | stage:follow:enter | Stay in the car. I've got her. | nod | chair |
| RW2.bark.follow.b | River | plate:read | Plate. Got it. Say it back to me. | emphatic | river |
| RW2.close.01 | River | ending:noted | A plate. That's a name by Friday. Thanks for sitting. | happy | river |
| RW2.close.02 | River | ending:grabbed | You went in loud. I'd have waited too long. Thanks for that. | nod | river |
| RW2.close.03 | River (text) | ending:blown | You left. That's fine. I'll come next Thursday. | shrug | text |

Gap RW2.g1 after RW2.open.04. **Asks:** "How long can you sit still before you start talking?" **Knows:** the stakeout rules (no leaving, no engine, no honking), the ring's scheme. **Secret:** he came because he cannot sit still anywhere else. **Wants:** an honest number. **Idle:** `chair`. **Resumes on:** V answers or 30 s. **Branches:** a high number earns "liar", a low one earns "good, then I do the talking".

Gap RW2.g2 after RW2.watch.01. **Asks:** "Tell me something while we wait. Do you have anyone who waits for you?" **Knows:** the 90-minute clock, V's relationships. **Secret:** the guilt about Joss. **Wants:** a real answer to fill the silence, not chatter. **Idle:** `chair`. **Resumes on:** V answers or 60 s. **Branches:** if V mentions someone, he asks one follow-up and files it for later.

### RW3. Open Window (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| RW3.open.01 | River | place:street:arrived | Flat's on the third floor. The fire escape is rusted but honest. | nod | river |
| RW3.open.02 | River | stage:plan:enter | I'll hold the super. I'm very good at weather. You go in. | shrug | river |
| RW3.open.03 | River | stage:plan:enter | Three things only. The list, the phones, the calendar. | emphatic | river |
| RW3.open.04 | River | gap:RW3.g1:ask | Can you go in and take nothing but what I asked? | question | river |
| RW3.bark.super.a | River (remote) | timer:300 | Five minutes. He's asking about my badge. | fear | voice |
| RW3.bark.super.b | River (remote) | timer:420 | He's looking at the stairs. Out. Now. | fear | voice |
| RW3.bark.clue.a | River (remote) | clue:found | Good. Next. | nod | voice |
| RW3.bark.clue.b | River (remote) | clue:found | Leave it as you found it. | emphatic | voice |
| RW3.bark.spot.a | River (remote) | alert | Window. Go. | emphatic | voice |
| RW3.bark.spot.b | River (remote) | alert | Out! I'll hold the door. | fear | voice |
| RW3.out.01 | River | stage:out:enter | Sit with me a minute. Do you ever read a list and find your own name? | question | chair |
| RW3.close.01 | River | ending:all-three | That's the list. Han will want to see this. | nod | chair |
| RW3.close.02 | River | ending:two-clues | Not complete. Enough to start. | shrug | chair |
| RW3.close.03 | River | ending:spotted | You got out. That's the job. | nod | chair |

Gap RW3.g1 after RW3.open.04. **Asks:** "Can you go in and take nothing but what I asked?" **Knows:** the three clues, the super's patience (8 game minutes), the lookout. **Secret:** he would take the whole flat if he could. **Wants:** discipline from V. **Idle:** `river`. **Resumes on:** V agrees or refuses. **Branches:** a refusal gets "then we do it at the door" (the `door` tag).

Gap RW3.g2 after RW3.out.01. **Asks:** "Do you ever read a list and find your own name?" **Knows:** the list, one name he cannot forget, V's history with lists. **Secret:** the name is a child's. **Wants:** to not be alone with it. **Idle:** `chair`. **Resumes on:** V answers or 45 s. **Branches:** a warm answer gets a longer silence, a flippant one gets a flat nod.

### RW4. Polite Distance (full: opener call, stage beats, closer, barks, 3 gaps)

`Holocall RW4.call`. Caller River, live picture (a car interior, mirror in the corner), trigger `start`. River hangs up after RW4.open.06. If V hangs up early, he texts the Watson pin and "Think about it."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| RW4.open.01 | River | holocall:RW4.call | V. It's River. Don't turn around if you're outside. | neutral | river |
| RW4.open.02 | River | holocall:RW4.call | Unmarked sedan, two days now. Dark. Too clean to be a cop. | emphatic | river |
| RW4.open.03 | River | holocall:RW4.call | I don't want a shooting. I want to know who's in it. | angry | river |
| RW4.open.04 | River | gap:RW4.g1:ask | You drive, I read the mirror. Can you be a very boring driver? | question | river |
| RW4.open.05 | River | gap:RW4.g1:resume | Watson. I'll send the pin. Don't speed. | nod | river |
| RW4.open.06 | River | holocall:RW4.call | And V. Thanks. For being easy to ask. | happy | river |
| RW4.s2.01 | River | stage:tail:enter | Left side, two cars back. He's too clean to be a cop. | emphatic | chair |
| RW4.s2.02 | River | timer:20 | Never run. Never turn quickly. Make them think you're lost. | nod | chair |
| RW4.s2.03 | River | checkpoint:1 | Good. Normal. Boring. You're a natural. | happy | chair |
| RW4.s2.04 | River | checkpoint:2 | He's still there. He's good. Not that good. | shrug | chair |
| RW4.s2.05 | River | tail:close | He's closing. Slow down. Let him sit on you. | emphatic | chair |
| RW4.s2.06 | River | checkpoint:3 | Tunnel. Brake lights only. Nothing flashy. | emphatic | chair |
| RW4.s2.07 | River | tail:lost | He's gone. Don't celebrate. Turn right. | nod | chair |
| RW4.s2.08 | River | heat:2 | Cops. The one thing worse than him. Ease off. | fear | chair |
| RW4.s3.01 | River | stage:wait:enter | Park here. I'll wait by the door. You stay in the car. | nod | lean |
| RW4.s3.02 | River | gap:RW4.g2:ask | While we wait. Do you ever feel followed when nobody is? | question | lean |
| RW4.s3.03 | River | driver:arrived | Evening. Long drive. Want to tell me who sent you? | neutral | river |
| RW4.s4.01 | River | stage:name:enter | He gave a name I know. I don't like it. | disgust | river |
| RW4.s4.02 | River | stage:name:enter | Jamie Sheen taught me. Let a man think he's winning. | nod | river |
| RW4.bark.drive.a | River | speed:over | Easy. Nobody ever lost a tail by speeding. | no | chair |
| RW4.bark.drive.b | River | speed:over | Gentle on the pedal. We're a couple going home. | shrug | chair |
| RW4.bark.lost.a | River | tail:lost | Two blocks. Take the underpass. | nod | chair |
| RW4.bark.lost.b | River | tail:lost | That's a good turn. He won't read it. | happy | chair |
| RW4.close.01 | River | ending:named | Lost a tail and cornered a man. No shots. A good day. | happy | river |
| RW4.close.02 | River | gap:RW4.g3:ask | When did anyone last worry about you? Honestly. | question | river |
| RW4.close.03 | River | ending:lost-only | Lost him, not found him. A week of mirrors. | shrug | river |
| RW4.close.04 | River | ending:hot | The police noticed before he did. That's a joke. I'm laughing. | surprise | river |
| RW4.close.05 | River | ending:fight | He drew. We handled it. Don't tell Joss. | angry | river |

Gap RW4.g1 after RW4.open.04. **Asks:** "Can you be a very boring driver?" **Knows:** the plan, the route, that police heat ruins it. **Secret:** he suspects who it is. **Wants:** V to commit. **Idle:** `river` (on the call). **Resumes on:** V agrees (`in`) or declines (`no`, the call ends, ending `no-ride`). **Branches:** none beyond the ending.

Gap RW4.g2 after RW4.s3.02. **Asks:** "Do you ever feel followed when nobody is?" **Knows:** V's life, what V said about threats. **Secret:** he has felt followed since the badge. **Wants:** company in the quiet. **Idle:** `lean` (by the stairwell door). **Resumes on:** V answers or the driver arrives. **Branches:** a candid answer earns a rare personal line later.

Gap RW4.g3 after RW4.close.02. **Asks:** "When did anyone last worry about you?" **Knows:** the ending. **Secret:** his answer is "Joss, and that counts." **Wants:** to hear V say a name. **Idle:** `river`. **Resumes on:** V answers or 40 s. **Branches:** a name is remembered, "nobody" gets "that changes".

sfx: ambient city traffic, a muffled engine behind the mirror (pack file).

### RW5. Until the Sun Comes Up (full: opener call, stage beats, closer, barks, 4 gaps)

`Holocall RW5.call`. Caller River, live picture (a dark kitchen, a cold cup), trigger `start`. River hangs up after RW5.open.05. If V hangs up early, he texts the farm pin and "I'll go alone if I have to."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| RW5.open.01 | River | holocall:RW5.call | V. I need you for one night. | neutral | river |
| RW5.open.02 | River | holocall:RW5.call | A witness. Nineteen, scared, ready to talk about the ring. | emphatic | river |
| RW5.open.03 | River | holocall:RW5.call | I promised him a safe place until dawn. I'm bad at promises. | sad | river |
| RW5.open.04 | River | gap:RW5.g1:ask | Can you stay up with me? All night. No guarantees. | question | river |
| RW5.open.05 | River | gap:RW5.g1:resume | Farm outside the city. Pin's coming. Bring ammo, not coffee. | nod | river |
| RW5.s2.01 | River | stage:drive:enter | I was late once. A kid waited at a window. I don't talk about it. | sad | chair |
| RW5.s2.02 | River | place:farm:arrived | That's it. A house, a barn, a lot of dark. | neutral | river |
| RW5.s3.01 | Witness (extra, young male voice) | place:farm:arrived | Is this the place? Is he coming? | fear | generic |
| RW5.s3.02 | River | stage:prep:enter | Cellar. Door shut. Nobody opens it but me. | emphatic | river |
| RW5.s3.03 | River | stage:prep:enter | Door, loft, or yard. Pick one. I'll cover the window. | question | river |
| RW5.s3.04 | River | gap:RW5.g2:ask | Which do you trust more, your aim or your ears? | question | river |
| RW5.h1.01 | River | squad:wave1:spawn | Car on the road. Three. Wait for the lights. | emphatic | river |
| RW5.h1.02 | River | squad:wave1:down | One wave down. Two to go. Eyes front. | nod | river |
| RW5.h1.03 | River | squad:wave2:spawn | On foot, through the field. They're counting on the dark. | emphatic | river |
| RW5.h1.04 | River | hour:05:00 | An hour to dawn. Hold. | nod | river |
| RW5.h1.05 | River | squad:wave3:spawn | Truck. Two heavies. Don't waste ammo on the truck. | angry | river |
| RW5.h1.06 | River | witness:hit | Cellar! Cellar! Get down there! | fear | river |
| RW5.h1.07 | River | timer:dark | Why did I take the first case? Want to hear it? I won't ask twice. | question | river |
| RW5.d.01 | River | hour:06:00 | Sun's up. We held. He's alive. | happy | river |
| RW5.d.02 | River (text) | han:arrived | He's here. | neutral | text |
| RW5.d.03 | River | stage:dawn:enter | Joss says I'm bad at being present. Tonight I was. | sad | lean |
| RW5.d.04 | River | gap:RW5.g4:ask | What does being present look like to you? | question | lean |
| RW5.d.05a | River | variant:partner | That water tower. I think about it more than I should. | happy | lean |
| RW5.d.05b | River | variant:friend | You're family. Don't make it weird. | shrug | lean |
| RW5.bark.down.a | River | squad:any:down | One less. Keep your head down. | emphatic | river |
| RW5.bark.down.b | River | squad:any:down | That's two. Stay with your sector. | nod | river |
| RW5.bark.safe.a | River | witness:safe | He's fine. Still breathing. | nod | river |
| RW5.bark.safe.b | River | witness:safe | Good. Keep the cellar quiet. | emphatic | river |
| RW5.close.01 | River | ending:dawn | We kept it. Thank you. For tonight. | happy | lean |
| RW5.close.02 | River (text) | ending:lost | I'll call. Not today. | sad | text |
| RW5.close.03 | River | ending:left | It's fine. It's fine. | sad | river |

Gap RW5.g1 after RW5.open.04. **Asks:** "Can you stay up with me? All night." **Knows:** the case, the witness, the farm. **Secret:** the promise he broke. **Wants:** V to commit without being talked into it. **Idle:** `river`. **Resumes on:** V agrees (`in`) or declines (`no`, the quest ends). **Branches:** a joke first earns a flat "later".

Gap RW5.g2 after RW5.s3.04. **Asks:** "Which do you trust more, your aim or your ears?" **Knows:** the three positions and their sightlines. **Secret:** he thinks V should take the loft. **Wants:** V to choose from knowledge. **Idle:** `river`. **Resumes on:** V names a position. **Branches:** V's position decides what he warns about during the waves.

Gap RW5.g3 after RW5.h1.07 (in the dark, hour before dawn). **Asks:** "Why did I take the first case? Want to hear it?" **Knows:** nothing of his parents' case beyond the profile. **Secret:** the ghost behind every case, whose name he does not say. **Wants:** to say it quietly to someone who stays. **Idle:** `river`. **Resumes on:** V says yes or no, or 30 s. **Branches:** yes earns three sentences about why a case is never only a case, no earns "fair".

Gap RW5.g4 after RW5.d.04. **Asks:** "What does being present look like to you?" **Knows:** the ending, Joss's complaint. **Secret:** he is afraid he only learns this on nights like this. **Wants:** V's idea of it. **Idle:** `lean`. **Resumes on:** V answers. **Branches:** the answer is used when he talks about Sunday dinner in later chat.

sfx: field crickets, a distant engine, a dawn bird (pack files). music: none.

### RW6. Off the Clock (full: opener text, stage beats, closer, barks, 4 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| RW6.open.01 | River (text) | start | I want one day. No phone. You hold it. If I reach for it, say something unkind. | neutral | text |
| RW6.open.02 | River | stage:phone:enter | Here. Phone. Don't answer it. Don't look at it. Don't tell me who called. | emphatic | river |
| RW6.open.03 | River | stage:phone:enter | I'm bad at this. If I start asking about suspects, kick me. | shrug | river |
| RW6.open.04 | River | gap:RW6.g1:ask | What counts as a day off, for you? | question | river |
| RW6.s3.01 | River | stage:drive:enter | Where we're going has no signal, no cases. Just dust. | happy | chair |
| RW6.s3.02 | River | temptation:1 | That car. Smoke. Don't. No. Okay, a little. Pull over? | question | chair |
| RW6.s3.03 | River | choice:let | Quick. Two minutes. I won't read his plates. | nod | chair |
| RW6.s3.04 | River | choice:hold | Good. Drive. I'm fine. I'm not fine. | shrug | chair |
| RW6.s3.05 | River | temptation:2 | That man on the left. I know that face. Never mind. Never mind. | fear | chair |
| RW6.s3.06 | River | temptation:3 | That's a guy from my old precinct. Keep driving. I mean it. Please. | angry | chair |
| RW6.s4.01 | River | place:tower:arrived | That's it. That's the tower. No suspects in this view. | happy | lean |
| RW6.s4.02 | River | stage:tower:cook | Tomatoes, rice, onions, paprika, thyme, celery, garlic. Stir. Don't let it burn. | neutral | river |
| RW6.s4.03 | River | timer:120 | My secret is nothing special. Patience. And Randy's face when he tastes it. | happy | river |
| RW6.s4.04 | River | gap:RW6.g2:ask | Do you cook for anyone? Or just for the idea of it? | question | river |
| RW6.s4.05 | River | timer:300 | Monique and Dorian fight over the last spoon. Randy eats the pot clean. I miss most of it. | sad | lean |
| RW6.s4.06 | River | gap:RW6.g3:ask | Have you ever worked so hard at something that you forgot who it was for? | question | lean |
| RW6.s4.07a | River | variant:partner | The tower was better. This is close. | happy | lean |
| RW6.s4.07b | River | variant:friend | Sunday. Joss's table. There's always a chair for you. | nod | lean |
| RW6.s5.01 | River (text) | next-morning | Recipe. Don't lose it. | nod | text |
| RW6.s5.02 | River (text) | next-morning | Tell Randy it's secret. | happy | text |
| RW6.s5.03 | River | gap:RW6.g4:ask | One last thing. What do you want the next day off to be like? | question | lean |
| RW6.bark.hold.a | River | choice:hold | Fine. Fine. I'm fine. | shrug | chair |
| RW6.bark.hold.b | River | choice:hold | Good call. I hate that it was a good call. | nod | chair |
| RW6.bark.let.a | River | choice:let | I know. I know. One thing. Then nothing. | shrug | chair |
| RW6.bark.let.b | River | choice:let | Don't say anything. I can hear you not saying it. | emphatic | chair |
| RW6.bark.phone.a | River | reach:phone | Not a word. I can hear you being unkind. | angry | chair |
| RW6.bark.phone.b | River | reach:phone | Is that mine? No. Never mind. | shrug | chair |
| RW6.close.01 | River | ending:whole-day | A whole day. Not one case. I'll deny it under oath. | happy | lean |
| RW6.close.02 | River | ending:slipped | I slipped. Twice. Don't tell Harold. | shrug | lean |
| RW6.close.03 | River | ending:case-day | Three cases in a day. I'm a lost cause. Thanks for the lunch. | happy | lean |
| RW6.close.04 | River (text) | ending:stood-up | Went to the tower alone. The pot was fine. You missed it. | sad | text |

Gap RW6.g1 after RW6.open.04. **Asks:** "What counts as a day off, for you?" **Knows:** the plan (phone handover, drive, the water tower), V's habits. **Secret:** he has not taken one since the badge. **Wants:** to borrow V's definition. **Idle:** `river`. **Resumes on:** V answers or 40 s. **Branches:** V's definition becomes the rule he tries to follow, and he quotes it at the first temptation.

Gap RW6.g2 after RW6.s4.04. **Asks:** "Do you cook for anyone?" **Knows:** the recipe he just said aloud, V's food habits. **Secret:** he cooks mainly to keep Randy talking. **Wants:** V to try the idea. **Idle:** `river`. **Resumes on:** V answers. **Branches:** "no" earns a gentle dare to cook for someone this week (a `history` line), "yes" earns a question about who.

Gap RW6.g3 after RW6.s4.06. **Asks:** "Have you ever worked so hard at something you forgot who it was for?" **Knows:** the water tower, the meal, his parents' case in outline only (no invented details). **Secret:** that is his entire life so far. **Wants:** V's honest answer. **Idle:** `lean`. **Resumes on:** V answers or 60 s. **Branches:** a candid answer leads to the open-chair line.

Gap RW6.g4 after RW6.s5.03. **Asks:** "What do you want the next day off to be like?" **Knows:** the ending count of `hold` and `let`. **Secret:** he already wrote the next one in his head. **Wants:** to plan something with V. **Idle:** `lean`. **Resumes on:** V answers. **Branches:** the answer seeds the next free-time hangout invitation.

music: none from the pack, V's own radio if V turns it on. sfx: wind and a distant truck at the tower, a camp stove hiss (pack file).

---

## Goro Takemura

### T1. Honest Food (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| T1.open.01 | Takemura (text) | start | I require a meal. An honest one. You will decide where one may be found. | neutral | text |
| T1.open.02 | Takemura | place:market:arrived | You are punctual. A virtue. Choosing the place will test others. | nod | takemura |
| T1.open.03 | Takemura | stage:choose:enter | Watch the knife hand. A cook who respects the blade respects the rice. | emphatic | takemura |
| T1.open.04 | Takemura | gap:T1.g1:ask | Which of these three do you trust? Do not tell me the cleanest. | question | takemura |
| T1.taste.01 | Takemura | stage:tasting:enter | I will rate each dish in a low voice. Tell me if I am too loud. | question | bar |
| T1.bark.counter.a | Takemura | counter:entered | Hm. | neutral | takemura |
| T1.bark.counter.b | Takemura | counter:entered | The broth is honest. The man is nervous. | nod | takemura |
| T1.bark.dish.a | Takemura | dish:served | Three. For now. | neutral | bar |
| T1.bark.dish.b | Takemura | dish:served | Two. The second bite was worse than the first. | disgust | bar |
| T1.bark.cook.a | Takemura | cook:offended | Forgive my companion's honesty. And mine. | shrug | bar |
| T1.bark.cook.b | Takemura | cook:offended | I have been rude. I will correct it with a bow. | fear | bar |
| T1.close.01 | Takemura | ending:honest-bowl | You are an acceptable guide. I will return to that counter. | happy | takemura |
| T1.close.02 | Takemura | ending:thrown-out | I bowed to a cook in the street. It was the correct size. | shrug | takemura |
| T1.close.03 | Takemura (text) | ending:no-meal | I ate nothing. The city wins. | sad | text |

Gap T1.g1 after T1.open.04. **Asks:** "Which of these three do you trust? Do not tell me the cleanest." **Knows:** the three counters (ramen, yakitori, a small sushi bar), the cooks' states. **Secret:** he already decided which one he wants. **Wants:** V's judgement rooted in something other than appearance. **Idle:** `takemura`. **Resumes on:** V names a counter or 45 s. **Branches:** V's reasoning shapes his first remark to the cook.

Gap T1.g2 after T1.taste.01. **Asks:** "How do you tell a cook the truth without insulting him?" **Knows:** the dishes, the cook within earshot. **Secret:** his own method is silence and a bow. **Wants:** V to learn restraint. **Idle:** seat `bar`. **Resumes on:** V answers or the cook walks over. **Branches:** a tactful answer helps V smooth (`smooth`), a blunt one sets up `truth`.

### T2. Look Twice (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| T2.open.01 | Takemura | place:square:arrived | Sit. We begin with sitting. You look at one thing. That is a flaw. | emphatic | bodyguard_front |
| T2.open.02 | Takemura | stage:lesson:enter | Five people will cross this square. Remember them. Then you will turn around. | nod | bodyguard_front |
| T2.open.03 | Takemura | stage:lesson:enter | Four questions. I will not tell you which. | no | bodyguard_front |
| T2.open.04 | Takemura | gap:T2.g1:ask | What did you notice first when you arrived? Be precise. | question | bodyguard_front |
| T2.quiz.01 | Takemura | stage:quiz:enter | Who was watching us? | question | bodyguard_front |
| T2.bark.turn.a | Takemura | stage:turn:enter | Do not turn. Turn only when I say. | no | bodyguard_front |
| T2.bark.turn.b | Takemura | stage:turn:enter | Count slowly to a hundred. | nod | bodyguard_front |
| T2.bark.right.a | Takemura | quiz:right | Correct. | nod | bodyguard_front |
| T2.bark.right.b | Takemura | quiz:right | Observant. | happy | bodyguard_front |
| T2.bark.wrong.a | Takemura | quiz:wrong | No. Look again. | no | bodyguard_front |
| T2.bark.wrong.b | Takemura | quiz:wrong | Close. Not close enough. | shrug | bodyguard_front |
| T2.bark.watcher.a | Takemura | stage:watcher:enter | That one. The one who did not wave. | emphatic | bodyguard_front |
| T2.bark.watcher.b | Takemura | stage:watcher:enter | Go. Speak to him. I will cover. | nod | bodyguard_back |
| T2.close.01 | Takemura | ending:sharp | Four of four. I am almost pleased. | happy | bodyguard_front |
| T2.close.02 | Takemura | ending:adequate | Adequate. Return when you can look twice. | nod | bodyguard_front |
| T2.close.03 | Takemura | ending:blind | A beginning. Everyone starts blind. | shrug | bodyguard_front |

Gap T2.g1 after T2.open.04. **Asks:** "What did you notice first when you arrived?" **Knows:** the five extras and their tagged traits. **Secret:** he noticed V's weapon, V's pace and the watcher in the first two seconds. **Wants:** a detail, not a feeling. **Idle:** `bodyguard_front`. **Resumes on:** V answers or 30 s. **Branches:** a precise answer shortens the lesson text, a vague one earns "that is the first lesson".

Gap T2.g2 after T2.quiz.01. **Asks:** "Who was watching us?" **Knows:** which extra was the lookout, the answers V has given so far. **Secret:** none, he wants the truth. **Wants:** V to commit. **Idle:** `bodyguard_front`. **Resumes on:** V names one or the quiz timer. **Branches:** a right pick leads to `watcher`, a wrong one leads to a mild correction.

### T3. Pincers (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| T3.open.01 | Takemura | place:lane:arrived | Good evening. We will walk the lanes. I wish to learn each exit. | nod | takemura |
| T3.open.02 | Takemura | stage:walk:enter | A lane has a front door, a back door, and a third door nobody tells you about. | emphatic | takemura |
| T3.open.03 | Takemura | stage:walk:enter | Repeat each exit after me. Quietly. Walls listen. | nod | takemura |
| T3.open.04 | Takemura | gap:T3.g1:ask | Which exit would you take if I said now? Show me, do not tell me. | question | takemura |
| T3.bark.snatch.a | Takemura | stage:snatch:enter | He took it. Left. The stairs. | angry | takemura |
| T3.bark.snatch.b | Takemura | stage:snatch:enter | My notebook. Do not shout. Cut across. | emphatic | takemura |
| T3.bark.chase.a | Takemura (remote) | chase:turn | He goes to the market. Cut across. | emphatic | voice |
| T3.bark.chase.b | Takemura (remote) | chase:turn | Left. The stairs. Do not shout. | emphatic | voice |
| T3.bark.caught.a | Takemura | chase:caught | Stand still. I am not going to hurt you. | nod | takemura |
| T3.bark.caught.b | Takemura | chase:caught | Good. You found him. | happy | takemura |
| T3.steps.01 | Takemura | stage:steps:enter | Sit. I am not angry. Where are you from? | question | lean |
| T3.close.01 | Takemura | ending:caught-fed | Caught, fed, and lectured. A good evening. | happy | takemura |
| T3.close.02 | Takemura | ending:caught | Return to your lane, boy. Do not come back. | no | takemura |
| T3.close.03 | Takemura | ending:lost | A good guard loses a notebook. A better guard has already memorised it. | shrug | lean |

Gap T3.g1 after T3.open.04. **Asks:** "Which exit would you take if I said now? Show me." **Knows:** the two lanes just walked. **Secret:** the notebook is the one thing he would hate to lose. **Wants:** V to move correctly. **Idle:** `takemura`. **Resumes on:** V moves toward an exit or answers. **Branches:** a right exit earns a nod and one fewer cut-off hint later.

Gap T3.g2 after T3.steps.01. **Asks:** "Where does he sleep tonight? Ask him in your way." **Knows:** the teenager's silence and body language. **Secret:** Chiba-11. **Wants:** V to see the boy as a person. **Idle:** `lean`. **Resumes on:** V speaks (tags `scold`, `fed`, `walk`). **Branches:** the tag shapes whether he pays for the meal himself or lets V pay.

### T4. Word of Honour (full: opener call, stage beats, closer, barks, 3 gaps)

`Holocall T4.call`. Caller Takemura, live picture (a plain wall, a cup of tea). Trigger `start`. He hangs up after T4.open.06. If V hangs up early, he texts "I will wait at the tea shop one hour."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| T4.open.01 | Takemura | holocall:T4.call | V. This is Goro Takemura. I request your time. | neutral | takemura |
| T4.open.02 | Takemura | holocall:T4.call | A man asked for help to leave the city. I gave my word. | emphatic | takemura |
| T4.open.03 | Takemura | holocall:T4.call | He is frightened. I cannot move him and watch the rear. | sad | takemura |
| T4.open.04 | Takemura | gap:T4.g1:ask | Will you be my second? Consider what a word costs before you answer. | question | takemura |
| T4.open.05 | Takemura | gap:T4.g1:resume | The tea shop in Japantown. One hour. Come unarmed to the door. | nod | takemura |
| T4.open.06 | Takemura | holocall:T4.call | Thank you. I do not say it often. | happy | takemura |
| T4.s2.01 | Takemura | place:teashop:arrived | This is V. My second. You may speak freely. | nod | takemura |
| T4.s2.02 | Clerk (extra, corporate-clerk voice) | stage:clerk:enter | I only want to leave. I carry nothing but a suitcase. | fear | generic |
| T4.s2.03 | Takemura | stage:clerk:enter | A man's baggage is his own affair when I have given my word. | nod | takemura |
| T4.s3.01 | Takemura | stage:walk:enter | Slow. Wait. Check twice. Then move. | emphatic | bodyguard_front |
| T4.s3.02 | Takemura | patrol:near | Stop. Counting. Three seconds. Go. | emphatic | bodyguard_front |
| T4.s3.03 | Takemura | place:leg2:arrived | Second leg. He is breathing too fast. Breathe with me. | nod | bodyguard_front |
| T4.s3.04 | Clerk (extra) | clerk:break | I want to go back. I can't. I want to go back. | fear | generic |
| T4.s3.05 | Takemura | clerk:break | You carry a suitcase. Nothing else. Walk. | emphatic | bodyguard_front |
| T4.s3.06 | Takemura | gap:T4.g2:ask | Push, wait, or rest? Decide as a second. | question | bodyguard_front |
| T4.s3.07 | Takemura | patrol:alert | Hold. Do not move. | no | bodyguard_front |
| T4.s4.01 | Captain (extra, dockworker voice) | place:pier:arrived | Fifteen hundred. Up front. A word doesn't float. | angry | generic_arms_crossed |
| T4.s4.02 | Takemura | stage:pier:talk | My word has carried heavier men. | emphatic | bodyguard_front |
| T4.s4.03 | Takemura | stage:pier:talk | Pay him or persuade him, V. I will watch the rear. | nod | bodyguard_back |
| T4.s4.04 | Clerk (extra) | boat:boarding | Thank you. Thank you, Takemura-san. | happy | generic |
| T4.s4.05 | Takemura | stage:after:enter | A word is a door you cannot close behind you. | sad | bodyguard_back |
| T4.s4.06 | Takemura | gap:T4.g3:ask | What is the heaviest promise you have kept? | question | bodyguard_back |
| T4.bark.arrive.a | Takemura | place:any:arrived | Quiet. We are close. | nod | bodyguard_front |
| T4.bark.arrive.b | Takemura | place:any:arrived | Good pace. Do not rush the next corner. | nod | bodyguard_front |
| T4.bark.down.a | Takemura | squad:patrol:down | That was not my method. It will do. | shrug | bodyguard_front |
| T4.bark.down.b | Takemura | squad:patrol:down | They will wake with headaches. Move. | emphatic | bodyguard_front |
| T4.bark.unseen.a | Takemura | unseen:holds | Good. They did not see us. | nod | bodyguard_front |
| T4.bark.unseen.b | Takemura | unseen:holds | Patience. It is the whole art. | emphatic | bodyguard_front |
| T4.close.01 | Takemura | ending:delivered | The boat leaves. He is gone. You were the right second. | happy | bodyguard_back |
| T4.close.02 | Takemura | ending:delivered-fight | He lives. I am in your debt. This costs me. | nod | bodyguard_back |
| T4.close.03 | Takemura | ending:lost-him | He was taken. This is my failure, not yours. Do not argue. | sad | bodyguard_back |

Gap T4.g1 after T4.open.04. **Asks:** "Will you be my second?" **Knows:** the clerk, the route, the pier. **Secret:** he has never asked anyone for a second. **Wants:** a considered answer, not a quick yes. **Idle:** `takemura` (on the call). **Resumes on:** V agrees (`in`) or declines (`no`, the call ends). **Branches:** a quick joke earns "this is not a matter for jokes".

Gap T4.g2 after T4.s3.06. **Asks:** "Push, wait, or rest?" **Knows:** the clerk's breakdown, the patrol's position. **Secret:** he would wait. **Wants:** V's decision as a second. **Idle:** `bodyguard_front`. **Resumes on:** V chooses (tags `push`, `wait`, `rest`). **Branches:** `push` makes the clerk bolt, `wait` and `rest` steady him.

Gap T4.g3 after T4.s4.06. **Asks:** "What is the heaviest promise you have kept?" **Knows:** the ending. **Secret:** his answer is Saburo, and he lost the promise to protect him. **Wants:** to hear V's. **Idle:** `bodyguard_back`. **Resumes on:** V answers or 45 s. **Branches:** a real answer earns his one line about Saburo.

sfx: harbour wind, a boat horn at the pier (game library, verify, or a pack file).

### T5. Choose Your Ground (full: opener call, stage beats, closer, barks, 4 gaps)

`Holocall T5.call`. Caller Takemura, live picture (a dim hideout interior, a lamp being moved). Trigger `start`. He hangs up after T5.open.05. If V hangs up early, he texts the pin and "I will hold it alone if I must."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| T5.open.01 | Takemura | holocall:T5.call | V. My address is known. | neutral | takemura |
| T5.open.02 | Takemura | holocall:T5.call | Freelancers will come tonight. The old bounty still pays, to fools. | emphatic | takemura |
| T5.open.03 | Takemura | holocall:T5.call | I will not move. A position is not abandoned for being inconvenient. | emphatic | takemura |
| T5.open.04 | Takemura | gap:T5.g1:ask | I would be honoured if you stood with me. Will you? | question | takemura |
| T5.open.05 | Takemura | gap:T5.g1:resume | Come within forty minutes. I will teach you ground. | nod | takemura |
| T5.s2.01 | Takemura | stage:ground:enter | Three positions. The door, the stair window, the roof edge. Each has a price. | emphatic | bodyguard_front |
| T5.s2.02 | Takemura | stage:ground:enter | The door sees everything and is seen. The window sees little and is safe. | nod | bodyguard_front |
| T5.s2.03 | Takemura | stage:ground:enter | The roof sees most and is alone. | nod | bodyguard_front |
| T5.s2.04 | Takemura | gap:T5.g2:ask | Where would you stand? Choose. I will not argue. I will adapt. | question | bodyguard_front |
| T5.w1.01 | Takemura | squad:wave1:spawn | Four, at the door. Let them come. | nod | bodyguard_front |
| T5.w1.02 | Takemura | squad:wave1:down | Breathe, then move. | emphatic | bodyguard_front |
| T5.w1.03 | Takemura | squad:wave2:spawn | A rifle on the opposite roof. Shadows, V. | fear | bodyguard_front |
| T5.w1.04 | Negotiator (extra, fixer voice) | negotiator:arrived | Hear me out. Five thousand. You walk. He pays for his own mistakes. | neutral | generic_hips |
| T5.w1.05 | Takemura | negotiator:arrived | You will leave now, politely. I count to three. Politely. | angry | bodyguard_front |
| T5.w1.06 | Takemura | gap:T5.g3:ask | Do you listen to him? A man who listens is not a traitor. | question | bodyguard_front |
| T5.w1.07 | Takemura | choice:refuse | Thank you. | nod | bodyguard_front |
| T5.w1.08 | Takemura | choice:take | That was your decision. | sad | bodyguard_back |
| T5.w1.09 | Takemura | squad:wave3:spawn | Two heavies from behind. The back is mine. | emphatic | bodyguard_front |
| T5.q.01 | Takemura | stage:quiet:enter | Tea. I have only one cup. We will share it. | nod | bar |
| T5.q.02 | Takemura | stage:quiet:enter | I did not choose this ground out of pride. It is a post, V. | emphatic | bar |
| T5.q.03 | Takemura | stage:quiet:enter | Take this key. The door opens for you at any hour. | happy | bar |
| T5.q.04 | Takemura | gap:T5.g4:ask | What do you see when you hold a position all night? | question | bar |
| T5.bark.down.a | Takemura | squad:any:down | One fewer. Hold your sector. | emphatic | bodyguard_front |
| T5.bark.down.b | Takemura | squad:any:down | Good. They are learning to hurry. | shrug | bodyguard_front |
| T5.bark.hurt.a | Takemura | v:hurt | Down. Under the window. | fear | bodyguard_front |
| T5.bark.hurt.b | Takemura | v:hurt | Breathe. Count to three. Then fire. | emphatic | bodyguard_front |
| T5.close.01 | Takemura | ending:held-refuse | We held. And you refused the money in front of me. I will not forget it. | happy | bar |
| T5.close.02 | Takemura | ending:held-listen | You listened. Fair. You also stayed. | nod | bar |
| T5.close.03 | Takemura | ending:take | That was your decision. | sad | bodyguard_back |
| T5.close.04 | Takemura (text) | ending:abandoned | I understand. | sad | text |

Gap T5.g1 after T5.open.04. **Asks:** "I would be honoured if you stood with me. Will you?" **Knows:** the bounty, the hideout, the plan. **Secret:** he expects V to decline and has already accepted it. **Wants:** a considered answer. **Idle:** `takemura`. **Resumes on:** V agrees (`in`) or declines (`no`, the call ends). **Branches:** an enthusiastic yes earns a long, serious pause.

Gap T5.g2 after T5.s2.04. **Asks:** "Where would you stand? Choose." **Knows:** the three positions and their sightlines. **Secret:** he wants V on the window. **Wants:** V's judgement. **Idle:** `bodyguard_front`. **Resumes on:** V names a position. **Branches:** he adapts his own post to V's choice and says why.

Gap T5.g3 after T5.w1.06 (during the parley). **Asks:** "Do you listen to him?" **Knows:** the negotiator's offer, 5,000 eddies. **Secret:** he will respect either answer. **Wants:** V to decide by themself. **Idle:** `bodyguard_front`. **Resumes on:** V chooses `refuse`, `listen` or `take`. **Branches:** the tag selects the ending (+80, +70 or -40).

Gap T5.g4 after T5.q.04. **Asks:** "What do you see when you hold a position all night?" **Knows:** the ending. **Secret:** he sees Saburo's door. **Wants:** V's answer, then his own. **Idle:** seat `bar`. **Resumes on:** V answers or 45 s. **Branches:** a real answer gets one sentence about Saburo and the door.

sfx: rain on tin, a window latch, a distant shot (pack files).

### T6. A Name for the Plaque (full: opener text, stage beats, closer, barks, 4 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| T6.open.01 | Takemura (text) | start | I would like a witness. Not a guard. | neutral | text |
| T6.open.02 | Takemura | place:gate:arrived | You came. The path is short. The reason is not. | nod | takemura |
| T6.open.03 | Takemura | stage:path:enter | Walk beside me. Not behind. I guard no one tonight. | emphatic | takemura |
| T6.open.04 | Takemura | gap:T6.g1:ask | Before we begin. Why did I ask you and not a priest? | question | takemura |
| T6.p.01 | Takemura | place:foxes:arrived | My grandmother said the fox at the gate decides who may pass. He is deciding about you. | happy | takemura |
| T6.p.02 | Takemura | place:bridge:arrived | The canal in Chiba smelled of chemicals. A kappa would have complained. | shrug | takemura |
| T6.p.03 | Takemura | place:wall:arrived | A cat that was not a cat. I do not believe it. I do not look at it directly either. | shrug | takemura |
| T6.r.01 | Takemura | place:basin:arrived | Water first. Left hand, right hand. Mouth, if you must. | nod | takemura |
| T6.r.02 | Takemura | place:incense:arrived | A little smoke. A little smoke is respect. | nod | takemura |
| T6.r.03 | Takemura | place:table:arrived | Saburo Arasaka. The lord I served. I could not save him. | sad | takemura |
| T6.r.04 | Takemura | stage:rites:plaque2 | For the boys of Chiba-11. Those who were not chosen. | sad | takemura |
| T6.r.05 | Takemura | gap:T6.g2:ask | A name for your plaque, if you have one. If not, I leave it blank. | question | takemura |
| T6.r.06 | Takemura | choice:name | I will remember it with you. | nod | takemura |
| T6.r.07 | Takemura | choice:none | Blank. Until you are ready. | nod | takemura |
| T6.s.01 | Takemura | stage:sit:enter | Sit. It is permitted to be quiet. | nod | lean |
| T6.s.02 | Takemura | timer:60 | The picking. Clean children only. I was clean. | sad | lean |
| T6.s.03 | Takemura | gap:T6.g3:ask | Does it trouble you that someone else's luck is why you live? | question | lean |
| T6.s.04 | Takemura | cat:appears | Do not look at it. | fear | lean |
| T6.c.01 | Takemura | stage:charm:enter | A small charm. It protects against nothing. I bought it anyway. | happy | takemura |
| T6.c.02a | Takemura | variant:partner | I am still in mourning. I would like it to be shorter, with you near. | sad | takemura |
| T6.c.02b | Takemura | variant:friend | Thank you for being my witness. | nod | takemura |
| T6.c.03 | Takemura | gap:T6.g4:ask | How do you want to be remembered? | question | takemura |
| T6.bark.arrive.a | Takemura | place:any:arrived | Slowly. The path is old. | nod | takemura |
| T6.bark.arrive.b | Takemura | place:any:arrived | Quiet. We are guests. | nod | takemura |
| T6.bark.bow.a | Takemura | gesture:bow | The angle matters. Lower. There. | nod | takemura |
| T6.bark.bow.b | Takemura | gesture:bow | Good. You have a straight back. | happy | takemura |
| T6.close.01 | Takemura | ending:witnessed-name | You stayed. You named. You are a witness now. It cannot be undone. | nod | lean |
| T6.close.02 | Takemura | ending:witnessed-none | A blank plaque is also a statement. | nod | lean |
| T6.close.03 | Takemura | ending:left | You left early. I understand. | sad | lean |
| T6.close.04 | Takemura (text) | ending:no-witness | No witness. I hung them alone. | sad | text |

Gap T6.g1 after T6.open.04. **Asks:** "Why did I ask you and not a priest?" **Knows:** the shrine, the plaques, V's bond. **Secret:** he asked because V is the one person who does not ask him to explain. **Wants:** V's guess. **Idle:** `takemura`. **Resumes on:** V answers or 40 s. **Branches:** a warm guess earns "close", a cynical one earns "also true".

Gap T6.g2 after T6.r.05. **Asks:** "A name for your plaque, if you have one." **Knows:** V's relationships and losses in the save. **Secret:** he has been rehearsing the question. **Wants:** V to name someone or choose not to. **Idle:** `takemura`. **Resumes on:** V names someone (`name`) or declines (`none`). **Branches:** the name goes into `history` and he asks after it later.

Gap T6.g3 after T6.s.03. **Asks:** "Does it trouble you that someone else's luck is why you live?" **Knows:** V's survival story. **Secret:** it troubles him every day. **Wants:** an honest answer. **Idle:** `lean`. **Resumes on:** V answers. **Branches:** "yes" earns recognition, "no" earns "then you are lighter than I".

Gap T6.g4 after T6.c.03. **Asks:** "How do you want to be remembered?" **Knows:** the ending. **Secret:** he would rather not be. **Wants:** V's answer to carry. **Idle:** `takemura`. **Resumes on:** V answers or 40 s. **Branches:** a humble answer earns a bow.

music: a quiet traditional flute loop at the shrine, fading out at the sit stage (a pack file or the game's Japantown ambience, verify). sfx: wind chimes, incense crackle, a distant temple bell (verify).

---

## Songbird

### S1. Ordinary Thursday (light: opener, closer, barks, 2 gaps)

`Holocall S1.call`. Caller Songbird, voice-only, trigger dusk game time. She stays on the line through the walk as [ear]. She hangs up after S1.close.01. If V hangs up early she sends S1.close.02 as a text.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| S1.open.01 | Songbird [call] | holocall:S1.call | Hey. Are you somewhere you can hear me properly? | neutral | voice |
| S1.open.02 | Songbird [call] | holocall:S1.call | Could we talk about something that doesn't have an extraction plan? Just for a minute. | sad | voice |
| S1.open.03 | Songbird [call] | gap:S1.g1:ask | Is there a street near you with old stoops? Steps, a fire escape? | question | voice |
| S1.bark.stoop.a | Songbird [ear] | place:stoop:arrived | Stop there. Tell me what's on it. | nod | voice |
| S1.bark.stoop.b | Songbird [ear] | place:stoop:arrived | I can almost hear it. Say more. | happy | voice |
| S1.bark.song.a | Songbird [ear] | radio:song | Turn it up. A little. There. | happy | voice |
| S1.bark.song.b | Songbird [ear] | radio:song | Not that. Something with bass. | no | voice |
| S1.sit.01 | Songbird [ear] | stage:stoop:enter | What do you hear? Not what you see. What you hear. | question | voice |
| S1.close.01 | Songbird [call] | ending:thursday | Thank you. That is the best Thursday I've had in a while. | happy | voice |
| S1.close.02 | Songbird [text] | ending:cut-short | It's fine. Go. I'll still be here. | neutral | text |
| S1.close.03 | Songbird [text] | ending:thursday+3min | Thursday. | neutral | text |

Gap S1.g1 after S1.open.03. **Asks:** "Is there a street near you with old stoops?" **Knows:** V's district, the Brooklyn memory fragments, her state. **Secret:** she is lonely in a way she cannot say yet. **Wants:** V to go to such a street and be there. **Idle:** V's own idle (she has no body). **Resumes on:** V names a place or says it will head there. **Branches:** the named street seeds the first `place` pick.

Gap S1.g2 after S1.sit.01. **Asks:** "What do you hear? Not what you see." **Knows:** the street ambience, the song if one is playing. **Secret:** she loses a word mid-sentence and hides it. **Wants:** sound, not description. **Idle:** V's idle. **Resumes on:** V answers or 45 s. **Branches:** a vivid answer earns a Brooklyn fragment in return (the scopdog seller, the bonfire smoke).

music: if V picked a song with a bass line, the pack lets it play under her lines and fades it out at S1.close.01. sfx: none beyond the street.

### S2. The Locker (light: opener, closer, barks, 2 gaps)

`Holocall S2.call`. Caller Songbird, voice-only, trigger `start`. She stays as [ear] through the stealth. If V hangs up early she texts the locker number.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| S2.open.01 | Songbird [call] | holocall:S2.call | Hi. I need a favour. A stupid one. | shrug | voice |
| S2.open.02 | Songbird [call] | holocall:S2.call | There's a locker on a roof near the Black Sapphire. Number nine. I think. | neutral | voice |
| S2.open.03 | Songbird [call] | holocall:S2.call | Patrols were two on the east side, one on the stair. That was seven weeks ago. | emphatic | voice |
| S2.open.04 | Songbird [call] | gap:S2.g1:ask | Do you trust a seven-week-old plan? Say no. It's the right answer. | question | voice |
| S2.bark.count.a | Songbird [ear] | patrol:count | The third one turns at the count of twenty. | emphatic | voice |
| S2.bark.count.b | Songbird [ear] | patrol:count | Two on the left. Wait. Wait. Now. | emphatic | voice |
| S2.bark.new.a | Songbird [ear] | patrol:new-post | That's new. I don't have that. Go slow. | fear | voice |
| S2.bark.new.b | Songbird [ear] | patrol:new-post | Sorry. My information is stale. Stay low. | sad | voice |
| S2.bark.locker.a | Songbird [ear] | place:locker:arrived | That's it. Don't open it until you're clear. | nod | voice |
| S2.bark.breath.a | Songbird [ear] | timer:breath | Give me a few seconds. | sad | voice |
| S2.listen.01 | Songbird [ear] | stage:listen:enter | Read me the first track. Just the name. | question | voice |
| S2.close.01 | Songbird [ear] | ending:quiet | You got it. You didn't have to. I won't say it twice. | happy | voice |
| S2.close.02 | Songbird [ear] | ending:noisy | I'm sorry about the intel. Next time I'll check twice. | sad | voice |
| S2.close.03 | Songbird [text] | ending:empty-handed | You turned back. That was the right call. | nod | text |

Gap S2.g1 after S2.open.04. **Asks:** "Do you trust a seven-week-old plan?" **Knows:** the stash, the roof, the stale patrol numbers. **Secret:** she hopes V will not realise how much the player matters to her. **Wants:** V to proceed without false confidence. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** "no" earns a short laugh and the plan, "yes" earns a warning.

Gap S2.g2 after S2.listen.01. **Asks:** "Read me the first track. Just the name." **Knows:** the tracks on the player and the feeling of each. **Secret:** the first track is the one she played the night before the oath. **Wants:** to hear it said by someone else. **Idle:** V's idle (in the car). **Resumes on:** V reads it. **Branches:** whatever V reads, she tells the feeling of the track, never the real title.

sfx: a roof wind, a locker latch.

### S3. Return to Sender (light: opener, closer, barks, 2 gaps)

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| S3.open.01 | Songbird [text] | start | I wrote something for Alex. I can't send it. Will you carry it? | sad | text |
| S3.open.02 | Songbird [text] | start+1min | Don't read it. If you know, I'll hear you knowing it. | neutral | text |
| S3.open.03 | Songbird [ear] | place:moth:arrived | She's behind the bar. Tell her it's from a friend. Nothing else yet. | nod | voice |
| S3.open.04 | Songbird [ear] | gap:S3.g1:ask | Do you think she'll want to hear it? Tell me honestly. | question | voice |
| S3.bark.deliver.a | Songbird [ear] | stage:deliver:enter | I'm here. I'm not saying anything. | fear | voice |
| S3.bark.deliver.b | Songbird [ear] | stage:deliver:enter | Say it as written. Don't improve it. | emphatic | voice |
| S3.bark.wait.a | Songbird [ear] | timer:wait | Take your time. Order something. | nod | voice |
| S3.report.01 | Songbird [ear] | stage:report:enter | Tell me exactly what she said. Don't improve it. | question | voice |
| S3.close.01 | Songbird [ear] | ending:as-written | Thank you. I don't know what I wanted. This was it. | sad | voice |
| S3.close.02 | Songbird [ear] | ending:softened | What did you change? ...Okay. Okay. | surprise | voice |
| S3.close.03 | Songbird [ear] | ending:withheld | I understand. Keep it. For now. | sad | voice |

Gap S3.g1 after S3.open.04. **Asks:** "Do you think she'll want to hear it?" **Knows:** the shard, the Moth, the hour (after 2 AM). **Secret:** she wants to be forgiven and does not want to be forgiven for something she is not sorry for. **Wants:** V's honest guess. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** a hopeful answer lowers her fear a notch, a doubtful one makes her ask what V would change.

Gap S3.g2 after S3.report.01. **Asks:** "Tell me exactly what she said." **Knows:** V's tag (`as-written`, `softened`, `withheld`). **Secret:** she has rehearsed three possible replies. **Wants:** the exact words. **Idle:** V's idle. **Resumes on:** V recounts. **Branches:** the retelling is the turn note, she reacts to V's phrasing, not the game dialogue.

### S4. Left at the Burned Billboard (full: opener call, stage beats, closer, barks, 3 gaps)

`Holocall S4.call`. Caller Songbird, voice-only, trigger `start`. She stays on the line as [ear] through the drive. If V hangs up early, she texts the first landmark and "Start from the Dogtown edge."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| S4.open.01 | Songbird [call] | holocall:S4.call | It's me. Are you driving? Don't. Stop first. | neutral | voice |
| S4.open.02 | Songbird [call] | holocall:S4.call | I want to see a place again. I don't remember where it is. | sad | voice |
| S4.open.03 | Songbird [call] | holocall:S4.call | A burned billboard on the left. A tunnel with a broken light. After that, my memory is a mess. | emphatic | voice |
| S4.open.04 | Songbird [call] | gap:S4.g1:ask | Will you help me find it with no map, only my bad directions? | question | voice |
| S4.open.05 | Songbird [call] | gap:S4.g1:resume | Start at the edge of Dogtown. I'll talk. You drive. | nod | voice |
| S4.d.01 | Songbird [ear] | checkpoint:1 | Left at the burned billboard. A tyre ad. Black and orange. | emphatic | voice |
| S4.d.02 | Songbird [ear] | wrong-turn | No, that's wrong. Tell me what's on your right. | question | voice |
| S4.d.03 | Songbird [ear] | hint:1 | There was a gas station. One pump worked. The rest rusted. | neutral | voice |
| S4.d.04 | Songbird [ear] | checkpoint:2 | The tunnel. The light flickers. I always held my breath. Silly. | happy | voice |
| S4.d.05 | Songbird [ear] | memory-gap | Sorry. I lost the word. Gone. Give me a few seconds. | fear | voice |
| S4.d.06 | Songbird [ear] | checkpoint:4 | The sign was crushed. I remember green, and crushed. | neutral | voice |
| S4.d.07 | Songbird [ear] | gap:S4.g2:ask | What colour is the sky right now? Tell me properly. | question | voice |
| S4.v.01 | Songbird [ear] | place:overlook:arrived | Stop. That's it. That's the place. | surprise | voice |
| S4.v.02 | Songbird [ear] | timer:60 | I sat here with a wrapper and a radio. I don't remember the song. | sad | voice |
| S4.v.03 | Songbird [ear] | gap:S4.g3:ask | What does it look like from there? Everything. | question | voice |
| S4.v.04 | Songbird [text] | stage:photo:enter | Same view. Different year. | neutral | text |
| S4.bark.check.a | Songbird [ear] | checkpoint:any | Good. Next one is a tunnel. | nod | voice |
| S4.bark.check.b | Songbird [ear] | checkpoint:any | That's right. I think. Keep going. | shrug | voice |
| S4.bark.wrong.a | Songbird [ear] | wrong-turn | Back out. Slowly. I'll find it. | no | voice |
| S4.bark.wrong.b | Songbird [ear] | wrong-turn | My fault. Let me think. | sad | voice |
| S4.bark.hint.a | Songbird [ear] | hint:any | Look for the colour red. Somewhere. | nod | voice |
| S4.bark.hint.b | Songbird [ear] | hint:any | It was near water, maybe. Or a dry bed. | shrug | voice |
| S4.close.01 | Songbird [ear] | ending:found | You found it. Without a pin. Almost without me. | happy | voice |
| S4.close.02 | Songbird [ear] | ending:found-nohint | No hints. You really listened. | happy | voice |
| S4.close.03 | Songbird [ear] | ending:lost | I was remembering a different city. So I did live there. | sad | voice |
| S4.close.04 | Songbird [text] | ending:no | Another day. | neutral | text |

Gap S4.g1 after S4.open.04. **Asks:** "Will you help me find it with no map?" **Knows:** the five unmarked checkpoints, the 30-minute limit, her damaged memory. **Secret:** it is the one place she remembers loving. **Wants:** patience, not accuracy. **Idle:** V's idle. **Resumes on:** V agrees (`in`) or declines (`no`). **Branches:** none beyond the ending.

Gap S4.g2 after S4.d.07. **Asks:** "What colour is the sky right now?" **Knows:** V's weather and hour (`check`). **Secret:** she mistakes colours since the damage. **Wants:** a clear description. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** a detailed answer earns a memory fragment (the sky she remembers).

Gap S4.g3 after S4.v.03. **Asks:** "What does it look like from there? Everything." **Knows:** the overlook, the skyline. **Secret:** she remembers the view as warmer than it is. **Wants:** V's eyes. **Idle:** V's idle, standing at the overpass. **Resumes on:** V answers or 60 s. **Branches:** the answer is stored as `history` ("the overlook").

music: V's own car radio keeps playing at the overlook, low. When a song starts, S4.v.02 triggers one beat later, and she reacts to the title if it is a song event (verify). sfx: freeway wind.

### S5. The Mirror (full: opener call, stage beats, closer, barks, 3 gaps)

`Holocall S5.call`. Caller Songbird, voice-only, trigger `start`. She stays on as [ear] until the shielded container, where the `dead-zone` silences her. If V hangs up early, she texts the stack and "I'll be here."

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| S5.open.01 | Songbird [call] | holocall:S5.call | V. I need to tell you something. Please don't say anything for ten seconds. | neutral | voice |
| S5.open.02 | Songbird [call] | holocall:S5.call | There's a runner in the Longshore Stacks. Nineteen. Held by a crew that sells runners. | angry | voice |
| S5.open.03 | Songbird [call] | holocall:S5.call | I can listen. I can't reach him. You can. | sad | voice |
| S5.open.04 | Songbird [call] | holocall:S5.call | It isn't a favour. It's the first thing I've asked that isn't about me. | emphatic | voice |
| S5.open.05 | Songbird [call] | gap:S5.g1:ask | Will you go? I'm asking, not telling. I've done enough telling. | question | voice |
| S5.open.06 | Songbird [call] | gap:S5.g1:resume | Stay on the line. I'll be your eyes as far as I can. | nod | voice |
| S5.s2.01 | Songbird [ear] | stage:scout:enter | Crane lookout, east. Don't go under it. | emphatic | voice |
| S5.s2.02 | Songbird [ear] | patrol:count | Two in the lane. Count to twenty. Now. | emphatic | voice |
| S5.s2.03 | Songbird [ear] | place:last-container:near | That container. The last one. The one with no light. | nod | voice |
| S5.s3.01 | Songbird [ear] | dead-zone:enter | I'll be right here. | fear | voice |
| S5.s3.02 | Songbird [ear] | dead-zone:exit | I know. I know. Tell me he's alive. | fear | voice |
| S5.s3.03 | Boy (extra, young male voice) | hostage:reached | Who are you? Are you from her? | fear | generic |
| S5.s3.04 | Songbird [ear, to the boy] | hostage:freed | Hello. I'm a friend. You're not alone. You're leaving. | nod | voice |
| S5.s3.05 | Songbird [ear, to the boy] | hostage:freed | Look at V's hands. Walk when they walk. | emphatic | voice |
| S5.s3.06 | Songbird [ear] | stage:rescue:talk | I used to be in a chair like that. Not that chair. Not that room. | sad | voice |
| S5.s3.07 | Songbird [ear] | gap:S5.g2:ask | What would you have wanted someone to say to you? | question | voice |
| S5.s4.01 | Songbird [ear] | stage:out:enter | Car's behind the crane. Left. Left. Go. | emphatic | voice |
| S5.s4.02 | Songbird [ear] | squad:chase | Two behind you. Keep going. I'll hold the road. | fear | voice |
| S5.s4.03 | Songbird [ear] | stage:out:ride | Drop him at the address. She doesn't ask questions. That's her gift. | nod | voice |
| S5.s5.01 | Songbird [ear] | stage:after:enter | You went where I couldn't. That's the whole job. | sad | voice |
| S5.s5.02 | Songbird [ear] | gap:S5.g3:ask | Do you think he'll be all right? Be honest. | question | voice |
| S5.bark.unseen.a | Songbird [ear] | unseen:holds | Good. They didn't see you. | nod | voice |
| S5.bark.unseen.b | Songbird [ear] | unseen:holds | Slow is fast. Keep it slow. | emphatic | voice |
| S5.bark.down.a | Songbird [ear] | squad:any:down | That's the noise gone. Check your back. | nod | voice |
| S5.bark.down.b | Songbird [ear] | squad:any:down | Quiet again. Go. | nod | voice |
| S5.bark.freed.a | Songbird [ear] | hostage:freed | Is he moving? Good. Keep him with you. | emphatic | voice |
| S5.bark.freed.b | Songbird [ear] | hostage:freed | Breathe. He's breathing. Go. | fear | voice |
| S5.close.01 | Songbird [ear] | ending:saved | Thank you. I'll say it plainly. Thank you. | happy | voice |
| S5.close.02 | Songbird [ear] | ending:saved-loud | Are you hurt? Answer first, then speak. | fear | voice |
| S5.close.03 | Songbird [text] | ending:too-late | I need quiet. I'll call. | sad | text |
| S5.close.04 | Songbird [text] | ending:abandoned | I understand. | sad | text |

Gap S5.g1 after S5.open.05. **Asks:** "Will you go?" **Knows:** the Stacks, the squad, the boy, the dead zone. **Secret:** she cannot guarantee anything. **Wants:** a yes that costs V something and does not feel like an order. **Idle:** V's idle. **Resumes on:** V agrees (`in`) or declines (`no`). **Branches:** a hesitation earns "I know. I'd hesitate too".

Gap S5.g2 after S5.s3.07 (in the car or on foot with the boy). **Asks:** "What would you have wanted someone to say to you?" **Knows:** the boy's state, what she said to him. **Secret:** nobody said anything to her, and she remembers it. **Wants:** an answer to give the boy. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** V's answer is the next line she speaks to the boy.

Gap S5.g3 after S5.s5.02. **Asks:** "Do you think he'll be all right?" **Knows:** the ending. **Secret:** she fears she will be on the other end of the next call. **Wants:** honesty. **Idle:** V's idle. **Resumes on:** V answers or 45 s. **Branches:** a hopeful answer helps, a cautious one is thanked.

sfx: radio static drops away at the `dead-zone` and returns on exit (pack file). The boy's breathing at the rescue.

### S6. Same Sky (full: opener call, stage beats, closer, barks, 4 gaps)

`Holocall S6.call`. Caller Songbird, voice-only, trigger `start` (night). She stays as [ear] to the roof. If V hangs up early, she texts "Another night. I'm sorry." and the call is offered again in 3 game days.

| id | speaker | trigger | line | emotion | animation |
|---|---|---|---|---|---|
| S6.open.01 | Songbird [call] | holocall:S6.call | It's late where I am. I think it's late where you are too. | neutral | voice |
| S6.open.02 | Songbird [call] | holocall:S6.call | I haven't called in eleven days. I'm sorry. I practised this, and I forgot it. | sad | voice |
| S6.open.03 | Songbird [call] | holocall:S6.call | Could you go somewhere high, and look at the sky? You don't have to say anything. | question | voice |
| S6.open.04 | Songbird [call] | gap:S6.g1:ask | Where's the highest place near you that's quiet? | question | voice |
| S6.open.05 | Songbird [call] | gap:S6.g1:resume | Go there. I'll wait. I'm good at waiting. | nod | voice |
| S6.c.01 | Songbird [ear] | timer:climb | Take the stairs. I like the stairs. They give you time. | neutral | voice |
| S6.c.02 | Songbird [ear] | place:roof:arrived | Stop. Look up. Tell me what you can see. | question | voice |
| S6.s.01 | Songbird [ear] | stage:sky:enter | Whatever you say now is the past by the time it gets here. | neutral | voice |
| S6.s.02 | Songbird [ear] | stage:sky:enter | I like that it still counts. | happy | voice |
| S6.s.03 | Songbird [ear] | weather:cloud | Cloud. I can wait. I'm good at it. | nod | voice |
| S6.s.04 | Songbird [ear] | timer:900 | I owe you the truth. I used you. The Relic. What it cost you. | sad | voice |
| S6.s.05 | Songbird [ear] | timer:960 | I can't promise I won't ask again. I can promise I'll tell you first. | emphatic | voice |
| S6.s.06 | Songbird [ear] | gap:S6.g2:ask | Do you want me to keep calling? Knowing all that? | question | voice |
| S6.a.01 | Songbird [ear] | choice:stay | Okay. Not for jobs. I promise. | happy | voice |
| S6.a.02 | Songbird [ear] | choice:free | Thank you. For letting me stop. I won't, but thank you. | sad | voice |
| S6.a.03 | Songbird [ear] | choice:ask | Far. The call is older than it sounds. That's all I'll say. | neutral | voice |
| S6.a.04 | Songbird [ear] | choice:quiet | You don't have to answer. | nod | voice |
| S6.a.05a | Songbird [ear] | variant:partner | I want you. I don't know what that means from here. It's true. | sad | voice |
| S6.a.05b | Songbird [ear] | variant:friend | You're the only person who ever called me back. | happy | voice |
| S6.a.06 | Songbird [ear] | stage:send:enter | I named a plant. A small thing. My choice. | happy | voice |
| S6.a.07 | Songbird [ear] | gap:S6.g3:ask | What do you want, V? Not for me. For you. | question | voice |
| S6.a.08 | Songbird [text] | stage:send:image | Same sky. | neutral | text |
| S6.bark.arrive.a | Songbird [ear] | place:roof:arrived | Good. Higher than I thought. | happy | voice |
| S6.bark.arrive.b | Songbird [ear] | place:roof:arrived | Wind? I can almost hear it. | neutral | voice |
| S6.bark.cloud.a | Songbird [ear] | weather:cloud | Not tonight. We have time. | shrug | voice |
| S6.bark.cloud.b | Songbird [ear] | weather:cloud | Tell me what the cloud looks like instead. | question | voice |
| S6.close.01 | Songbird [ear] | ending:kept | Same sky. Same time next week. If you want. | happy | voice |
| S6.close.02 | Songbird [text] | ending:free | I'll call in two days. Not for anything. | neutral | text |
| S6.close.03 | Songbird [text] | ending:quiet | Thank you for staying. | sad | text |
| S6.close.04 | Songbird [text] | ending:weather | When the cloud lifts, I'll call. | neutral | text |

Gap S6.g1 after S6.open.04. **Asks:** "Where's the highest place near you that's quiet?" **Knows:** V's districts, the rooftop shared in Phantom Liberty (verify). **Secret:** she wants V to pick the place, not her. **Wants:** an answer she did not choose. **Idle:** V's idle. **Resumes on:** V names a place or heads off. **Branches:** the named place decides the roof `place`.

Gap S6.g2 after S6.s.06. **Asks:** "Do you want me to keep calling?" **Knows:** her confession, V's feelings. **Secret:** she will keep calling either way. **Wants:** V's honest choice. **Idle:** V's idle. **Resumes on:** V chooses (`stay`, `free`, `ask`, `quiet`). **Branches:** each tag has its own line and ending.

Gap S6.g3 after S6.a.07. **Asks:** "What do you want, V? Not for me. For you." **Knows:** the ending and V's choice. **Secret:** she has never asked anyone this. **Wants:** to hear something small. **Idle:** V's idle. **Resumes on:** V answers or 60 s. **Branches:** the answer is stored as `history` and is quoted in later calls.

Gap S6.g4 after S6.a.06 (the plant). **Asks:** "What would you name a plant?" **Knows:** nothing more. **Secret:** she is checking if she is allowed to joke. **Wants:** a smile in the call. **Idle:** V's idle. **Resumes on:** V answers. **Branches:** the plant name returns in her texts.

music: V's own station may play at the roof and fades out at S6.s.04. sfx: roof wind (pack file).

---
