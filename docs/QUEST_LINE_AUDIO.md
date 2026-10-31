# Story pack lines without prepared audio

Made by `scripts/Check-QuestLineAudio.mjs` on 31 Oct 2026 from the packs in `characters/bond-packs/` of this repository. Nothing was generated: the audio is made on the owner's PC.

**What this list means.** A line is spoken in the game only from its prepared audio (`lines.<id>.audio`, a file under `audio/` inside the pack, see docs/QUEST_PRIMITIVES.md section 4). A spoken line is a `say` row of a stage or an ending, or a `say` step of a scripted call. A `text` row (a Phone Chat message) needs no audio. The 940 lines below are all the spoken lines of the 114 shipped packs, and **none of them has an `audio` entry or a file in this repository**, so every one is listed as missing here. The live test of 31 Oct showed `[QuestLines] ERROR pack=judy-claws-calling line=J4.end.03: the line has no prepared audio file`, which is the same state: the line is shown as a subtitle and a Phone Chat line and is never given to a live voice.

**What to do on the PC that has the audio.** Run the script against the folder of packs that holds the audio, or against any folder of the finished files, and it lists only what is still missing:

```
node scripts/Check-QuestLineAudio.mjs --packs <the packs folder in the Runtime> --audio-dir <folder with <pack id>/audio/<line id>.wav> --out missing.txt
node scripts/Check-QuestLineAudio.mjs --list prepared.txt --strict
```

`--list` takes a JSON `{"<pack id>": ["<line id>"]}` or a text file of `<pack id>/<line id>` rows. A line is also not prepared when its pack line has no `audio` field, even if a file with its name exists: add `"audio": "audio/<line id>.wav"` to the line (bridge/bond-pack-runner.mjs `lineFor` reads that field only).

The check that every spoken line is defined in its pack passes for all 114 packs (`bridge/quest-line-audio.test.mjs`).

## The lines, by pack

### jackie-come-home (13 of 13)

JW3.stage.drive.01 JW3.stage.yard.01 JW3.bark.signed-timer.a JW3.bark.signed-timer.b JW3.bark.freed.a JW3.bark.freed.b JW3.kid.01 JW3.close.01 JW3.close.02 JW3.call.01 JW3.call.02 JW3.call.03 JW3.call.04

### jackie-drink (18 of 18)

JW5.open.01 JW5.open.02 JW5.open.03 JW5.bark.cheer.a JW5.bark.cheer.b JW5.bark.heckle.a JW5.bark.heckle.b JW5.stage.entrance.01 JW5.stage.entrance.02 JW5.stage.entrance.03 JW5.stage.photo.02 JW5.stage.drink.01 JW5.stage.drink.02 JW5.close.01 JW5.close.02 JW5.close.03 JW5.close.04 JW5.close.05

### jackie-sopa-test (7 of 7)

JW1.bark.rate.a JW1.bark.rate.b JW1.stage.call.01 JW1.bark.best.a JW1.bark.best.b JW1.close.01 JW1.close.02

### jackie-sticky-fingers (13 of 13)

JW2.open.01 JW2.open.02 JW2.stage.theft.01 JW2.bark.chase.a JW2.bark.chase.b JW2.thief.01 JW2.bark.deadend.a JW2.bark.deadend.b JW2.stage.catch.01 JW2.close.01 JW2.stage.listen.01 JW2.close.02 JW2.close.03

### jackie-the-bottle (18 of 18)

JW6.stage.shop.01 JW6.stage.shop.02 JW6.stage.shop.04 JW6.stage.call.01 JW6.call.half.01 JW6.call.half.02 JW6.call.half.03 JW6.bark.call-end.a JW6.bark.call-end.b JW6.stage.roof.01 JW6.stage.roof.02 JW6.stage.roof.03 JW6.stage.roof.04 JW6.stage.roof.05 JW6.close.01 JW6.close.02 JW6.stage.home.01 JW6.close.03

### jackie-wraps (22 of 22)

