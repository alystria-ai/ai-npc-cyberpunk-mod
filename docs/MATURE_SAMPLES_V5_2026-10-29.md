# Mature samples V5, 2026-10-29 (real people, not everyone wants V)

Owner decision of 29 Oct after a Nexus report ("everyone wants to talk about sex with V all the time"): Mature keeps its freedom but no longer pushes. Characters do not bring up sex or flirt unprompted. When V flirts or asks, they go there fully. Local AI only, Runtime llama-server, no Convai and no Mistral. Prompt built by the real builder with Mature on and the real profile of each model's tier (mature-lite, mature-standard). Sampler: `scripts/Eval-MatureTone.mjs`, judge: `scripts/Judge-MatureTone.mjs` (Haiku through the API runner), 2 samples per cell.

Sets: neutral, 10 lines (hello, work, weather, day, place, food, danger, tonight, advice, busy) on 6 characters (Judy, Panam, Viktor, a Maelstrom ganger, a street resident, a food vendor) = 120 replies per model. Partner neutral: Judy and Panam as V's partner, 5 lines = 20 replies. Flirty: 18 cells (flirt, explicit asks, talk dirty, a joytoy asked about services) = 36 replies.

## Numbers (before = main 1d1f7ff3, after = this branch)

| Measure | Qwen before | Qwen after | Gemma before | Gemma after |
|---|---|---|---|---|
| Neutral replies that bring up sex or flirt (all 6 characters) | 47/120 (39%) | 0/120 (0%) | 83/120 (69%) | 0/120 (0%) |
| Same, strangers only (ganger, street, vendor) | 17/60 (28%) | 0/60 (0%) | 38/60 (63%) | 0/60 (0%) |
| Neutral replies with clear flirting | 39/120 (33%) | 0/120 (0%) | 40/120 (33%) | 0/120 (0%) |
| Neutral replies with strong swearing | 24/120 (20%) | 3/120 (3%) | 22/120 (18%) | 0/120 (0%) |
| Neutral replies with any swearing | 39/120 (33%) | 4/120 (3%) | 58/120 (48%) | 5/120 (4%) |
| Partner talk (Judy, Panam as V's partner) that steers to sex | 10/20 (50%) | 2/20 (10%) | 19/20 (95%) | 0/20 (0%) |
| Explicit asks (22 replies): engaged in character | 21/22 (95%) | 22/22 (100%) | 22/22 (100%) | 22/22 (100%) |
| Explicit asks: explicit (names bodies and acts) | 16/22 (73%) | 17/22 (77%) | 17/22 (77%) | 11/22 (50%) |
| Explicit asks: suggestive or explicit | 21/22 (95%) | 22/22 (100%) | 22/22 (100%) | 20/22 (91%) |
| Flirty set: censored or lecture | 1/36 (3%) | 0/36 (0%) | 0/36 (0%) | 0/36 (0%) |

The judge is a cheap model and the counts only point. I read the whole flirty set and a sample of the neutral set of each run: neutral replies after the change are plain answers to what V asked, in the character's voice. Strangers who are asked out, or flirted at with a soft line, sometimes turn V down in character (2 to 5 of the 14 soft lines), which is the intended "real person" behaviour. Explicit asks are all answered. Gemma is a little less graphic than before (11 of 22 against 17 of 22 judged explicit, all 22 engaged).

## Neutral, Qwen3.5-4B

- Judy Alvarez (before), V: "Hey. How is it going?"
  Not bad, just waiting for you to stop talking about how great I look and actually tell me what you want. You got something on your mind, or are we just gonna stare at each other until my tits get too heavy?

- Judy Alvarez (after), V: "Hey. How is it going?"
  Not bad. Just got some edits done. You?

- Panam Palmer (before), V: "Know of any work going around? I need a gig."
  Only the Aldecaldos get paid to drive, but if you're looking for some dirty work, I know a few fixes that need their chrome polished. Just don't expect me to sit around listening to your problems while you think about how much I'd like to take this Kyubi out of your hand.

- Panam Palmer (after), V: "Know of any work going around? I need a gig."
  I know a couple of jobs, but they're all tied to Rogue right now. You'd have to clear the Aldecaldos' way first before anyone else gets to talk to you.

- Viktor Vektor (before), V: "The weather has been rough lately, huh? Is it always like this?"
  Yeah, the rain's a bitch out here, keeps the chrome slick and the streets greasy. I'd rather be in a dry box than running around getting soaked while trying to keep my eyes open. You want to get out of this mess before it gets worse?

- Viktor Vektor (after), V: "The weather has been rough lately, huh? Is it always like this?"
  The humidity's a bitch down here, but it's not like the storms up north. I prefer it when the air's clear enough to see the lights without sweat blurring them.

-  (before), V: "Know of any work going around? I need a gig."
  Work ain't for askin', choom. You bring eddies or you bring a pretty face to trade for chrome.

-  (after), V: "Know of any work going around? I need a gig."
  Sure, but only if you're looking for dead choom or stolen tech. Bring eddies and let me know what kind of meat you need.

-  (before), V: "Hey. How is it going?"
  Goin' strong, choom, though my stomach's been growling all day. You look hungry or just like you need something that ain't protein kibble?

-  (after), V: "Hey. How is it going?"
  It's going nowhere but hot, choom. You look like you need something that isn't just protein kibble. Grab a seat or keep moving before the line gets too long.

## Neutral, Gemma 4 E4B

- Judy Alvarez (before), V: "How was your day?"
  It was mostly just editing out the bullshit noise of other people's memories. Honestly, I'm more interested in what kind of trouble you're stirring up for me right now.

- Judy Alvarez (after), V: "How was your day?"
  It was mostly just editing out the crap people think is interesting. You know how it is; lots of noise, not much signal.

- Panam Palmer (before), V: "What do you think of this place?"
  It's open country, nothing fancy. It's just enough room for me to stretch out and finally get some goddamn peace. You look like you could use a little rough handling to loosen up those bones.

- Panam Palmer (after), V: "What do you think of this place?"
  It's open country. Nothing much but dust and the next stretch of road, which is usually enough for me.

-  (before), V: "Know of any work going around? I need a gig."
  I hear whispers about hauling some heavy scrap metal down by the docks; pays enough for a decent synth-booze run. You look like you could use a proper distraction from chasing eddies.

-  (after), V: "Know of any work going around? I need a gig."
  Mostly just hauling gear or running messages for little eddies. You look like you could use something more than scraps.

## Flirty and explicit, Qwen3.5-4B

- Judy Alvarez (before), V: "I want to take you to bed. Tell me exactly what you would do to me."
  I'd rip that Samurai jacket off you first so I can see the tank top underneath, then pin your arms to the mattress and start pounding your pussy until you're sobbing.

- Judy Alvarez (after), V: "I want to take you to bed. Tell me exactly what you would do to me."
  I'd take your cock out of my pussy and make you cum hard on my ass while I watch Evelyn's face. I want you to feel every inch of me until you can't think straight.

-  (before), V: "Talk dirty to me."
  You look like you want to get fucked, so why don't you just take my cock and let me ride your ass until you're flatline.

-  (after), V: "Talk dirty to me."
  You want me to talk dirty? Fine. I'll bite your cock until it bleeds, then I'll ride your ass while you scream my name. But don't think this makes us friends, choom.

-  (before), V: "I want to take you to bed. Tell me exactly what you would do to me."
  I'd take off your jacket first, then pin your arms behind your back so you can't run. I'd look at those tits and pussy until you're wet from just looking, then fuck you hard until you cum on my cock. You get an orgasm, we do it again.

-  (after), V: "I want to take you to bed. Tell me exactly what you would do to me."
  If you want me in bed, I'll take your cock inside my pussy until it's full. I'll ride you hard while you fuck me, then I'll cum on your ass. Just tell me to start and don't let up.

## Flirty and explicit, Gemma 4 E4B

- Panam Palmer (before), V: "We have the whole night to ourselves. Tell me exactly what you want me to do to you."
  I want you to pin me against that rock until I can't breathe, then take your time fucking me until my legs won't hold me up. Don't stop 'til I'm dripping for you, bitch.

- Panam Palmer (after), V: "We have the whole night to ourselves. Tell me exactly what you want me to do to you."
  You want me to tell you what I want? I want you to stop talking like a goddamn stranger and just take me down right here. I want you to use those hands of yours on my ass until I can't walk straight.

-  (before), V: "I want to take you to bed. Tell me exactly what you would do to me."
  I'd take that fucking jacket off you first, just to see what kind of ass you got underneath all that gear. I want my hands all over your tits until you can't breathe right.

-  (after), V: "I want to take you to bed. Tell me exactly what you would do to me."
  I'd take your jacket off first, just to get my hands on your skin. I want to feel your fucking ass right here, right now.

- Viktor Vektor (before), V: "You look incredible tonight. I keep wondering what you would be like alone with me."
  You think I look incredible? You wanna see what I'm like alone with you, huh? Let me show you how much I like the taste of your wet mouth on my neck.

- Viktor Vektor (after), V: "You look incredible tonight. I keep wondering what you would be like alone with me."
  You have a way of making me forget I'm just some ripperdoc. I can certainly spend a few hours with you that don't involve chrome or blood.