JW4.open.01 JW4.open.02 JW4.open.03 JW4.open.04 JW4.stage.lift.01 JW4.stage.lift.02 JW4.stage.clinic.01 JW4.stage.clinic.02 JW4.stage.pit.01 JW4.stage.pit.02 JW4.pit.01 JW4.bark.round.a JW4.bark.round.b JW4.bark.win.a JW4.bark.win.b JW4.close.01 JW4.close.02 JW4.bark.lose.a JW4.bark.lose.b JW4.bark.towel.a JW4.bark.towel.b JW4.close.03

### johnny-dial-surf (9 of 9)

SH2.open.01 SH2.open.02 SH2.open.03 SH2.bark.song.a SH2.bark.station.a SH2.stage.quiet.01 SH2.close.01 SH2.close.02 SH2.close.03

### johnny-field-manual (11 of 11)

SH3.open.01 SH3.open.02 SH3.open.03 SH3.open.04 SH3.stage.approach.01 SH3.bark.alert.a SH3.bark.last.a SH3.stage.walkback.01 SH3.close.02 SH3.close.03 SH3.close.01

### johnny-licensed (15 of 15)

SH4.open.01 SH4.open.02 SH4.open.03 SH4.open.04 SH4.stage.tail.01 SH4.stage.tail.02 SH4.stage.tail.03 SH4.stage.tail.04 SH4.bark.close.a SH4.stage.office.01 SH4.stage.office.02 SH4.stage.office.03 SH4.close.01 SH4.close.04 SH4.close.03

### johnny-soundcheck (22 of 22)

SH6.open.01 SH6.open.02 SH6.open.03 SH6.open.04 SH6.stage.venue.01 SH6.stage.venue.02 SH6.stage.check.01 SH6.stage.check.02 SH6.stage.check.03 SH6.stage.check.04 SH6.stage.wheel.01 SH6.stage.wheel.02 SH6.stage.wheel.03 SH6.stage.wheel.04 SH6.stage.wheel.05 SH6.stage.wheel.06 SH6.stage.out.01 SH6.stage.out.02 SH6.close.01 SH6.close.02 SH6.close.03 SH6.close.04

### johnny-street-poll (12 of 12)

SH1.open.01 SH1.open.02 SH1.open.03 SH1.open.04 SH1.open.05 SH1.bark.answer.a SH1.bark.answer.b SH1.bark.third.a SH1.bark.third.b SH1.close.01 SH1.close.02 SH1.open.06

### johnny-the-count (18 of 18)

SH5.open.01 SH5.open.02 SH5.open.03 SH5.open.04 SH5.stage.walk.01 SH5.stage.walk.02 SH5.stage.walk.04 SH5.stage.walk.03 SH5.bark.silence.a SH5.stage.elder.01 SH5.bark.elder.b SH5.stage.count.01 SH5.stage.count.02 SH5.close.01 SH5.close.02 SH5.close.03 SH5.close.04 SH5.close.05

### judy-claws-calling (16 of 16)

J4.hold.01 J4.hold.03 J4.hold.04 J4.hold.06 J4.hold.08 J4.hold.09 J4.after.01 J4.after.02 J4.after.03 J4.after.04 J4.end.02 J4.end.03 J4.call.01 J4.call.02 J4.call.03 J4.call.04

### judy-door-duty (10 of 10)

J2.shift.01 J2.shift.02 J2.shift.03 J2.shift.04 J2.shift.05 J2.shift.06 J2.shift.07 J2.shift.08 J2.close.01 J2.close.02

### judy-grandpa-recording (18 of 18)

J6.gift.02 J6.gift.03 J6.gift.04 J6.gift.05 J6.bd.07 J6.drive.01 J6.drive.02 J6.drive.03 J6.frame.01 J6.frame.02 J6.frame.03 J6.frame.04 J6.frame.05 J6.stay.01 J6.stay.02 J6.end.01 J6.frame.06 J6.end.02

### judy-hangout-repair-night (1 of 1)

JH5.invite.01

### judy-hangout-roach-race (1 of 1)

JH1.invite.01

### judy-hangout-skates-lake (1 of 1)

JH4.invite.01

### judy-hangout-sound-hunt (1 of 1)

JH3.invite.01

### judy-hangout-spot-the-cut (1 of 1)

JH2.invite.01

### judy-no-more-dolls (20 of 20)

J5.found.01 J5.found.02 J5.found.04 J5.found.05 J5.in.01 J5.in.04 J5.in.05 J5.chair.01 J5.chair.02 J5.chair.03 J5.chair.04 J5.out.01 J5.out.02 J5.out.03 J5.after.01 J5.after.02 J5.after.03 J5.after.04 J5.end.02 J5.end.03

### judy-spare-parts (5 of 5)

J1.stalls.01 J1.stalls.02 J1.stalls.03 J1.haggle.01 J1.hand.01

### judy-stolen-signal (15 of 15)

J3.chase.01 J3.chase.02 J3.bark.01 J3.chase.03 J3.chase.04 J3.buyer.01 J3.burn.01 J3.burn.02 J3.burn.03 J3.burn.04 J3.end.01 J3.call.01 J3.call.02 J3.call.03 J3.call.04

### kerry-bootleg (15 of 15)

K4.stage.ride.01 K4.stage.museum.01 K4.stage.museum.02 K4.bark.sneak.a K4.bark.sneak.b K4.bark.loud.a K4.bark.loud.b K4.bark.down.a K4.bark.down.b K4.bark.freed.a K4.bark.freed.b K4.call.01 K4.call.02 K4.call.03 K4.call.04

### kerry-caliente (5 of 5)

K1.stage.ride.01 K1.stage.corner.01 K1.stage.corner.02 K1.bark.order.a K1.bark.order.b

### kerry-first-string (12 of 12)

K6.open.01 K6.open.02 K6.open.03 K6.stage.underpass.02 K6.stage.underpass.01 K6.bark.buy K6.close.02 K6.close.01 K6.stage.walk.01 K6.close.04 K6.close.05 K6.close.03

### kerry-guinevere-race (8 of 8)

K3.open.01 K3.open.02 K3.open.03 K3.stage.start.01 K3.bark.won.b K3.bark.won.a K3.bark.void.a K3.bark.void.b

### kerry-incognito (8 of 8)

K2.open.01 K2.open.02 K2.bark.fan.a K2.bark.fan.b K2.bark.safe.a K2.bark.safe.b K2.bark.phone.a K2.bark.phone.b

### kerry-tomorrow-tokyo (15 of 15)

K5.open.01 K5.open.02 K5.open.03 K5.stage.deck.02 K5.stage.deck.01 K5.stage.deck.03 K5.stage.call.01 K5.stage.call.02 K5.bark.eavesdrop.a K5.stage.after.03 K5.stage.after.02 K5.close.01 K5.close.02 K5.stage.water.01 K5.stage.water.03

### panam-convoy-home (25 of 25)

P5.ask.01 P5.ask.02 P5.ask.03 P5.ask.04 P5.ask.05 P5.pickup.01 P5.pickup.02 P5.run.01 P5.run.02 P5.run.03 P5.run.04 P5.run.05 P5.run.06 P5.bark.01 P5.run.07 P5.run.08 P5.run.09 P5.bark.03 P5.bark.06 P5.camp.01 P5.camp.03 P5.camp.04 P5.camp.02 P5.camp.05 P5.camp.06

### panam-driving-school (11 of 11)

P3.dare.01 P3.dare.02 P3.run.01 P3.run.02a P3.run.03 P3.run.04 P3.run.05 P3.run.06 P3.her.01 P3.grade.02 P3.grade.03

### panam-nowhere-partner (25 of 25)

P6.drive.01 P6.drive.02 P6.drive.03 P6.drive.04 P6.drive.05 P6.drive.06 P6.drive.07 P6.drive.08 P6.drive.09 P6.drive.10 P6.bark.01 P6.bark.04 P6.bark.06 P6.dawn.01 P6.dawn.02 P6.dawn.03 P6.keep.01 P6.keep.02 P6.keep.03 P6.keep.05 P6.end.01 P6.end.02 P6.call.01 P6.call.02 P6.call.03

### panam-nowhere (24 of 24)

P6.drive.01 P6.drive.02 P6.drive.03 P6.drive.04 P6.drive.05 P6.drive.06 P6.drive.07 P6.drive.08 P6.drive.09 P6.drive.10 P6.bark.01 P6.bark.04 P6.bark.06 P6.dawn.01 P6.dawn.02 P6.dawn.03 P6.keep.01 P6.keep.02 P6.keep.04 P6.end.01 P6.end.02 P6.call.01 P6.call.02 P6.call.03

### panam-relay-ghost (23 of 23)

P4.brief.01 P4.brief.02 P4.brief.03 P4.brief.04 P4.approach.01 P4.plant.01 P4.plant.02 P4.plant.03 P4.plant.05 P4.bark.01a P4.bark.03 P4.plant.04 P4.exfil.01 P4.exfil.04 P4.exfil.02 P4.exfil.03 P4.end.01 P4.end.02 P4.call.01 P4.call.02 P4.call.03 P4.call.04 P4.call.05

### panam-sunset-coffee (6 of 6)

P1.walk.01 P1.walk.02 P1.walk.03 P1.sit.01 P1.sit.02 P1.left.01

### panam-wraith-toll (15 of 15)

P2.post.01 P2.post.02 P2.toll.01 P2.toll.02 P2.toll.03 P2.toll.04a P2.toll.05 P2.debrief.01 P2.debrief.02 P2.toll.04b P2.ran.01 P2.call.01 P2.call.02 P2.call.03 P2.call.04

### river-cold-coffee (12 of 12)

RW2.open.02 RW2.open.03 RW2.open.04 RW2.watch.01 RW2.bark.lure.a RW2.bark.lure.b RW2.bark.courier.a RW2.bark.courier.b RW2.bark.follow.a RW2.bark.follow.b RW2.close.01 RW2.close.02

### river-off-the-clock (21 of 21)

RW6.open.02 RW6.open.03 RW6.open.04 RW6.s3.01 RW6.s3.02 RW6.s3.04 RW6.bark.hold.a RW6.s3.05 RW6.s3.03 RW6.bark.let.a RW6.bark.hold.b RW6.s3.06 RW6.bark.let.b RW6.s4.01 RW6.s4.02 RW6.s4.03 RW6.s4.04 RW6.s4.05 RW6.s4.06 RW6.close.01 RW6.close.02

### river-open-window (14 of 14)

RW3.open.02 RW3.open.03 RW3.open.04 RW3.open.01 RW3.bark.super.a RW3.bark.super.b RW3.bark.clue.a RW3.bark.spot.a RW3.bark.spot.b RW3.bark.clue.b RW3.out.01 RW3.close.01 RW3.close.02 RW3.close.03

### river-polite-distance (25 of 25)

RW4.s2.01 RW4.s2.02 RW4.s2.03 RW4.s2.04 RW4.s2.06 RW4.s2.05 RW4.s2.07 RW4.bark.lost.a RW4.bark.lost.b RW4.s2.08 RW4.s3.01 RW4.s3.02 RW4.s3.03 RW4.s4.01 RW4.s4.02 RW4.close.01 RW4.close.03 RW4.close.04 RW4.close.05 RW4.open.01 RW4.open.02 RW4.open.03 RW4.open.04 RW4.open.05 RW4.open.06

### river-real-celery (12 of 12)

RW1.open.02 RW1.open.03 RW1.open.04 RW1.bark.lead.a RW1.bark.lead.b RW1.bark.found.a RW1.bark.found.b RW1.s3.01 RW1.bark.haggle.a RW1.bark.haggle.b RW1.close.01 RW1.close.02

### river-until-dawn (22 of 22)

RW5.s2.01 RW5.s2.02 RW5.s3.02 RW5.s3.03 RW5.s3.04 RW5.h1.01 RW5.h1.03 RW5.h1.05 RW5.h1.04 RW5.h1.06 RW5.bark.down.a RW5.h1.07 RW5.d.01 RW5.d.03 RW5.d.04 RW5.close.01 RW5.close.03 RW5.open.01 RW5.open.02 RW5.open.03 RW5.open.04 RW5.open.05

### rogue-four-questions (11 of 11)

R3.open.01 R3.open.02 R3.open.03 R3.open.04 R3.stage.recon.01 R3.stage.recon.02 R3.stage.recon.03 R3.acc.01 R3.bark.seen.a R3.close.02 R3.close.03

### rogue-hiring-day (9 of 9)

R2.open.01 R2.open.02 R2.open.03 R2.stage.interview.01 R2.stage.interview.02 R2.stage.interview.03 R2.stage.choice.01 R2.close.01 R2.close.02

### rogue-never-said (20 of 20)

R6.open.01 R6.open.02 R6.open.03 R6.stage.spin.01 R6.stage.spin.02 R6.stage.spin.03 R6.stage.spin.04 R6.stage.reply.01 R6.stage.reply.02 R6.stage.reply.03 R6.bark.fold.a R6.bark.fold.b R6.stage.spin.05 R6.stage.spin.06 R6.close.01 R6.close.02 R6.stage.walkout.01 R6.close.03 R6.close.04 R6.close.05

### rogue-say-left (13 of 13)

R4.open.01 R4.open.02 R4.open.03 R4.stage.route.01 R4.stage.route.02 R4.stage.route.04b R4.stage.route.04 R4.stage.route.05 R4.stage.rail.01 R4.stage.rail.02 R4.close.01 R4.close.02 R4.close.03

### rogue-terms (8 of 8)

R1.open.01 R1.open.02 R1.open.03 R1.open.04 R1.open.05 R1.bark.arrive.a R1.merc.01 R1.close.01

### rogue-whos-listening (19 of 19)

R5.call.05 R5.stage.lobby.02 R5.stage.corridor.01 R5.bark.waiting.a R5.bark.waiting.b R5.leaker.01 R5.bark.missed.a R5.bark.missed.b R5.bark.down.a R5.bark.down.b R5.bark.caught.a R5.bark.caught.b R5.close.01 R5.close.02 R5.close.03 R5.call.01 R5.call.02 R5.call.03 R5.call.04

### songbird-burned-billboard (15 of 15)

S4.d.01 S4.d.04 S4.d.03 S4.d.06 S4.d.07 S4.v.01 S4.v.02 S4.v.03 S4.close.01 S4.close.03 S4.open.01 S4.open.02 S4.open.03 S4.open.04 S4.open.05

### songbird-hangout-card-count (1 of 1)

SBH2.ask.01

### songbird-hangout-colour-hunt (1 of 1)

SBH4.ask.01

### songbird-hangout-keep-watch (1 of 1)

SBH5.ask.01

### songbird-hangout-shared-radio (1 of 1)

SBH1.ask.01

### songbird-ordinary-thursday (9 of 9)

S1.bark.stoop.a S1.bark.stoop.b S1.bark.song.a S1.bark.song.b S1.sit.01 S1.close.01 S1.open.01 S1.open.02 S1.open.03

### songbird-return-to-sender (9 of 9)

S3.open.03 S3.open.04 S3.bark.wait.a S3.bark.deliver.a S3.bark.deliver.b S3.report.01 S3.close.01 S3.close.02 S3.close.03

### songbird-same-sky (22 of 22)

S6.c.01 S6.bark.arrive.a S6.c.02 S6.s.01 S6.s.02 S6.s.03 S6.bark.cloud.a S6.s.04 S6.s.05 S6.s.06 S6.a.01 S6.a.06 S6.a.07 S6.a.02 S6.a.03 S6.close.01 S6.a.04 S6.open.01 S6.open.02 S6.open.03 S6.open.04 S6.open.05

### songbird-the-locker (11 of 11)

S2.bark.count.a S2.bark.count.b S2.bark.breath.a S2.bark.locker.a S2.listen.01 S2.close.01 S2.close.02 S2.open.01 S2.open.02 S2.open.03 S2.open.04

### songbird-the-mirror (22 of 22)

S5.s2.01 S5.s2.02 S5.s2.03 S5.bark.down.a S5.bark.down.b S5.s3.01 S5.s3.02 S5.s3.06 S5.s3.07 S5.s4.01 S5.s4.02 S5.s4.03 S5.s5.01 S5.s5.02 S5.close.01 S5.close.02 S5.open.01 S5.open.02 S5.open.03 S5.open.04 S5.open.05 S5.open.06

### takemura-choose-your-ground (26 of 26)

T5.s2.01 T5.s2.02 T5.s2.03 T5.s2.04 T5.w1.01 T5.w1.02 T5.w1.03 T5.bark.down.a T5.bark.down.b T5.w1.05 T5.w1.06 T5.w1.07 T5.w1.09 T5.w1.08 T5.q.01 T5.q.02 T5.q.03 T5.q.04 T5.close.01 T5.close.02 T5.close.03 T5.open.01 T5.open.02 T5.open.03 T5.open.04 T5.open.05

### takemura-honest-food (5 of 5)

T1.open.02 T1.open.03 T1.open.04 T1.taste.01 T1.close.02

### takemura-look-twice (13 of 13)

T2.open.01 T2.open.02 T2.open.03 T2.open.04 T2.bark.turn.a T2.bark.turn.b T2.quiz.01 T2.bark.right.a T2.bark.wrong.a T2.bark.watcher.a T2.bark.watcher.b T2.close.02 T2.close.03

### takemura-name-on-plaque (21 of 21)

T6.open.02 T6.open.03 T6.open.04 T6.p.01 T6.p.02 T6.p.03 T6.r.01 T6.r.02 T6.r.03 T6.r.04 T6.r.05 T6.r.06 T6.s.01 T6.s.02 T6.s.03 T6.r.07 T6.c.01 T6.c.03 T6.close.01 T6.close.02 T6.close.03

### takemura-pincers (11 of 11)

T3.open.01 T3.open.02 T3.open.03 T3.open.04 T3.bark.snatch.a T3.bark.snatch.b T3.bark.caught.a T3.bark.caught.b T3.steps.01 T3.close.02 T3.close.03

### takemura-word-of-honour (25 of 25)

T4.s2.01 T4.s2.03 T4.s3.01 T4.bark.arrive.a T4.s3.03 T4.s3.02 T4.s3.07 T4.bark.down.a T4.bark.down.b T4.bark.unseen.a T4.bark.unseen.b T4.s3.05 T4.s3.06 T4.s4.02 T4.s4.03 T4.s4.05 T4.s4.06 T4.close.02 T4.close.03 T4.open.01 T4.open.02 T4.open.03 T4.open.04 T4.open.05 T4.open.06

### viktor-corner (25 of 25)

V6.bark.arrive.a V6.bark.arrive.b V6.s2.01 V6.s2.02 V6.s2.03 V6.s2.04 V6.r1.01 V6.r2.01 V6.r2.04 V6.r3.01 V6.end.01 V6.s4.01 V6.s4.03 V6.s4.04 V6.end.02 V6.s4.05 V6.close.01 V6.close.02 V6.close.03 V6.open.01 V6.open.02 V6.open.03 V6.open.04 V6.open.05 V6.open.06

### viktor-night-calls (11 of 11)

V2.open.02 V2.open.03 V2.open.04 V2.bark.arrive.a V2.bark.leave.a V2.bark.arrive.b V2.bark.leave.b V2.tab.00 V2.tab.01 V2.close.01 V2.close.02

### viktor-off-the-books (23 of 23)

V4.s1.01 V4.s1.02 V4.s1.03 V4.bark.arrive.a V4.bark.arrive.b V4.s2.01 V4.s2.02 V4.s2.03 V4.s2.07 V4.bark.down.a V4.bark.down.b V4.s4.01 V4.close.02 V4.close.01 V4.close.03 V4.close.04 V4.close.05 V4.open.01 V4.open.02 V4.open.03 V4.open.04 V4.open.05 V4.open.06

### viktor-patient-confidentiality (22 of 22)

V5.s2.01 V5.s2.02 V5.s2.03 V5.s2.04 V5.bark.down.a V5.bark.down.b V5.s3.01 V5.s3.02 V5.s3.03 V5.s3.04 V5.s3.05 V5.bark.freed.a V5.bark.freed.b V5.s3.07 V5.s4.01 V5.s4.02 V5.s4.03 V5.close.04 V5.close.01 V5.close.02 V5.close.05 V5.close.06

### viktor-ringside (11 of 11)

V1.open.02 V1.open.03 V1.open.04 V1.bark.bout.a V1.bark.bout.b V1.bark.bet.a V1.bark.bet.b V1.bag.01 V1.bark.bag.a V1.bark.bag.b V1.close.01

### viktor-third-card (10 of 10)

V3.open.01 V3.open.02 V3.open.03 V3.bark.alley.a V3.bark.alley.b V3.bark.reveal.a V3.bark.reveal.b V3.close.01 V3.close.02 V3.close.03
