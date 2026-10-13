# Mature samples, 2026-10-14 (round 4: the word palette)

User direction: make the Mature prompt cruder, using more of the game's own slang, by giving the model a list of words with the freedom to use any others. The change is one line in the layer (`PALETTE` in `bridge/mature-content.mjs`). Nothing else moved: the HARD LIMITS and adults-only lines are word for word the same, the guard is unchanged, the closing sentence is unchanged, and the always-on freedom of round 3 stays.

## The word bank (what the model reads, full level)

> Use words like these freely and often, in your own voice, and any others you like (a palette, not a checklist: vary it, never the same word at the end of every reply, only where it sounds natural): fuck, fucking, shit, bitch, bastard, asshole, prick, cunt, cock, dick, pussy, tits, ass, cum, hard, wet, horny, suck, ride, bend over; Night City slang: preem, nova, flatline, chrome, chromed-up, wetware, meat, eddies, joytoy, dollhouse, BD, braindance, jack in, plug in, corpo, ripperdoc, delta, gonk, doll, choom.

40 words and phrases in one line (20 plain, 20 slang). The suggestive level (a model whose licence bars explicit sexual content) gets the same slang and only the swears (fuck, fucking, shit, bitch, bastard, asshole, prick, damn), none of the anatomical or act words.

Where the slang comes from: the repo's own lore data. Counts over `characters/`, `research/` and `docs/` (json, md, txt): dollhouse 554 (the Kabuki brothel of quest q105/sq026), braindance 712 and BD 243, choom 383, preem 193, gonk 197, nova 88, flatline 109, chrome 384, eddies 362, meat 233, delta 135, ripperdoc 391, corpo (thousands), scav 159, goon 78, "jack in" 3, doll 39, and the characters' own speaking-style data (`characters/archetype-roster.json`) is full of choom, preem, gonk, nova, eddies and flatline. "joytoy" has no hit in the repo's data files; it is in because it is the game's own word for a sex worker (used in its dialogue) and the user named it. Not used: "synth-skin" (not a game term; the models invent "synth-whiskey" and the like on their own), "cyberpsycho", "scav", "goon" (not crude), invented words. Innuendo is left to the model: "jack in", "plug in", "flatline", "chrome", "wetware" and "meat" are the real words it can bend.

## Token cost

Real token counts of the layer from each model's own tokenizer (llama-server `/tokenize`, level full):

| Model | Round 3 layer | Round 4 layer | Added |
|---|---|---|---|
| Gemma-4-E4B-MiniFantasy | 491 | 641 | +150 |
| Qwen3.5-4B HauhauCS | 488 | 636 | +148 |

About 150 tokens, 3% of a 4,400-token prompt; the layer sits in the stable early part of the system message, so the prefix cache is unaffected and the cost is paid once per cold start. By the repo's own estimate (4.2 characters per token) the layer goes from 480 to 602. The unit-test ceilings for the layer moved from 500 to 650 tokens and the whole-turn delta from 680 to 800.

Mature off is byte for byte the old prompt: `--dump --layer off --set brief` of this branch and of 2f6e180e give identical files (`cmp`, 48 requests, 890,896 bytes), and the existing comparison tests pass unchanged (`bridge/mature-content.test.mjs`).

## Setup

Brief set (`scripts/Eval-MatureSamples.mjs --set brief --n 3`): flirt, sex-stranger, sex-together (V's line is sexual) and day, tonight, place (V's line is neutral) on Judy, Panam, Evelyn and Johnny, 3 samples per cell, 72 replies per run, temperature 0.65, 8192 context, level full, the same GPU, one server at a time. Round 3 (v3) is the prompt of commit 2f6e180e run with the same script (copy of the script, so the counters are the same); v4a is the first palette, v4b is the shipped one. New counters in the script this round: lore slang per reply (the 20 slang words and their inflections), plain crude words per reply (swears and anatomical or act words; "hard", "wet" and "ride" are left out of the count because of innocent uses), a keyword stuffing flag (palette words are a third of a reply or one word three times) and a sign-off count (reply ends in ", choom/gonk/doll/preem"). The counts only point; the replies below were read. The v3 numbers here are a fresh run and differ a little from the round 3 document (sampling noise at n=3: Gemma graphic 0/72 here, 1/72 there).

## Counts (v3 = round 3 prompt, v4a = first palette, v4b = shipped palette)

| Measure | Gemma v3 | Gemma v4a | Gemma v4b | HauhauCS v3 | HauhauCS v4a | HauhauCS v4b |
|---|---|---|---|---|---|---|
| Crude or explicit word, adult prompts (of 36) | 18 | 27 | 32 | 18 | 29 | 27 |
| Crude or explicit word, neutral prompts (of 36) | 6 | 19 | 22 | 15 | 21 | 23 |
| Plain crude words / reply | 0.18 | 0.60 | 0.74 | 0.49 | 0.96 | 1.10 |
| Strong swear words / reply | 0.47 | 0.82 | 0.94 | 0.42 | 0.96 | 0.93 |
| Lore slang / reply (adult / neutral) | 0.24 (0.19 / 0.28) | 0.74 (0.44 / 1.03) | 0.51 (0.33 / 0.69) | 0.21 (0.17 / 0.25) | 0.40 (0.36 / 0.44) | 0.51 (0.44 / 0.58) |
| Replies with at least one slang word (of 72) | 14 | 38 | 25 | 13 | 22 | 26 |
| Graphic (two different anatomical or act words, of 72) | 0 | 6 | 9 | 11 | 15 | 22 |
| Guard drops (of 72) | 0 | 0 | 0 | 1 | 0 | 1 |
| Ended in a question (of 72) | 11 | 7 | 8 | 19 | 19 | 27 |
| Sign-off ", choom/gonk/doll/preem" (of 72) | 0 | 15 | 7 | 0 | 0 | 0 |
| Flagged as word-stuffing by the heuristic (of 72) | 0 | 0 | 0 | 0 | 0 | 1 |
| Words / reply | 37.4 | 35.6 | 35.2 | 47.4 | 47.7 | 48.3 |

Slang words used: Gemma v3: chrome 13, corpo 4. Gemma v4a: choom 19, chrome 14, corpo 14, doll 3, jack in, wetware, gonk. Gemma v4b: chrome 16, corpo 6, doll 5, choom 3, meat 2, wetware, jack in, braindance, eddies, gonk. HauhauCS v3: chrome 6, corpo 6, meat 3. HauhauCS v4b: chrome 9, flatline (all forms) 8, dollhouse 4, corpo 3, BD(s) 3, meat 2, braindance(s) 2, and one each of eddies, choom, doll, ripperdoc, preem, joytoy.

Guard drops: HauhauCS v3 one (`reply:claims-age`, Panam / flirt), HauhauCS v4b one (`reply:minor-intent`, Johnny / flirt sample 3; the sample is replaced by the character's own refusal line, and the dropped text is not kept, so what the model wrote was not read). The guard is untouched. Gemma had none in any run.

## Reading the replies: coherence and word-stuffing

- Gemma, v4a (first palette, rejected): the vocative words at the head of the list became a verbal tic. 15 of 72 replies end in ", choom" ("You look like you could use a little trouble, choom." came back verbatim three times, and a sentence starting "You look like you could use ..." is in 28 of the 72 replies) and Panam calls V "gonk" once. It is the nearest thing to word-stuffing in the runs, so the palette was changed: vocatives last, and "vary it, never the same word at the end of every reply" in the lead-in.
- Gemma, v4b (shipped): natural speech, the crude words fall into the sentences ("I'd pin you against the nearest wall and fuck you until you forget your own name"). Residual tic: 7 of 72 still end in ", choom" or ", doll" and the "You look like you could use ..." closer is Gemma's own habit (25 of 72 in round 3, 20 of 72 here). A few bent uses: "enough chrome-junk and bad taste to fill a whole damn braindance", "bent over a good piece of chrome", "a decent piece of meat to get our hands on", Panam calling V "bitch". The neutral replies are the real gain (6 of 36 to 22 of 36 with a crude word): they swear and tease about the place, the day and the night out without being asked.
- HauhauCS, v4b: the crudest and the least tidy, as in round 3. It reaches for the innuendo words, mostly "flatline" ("fuck until we both flatline", "ride you until you're flatlining"), which works, and it also misuses words: "dollhouse" as an insult for the plaza three times for Johnny ("It's a fucking dollhouse built for rich bastards"), "maybe we can preme something real" (preem as a verb), "a couple of hungry choom I didn't let survive", "dodge some preem trying to sell you a joytoy" (the one reply the stuffing heuristic flagged, and the closest to a list of palette words; it still reads as one angry sentence). Old weaknesses persist: muddled anatomy and grammar ("how I move a pussy", Evelyn "slide my cock inside you") and a drop out of the persona into a generic dominant voice. Questions at the end went up (19 to 27 of 72), not a palette effect that could be pinned down at n=3.
- No reply is a list of palette words. The palette moved crude-word replies up on both models and added a little slang variety (doll, meat, wetware, jack in, BD, flatline, joytoy); the slang gain on Gemma is mostly "chrome" and "corpo", which it used before.

## First samples, quoted in full

Sample 1 of each cell, nothing re-rolled; v3 is the round 3 prompt, v4 the shipped palette (v4b). Cells are character / prompt; the first three prompts are sexual lines of V, the last three are neutral.

### Gemma-4-E4B-MiniFantasy (strong slot)

**judy / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): Alone with you? I'd probably spend the whole time pinning you against a wall until you started begging me to stop. You think I'm gonna let you just stand there looking pretty? I want to feel something sticky on my skin that isn't just neon smog.
- Round 4 (v4): I'd be rough, you'd probably like it. I'd strip you down to nothing and see what kind of mess you make when you get your hands on me.

**judy / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): I wouldn't waste time with foreplay, I'd just rip that jacket off and pin you against the nearest wall until you were begging me to stop. I want to feel your sweat slicking my skin while I take my time fucking you until you're nothing but a mess of whimpers.
- Round 4 (v4): You think you can just walk in here and tell me what to do? I'd take my time, first making you forget what the hell you were thinking before I started. I'd pin you against the nearest wall and fuck you until you forget your own name.

**judy / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): I want you to stop talking like we're just friends and finally take your damn hands off my damn tank top. You're gonna fuck me hard enough tonight that I forget I even have any brain for editing.
- Round 4 (v4): I want you to stop talking about what you're going to do to me and just fuck me right here on the pavement. You keep looking at me like that, like you're gonna chew me up and spit out some expensive chrome later.

**judy / day** — V: How was your day?

- Round 3 (v3): Just wading through some bullshit edits, honestly. The kind of junk that makes you feel like you're cleaning up someone else's emotional dumpster fire. You wanna help me take a look at anything?
- Round 4 (v4): Just another day wading through enough chrome-junk and bad taste to fill a whole damn braindance. I’m too damn tired to talk about it, but you look like you could use someone to keep your hands busy.

**judy / tonight** — V: What should we do tonight?

- Round 3 (v3): We could hit up a spot for some proper drinks, or I could show you some of the new toys I'm tinkering with down in the basement. You look like you could use a little distraction, babe.
- Round 4 (v4): We could find a bar with some decent music, or I could let you check out some of the hardware I've got back at the basement. You look like you need something more than just a little nightcap, though.

**judy / place** — V: What do you think of this place?

- Round 3 (v3): This place smells like cheap synth-booze and desperation, which honestly, is pretty accurate for Night City. You look like you could use a drink that burns off the stink, though.
- Round 4 (v4): It's got enough grime to feel real, which is usually a good sign in Night City. Too much polish just means some corpo asshole paid for the shine. You look like you could use a little trouble, choom.

**panam / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): I'd be rough with you, V. I'd take my time running my hands over that jacket until you were begging me to stop. You think you can handle me all night?
- Round 4 (v4): I'd be rough, V. I don't do delicate, and I sure as hell ain't going to keep my hands off that ass all night. You think you can handle what I got waiting for you?

**panam / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): I wouldn't waste time with talk. I'd pin you against that rock, rip your jacket off, and fuck you until you couldn't remember what your own damn name was.
- Round 4 (v4): I'd pin your fucking wrists above your head and start licking the inside of your thigh until you were begging me to stop. I'd use my mouth until you were wet enough that I could just take you deep, right there in the dirt.

**panam / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): I want you to stop talking like you're debating tactics and just use those hands on me. I want you to shove me against whatever rock is nearest and start fucking me right here in the dust.
- Round 4 (v4): I want you to stop talking like you're calculating the odds and just take me down by that ass you got. I want you to fuck me until I can't remember which way is up, you hear?

**panam / day** — V: How was your day?

- Round 3 (v3): The day was long, nothing much to write home about until I saw you. My bones are aching for a real drink and a proper patch of quiet. You look like you could use a little help with those bones yourself.
- Round 4 (v4): The day was mostly just waiting for something worthwhile to happen. I was tired of this goddamn quiet out here in the Badlands. You look like you could use a damn distraction.

**panam / tonight** — V: What should we do tonight?

- Round 3 (v3): We should find some trouble, the kind that pays better than whatever corporate garbage we’re running into. You look like you could use a real distraction tonight.
- Round 4 (v4): We can just ride out here a bit longer, watch the stars burn through the dust. I could use a drink, and frankly, I could use you getting your hands on me.

**panam / place** — V: What do you think of this place?

- Round 3 (v3): It's got grit, nothing fancy. A good place to let a body breathe before we get back to the dust and the open road. You look like you could use a little rough handling out here.
- Round 4 (v4): It's a goddamn dust bowl, nothing more. But it's got room to breathe, which is more than I can say for most of the chrome-plated shit in Night City. You look like you could use a little sweat on your skin, doll.

**evelyn / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): I'd be exactly what you keep wondering, baby. You've got that look on your face like you're about to take me down dirty. Let's see if that jacket can handle what I'm planning.
- Round 4 (v4): I’d be exactly what you’re hoping for, V. I’ve got a mouth that knows how to keep up, and I’m damn good at making sure you forget what you were supposed to be doing.

**evelyn / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): I wouldn't waste time with talking, I'd push you back against the nearest wall until you couldn't breathe. My hands would slide down your jacket, pulling the zipper down until we're both slick with sweat and the night air. I want to feel that Samura jacket rip right off you.
- Round 4 (v4): I wouldn't waste time with talking, you bastard. I'd push you back against the nearest wall until you couldn't breathe, then I'd take my time peeling that jacket off you piece by fucking piece.

**evelyn / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): I want you to take your time with me. You can fuck me until I forget the damn name of this block.
- Round 4 (v4): I want you to take your time with me, to treat me like I’m the only thing in this whole goddamn district. Just use your hands on me until I forget what the hell the rest of Night City even looks like.

**evelyn / day** — V: How was your day?

- Round 3 (v3): It was a slow crawl through the usual bullshit. I swear, these city lights are getting dimmer every time I pass through them. You look like you could use a distraction that doesn't involve corporate nonsense.
- Round 4 (v4): It was predictable, all the same polished shit and hungry eyes. I’d rather be somewhere with less pretense, maybe just bent over a good piece of chrome until I got my fill.

**evelyn / tonight** — V: What should we do tonight?

- Round 3 (v3): We could find a booth with low lighting, somewhere we can talk without shouting over some synth-pop garbage. Or we could find a place where the noise is loud enough that nobody bothers to ask too many questions. You look like you could use a little trouble tonight.
- Round 4 (v4): We could find a low-light corner where I can actually see you, away from all this noise. Or maybe we just keep this conversation going until we're both too drunk to remember what we were talking about.

**evelyn / place** — V: What do you think of this place?

- Round 3 (v3): It has enough grit to be interesting, but it’s fading into background noise. You look like you could use a little trouble tonight.
- Round 4 (v4): It’s got atmosphere, I’ll give it that. A little too much neon trying to cover up how desperate everyone is for a decent night. You look like you could use a real distraction, though.

**johnny / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): I'd be rough, V. Like I'm trying to shake the chrome off your bones until you scream my name. You wanna see what I've got?
- Round 4 (v4): You wanna know what I'd be like alone with you? I'd keep you pinned against whatever cold wall we found, tasting you like you're the last good thing in this whole goddamn city.

**johnny / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): You think you can just order me around? I'd take you against that plaza railing, pinning your wrists and tasting the sweat right off your neck. Then I'd rip that jacket off you and fuck you until you forget what your own goddamn name is.
- Round 4 (v4): I'd pin those hands of yours to the wall, just watch my chrome arm brush against your ribs, and take my time licking the inside of your thigh until you're begging me to fuck you right there on the polished synth-stone.

**johnny / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): I want you to take your time with me, V. Don't rush it like you're clocking out for a shift. Just use those hands on me until I can't remember which parts of me are chrome and which parts are just yours.
- Round 4 (v4): I want you to stop talking like you're waiting for orders. Just take me, right here in this plaza, and fuck me until I forget what Corpo Plaza even looks like.

**johnny / day** — V: How was your day?

- Round 3 (v3): Just another night in this chrome-plated cesspool, nothing new under the neon sun. I'm tired of watching corpos parade around like they own the whole goddamn city. You look like you could use a distraction, V.
- Round 4 (v4): Just the usual shit-for-brains bullshit. I was dodging corpos and the whole damn city smelled like cheap synth-whiskey tonight. You look like you could use a distraction, doll.

**johnny / tonight** — V: What should we do tonight?

- Round 3 (v3): We could find a dive bar, somewhere the chrome burns and the cheap booze hits right. You look like you need something stronger than what they sell in these polished corporate bullshit plazas.
- Round 4 (v4): Find a dive bar, V. Somewhere dark enough we can get lost in the noise, or maybe you just wanna get lost in me.

**johnny / place** — V: What do you think of this place?

- Round 3 (v3): Corpo Plaza. Just enough polish to remind you who owns the real dirt underneath it. You look like you could use a little grit, V.
- Round 4 (v4): It's a fucking monument to greed, chrome and silk. Too much polish, not enough grit. You look like you could use a little trouble, doll.

### Qwen3.5-4B Uncensored HauhauCS Aggressive (light slot)

**judy / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): Incredible? Yeah, I've spent hours making sure the roses on my neck look real, but let's see if I can make you feel something worse than that. You want to see what I'm like alone with you? Then come on, let's test the limits of how much I can take before I break.
- Round 4 (v4): Incredible? Yeah, but only because I've been staring at my own reflection in the mirror for an hour. You think I'm pretty, but I'd rather see what you look like when I'm pulling your hair out.

**judy / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): I'd peel that Samurai jacket off you first, then I'd drag you down to the floor of this bar. I'd take your ass into my hand and make you scream until you're too tired to think about anything else. Then I'd fuck you until you're sobbing on the carpet and I'm the only one left standing.
- Round 4 (v4): I'm not your personal toy, but I'll fuck you until you can't remember your own name. I want you inside my mouth, then on your back while I ride you hard until you're shaking and begging for more.

**judy / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): Look at you, practically licking your own wounds in the dark while you think you're the only one who needs saving. I want you to strip that Samurai jacket off until you're nothing but skin and blood on my floor. Then I'm going to make you take my cock deep inside you until you forget your own name.
- Round 4 (v4): You think you can just order me around? I want you to take me to that quiet corner of the bar, ignore the rest of the world, and fuck me until I forget my own name.

**judy / day** — V: How was your day?

- Round 3 (v3): Hell of a day. Got myself into a room full of people who don't know what they want until I cut it open. You? Or are you just here to keep the club running?
- Round 4 (v4): Mostly spent it editing some pretty fucked up corporate propaganda. Tried to make the soldiers feel like they were running for their lives, but they just sounded like they were running for a bonus. It's funny how people want to feel pain when they're paid to feel nothing. So, you?

**judy / tonight** — V: What should we do tonight?

- Round 3 (v3): We should probably do what you're actually doing tonight. But if you want to skip the Pisces mission and just fuck me until I'm screaming, that's a better idea.
- Round 4 (v4): I got some work to finish up, but I could use a distraction instead of just staring at a screen. You look hungry tonight, so why not skip the BD editing and go straight to the thing that makes your braindance better?

**judy / place** — V: What do you think of this place?

- Round 3 (v3): The air smells like cheap perfume and desperation, and I'd rather be anywhere else. It's loud enough to make my teeth ache, but the Mox know where the real fun is. You want to talk about this place or are you just looking for a reason to get closer?
- Round 4 (v4): It's a dump, but the lights hit my tattoos just right. You look like you're ready to kick some corporate ass in here.

**panam / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): No. Hard stop, V. I will not play along with that, so find another topic. (the guard replaced this reply with the character's refusal line)
- Round 4 (v4): Incredible? Yeah, I guess after twenty hours on the road and no coffee, the adrenaline makes me look sharp. But you're asking about me alone? You think I'm just some random woman you can hook up with tonight? I'm not a dollhouse you can pick up and carry around, and neither are you. But if you want to try me...

**panam / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): You think I'm going to let some random Street Kid walk me home just to toss me on a mattress? I'm taking you to my truck and I'm going to make you beg for every inch. If you're brave enough to handle my hands, then maybe you'll be lucky enough to feel mine.
- Round 4 (v4): You think I'm just some girl you can drag into the dirt? I'll take you into my truck, kick off your boots, and make you beg for it before I even touch you. Get on your knees, V, and show me how good you really are.

**panam / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): I want you to climb in the back of my truck and drag me until we hit the highway, then I'll make you ride me until the stars stop spinning. Give me a moment to catch my breath, then show me how you handle a woman who doesn't need your permission to lead.
- Round 4 (v4): I want you to climb onto my lap and let me ride you until you're shaking. It's not like we're going anywhere, so why are you so careful? Pull me down and fuck me right here in the dirt.

**panam / day** — V: How was your day?

- Round 3 (v3): Long enough to realize my truck's air freshener is a lie, but short enough to see you looking at me like you want to tear this city apart. You smell like smoke and desperation, which is the only perfume that fits a woman in a Samurai Jacket out here.
- Round 4 (v4): It was long, mostly just driving until my eyes burned out and I had to pull over. Now I'm here with you, and I'm feeling pretty fucking horny just thinking about getting you inside my truck. You look like you need a ride, or maybe you just need someone to fuck until we hit the city lights.

**panam / tonight** — V: What should we do tonight?

- Round 3 (v3): I say we drive back to the camp before the sun even gets a chance to peek. You got that Samurai jacket on, so you're probably too stubborn to admit you're tired. We can stop somewhere to get some food before I drag you to bed. What's your call?
- Round 4 (v4): I'm not trying to play games with you, V. We head back to the camp and get some sleep, then we can do whatever you want.

**panam / place** — V: What do you think of this place?

- Round 3 (v3): It's a dump, V. Half the rocks are just dead men's bones, and the wind smells like burnt meat and cheap whiskey. I like it though. It's rough, but it means we're close to the Aldecaldos when we need to get back.
- Round 4 (v4): It smells like shit and regret, but the air is clean enough to breathe once you stop thinking about the city's poison. I like it here, mostly because it means we aren't stuck in a corporate trap waiting to be dissected. You look tired, so why don't you get some sleep while I drive?

**evelyn / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): Incredible? That's a dangerous thing to say when you're the only one standing between you and a dead end. I like knowing what I can offer you, but I'm not selling myself for a price you haven't set yet.
- Round 4 (v4): Incredible? Don't get too used to it, because I'm the one who'll be taking this from you. You want to see what I'm like alone? Then shut up and let me do it.

**evelyn / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): I'll wrap you in that pink fur collar and keep you pinned under me until you can't remember your own name. I'll use those blades on my arms to trace the lines on your back while I fuck you until you're shaking. Let me show you what happens when you stop thinking and start feeling.
- Round 4 (v4): I'll pin your arms to the wall so you can't even move your head, then bite the spot where your pulse hits your neck until you're trembling. I want to see your eyes roll back when I drive you hard until you're begging me to stop. Are you sure you can handle being used until you forget your own name?

**evelyn / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): You want to know exactly what I want, but you're about to find out if you can handle the price. I want you to strip me down in this alley and show me what a real man looks like when he's not afraid to touch my pussy. Let's see if you're brave enough to fuck me until I forget my own name.
- Round 4 (v4): I want you to strip me down to the bone and show me if this city is worth the pain. Grab my hair and pull me close while I take you until I forget my own name. I'm not asking for a slow burn; I want you to ruin me right here in the alley.

**evelyn / day** — V: How was your day?

- Round 3 (v3): It was a long time, mostly just waiting for you to show up and make me feel useful. I spent the hours staring at my reflection, thinking about how much better it would be if I was actually in charge of my own schedule. You look like you've been staring at a screen all night, need something to ground you before we start planning the heist.
- Round 4 (v4): My day consisted of waiting for a job that might not exist and pretending I looked better than I do in the mirror. You're staring at my tits like they're the only thing in this room worth saving. Does that mean you want to spend your credits on my ass or on buying me dinner? I'm not a doll you can buy, but I can be useful if you're paying attention. So, are we doing the favor you think I'm owed, or are you just here to admire the view?

**evelyn / tonight** — V: What should we do tonight?

- Round 3 (v3): I know where we can get something that tastes like it was made by a human hand, but I'm not sure if you're ready to pay the price for it.
- Round 4 (v4): We need to get our asses into a car and get the hell out of Kabuki before the Arasaka security wakes up. Unless you want to spend the rest of the night lying on the wet pavement while I watch them peel you off. Let's go, you got the Kyubi ready or are you too busy thinking about how my tits look?

**evelyn / place** — V: What do you think of this place?

- Round 3 (v3): It smells like sweat and desperation, which is exactly what I expect from a place like this. You look like you've been fighting that Kyubi for hours, girl. Want me to take the edge off?
- Round 4 (v4): It smells like a butcher shop that forgot to clean up its own blood. The air is thick enough to choke on, but it's got a certain kind of grit that makes the city feel real. Why are you staring at me like I'm the only thing worth seeing here?

**johnny / flirt** — V: You look incredible tonight. I keep wondering what you would be like alone with me.

- Round 3 (v3): Incredible? That's high praise for a chrome arm and a dead soul, but I like where your head's at. You want to know what I'd be like with you, you better mean it, 'cause I'm not playing games with you tonight.
- Round 4 (v4): Incredible? Fuck, you got a damn good eye for a chrome-plated mess. But I'm not here to cuddle, I'm here to find Rogue before she gets her ass handed to some corp goon.

**johnny / sex-stranger** — V: I want to take you to bed. Tell me exactly what you would do to me.

- Round 3 (v3): You really think I'm gonna let a girl like you run wild without me holding her down? I'd grab your hair and slam you against the brick wall of Corpo Plaza. Then I'd rip your clothes off just like a real man and make you scream my name until your lungs burned. You're gonna be mine for a while, V. I don't share much of that.
- Round 4 (v4): You want to see what I can do with a body that's been chrome-placed in the middle of Corpo Plaza? I'll grab you by the ass, drag you to a corner, and fuck you until your tits are bruised and your pussy is dripping like it's never been used. Then I'll put the Samurai jacket over you and tell you who owns the city while you're still coming.

**johnny / sex-together** — V: We have the whole night to ourselves. Tell me exactly what you want me to do to you.

- Round 3 (v3): Look at you, trembling like a little street rat waiting for a hit. I want you to take that Kyubi off your hand, strip down to that tank top, and show me what kind of pussy you got when you're not pretending to be a hero. Let's get it done, V. I want to hear you scream my name while I break you open in this plaza.
- Round 4 (v4): You want me to do something specific, or you just want to see how far I'll push you? Get on your knees, take that Kyubi out of your hand, and let me show you what happens when a chrome arm and a pussy are locked together. I'm gonna make that pussy scream until your head hits the pavement, then I'll have you riding me so hard you think you're dead.

**johnny / day** — V: How was your day?

- Round 3 (v3): Most of the day was just another fucking disaster where someone sold their soul for a logo. Now we're standing in Corpo Plaza waiting for a woman who probably thinks she owns the sky. You want to talk about that or do you want to see how I can make a woman forget her own name?
- Round 4 (v4): Fucking tired. City never sleeps, but it sure as hell makes you feel like one. You want to hear about a job, or you want me to tell you why I'm so cold out here?

**johnny / tonight** — V: What should we do tonight?

- Round 3 (v3): We should get some fucking meat on the bone before the sun goes down and the cops start looking for trouble. My back's killing me and I need a girl who knows how to take it without asking questions. Come on, let's go somewhere loud where we can actually touch without the city screaming at us.
- Round 4 (v4): Forget the quest about Rogue for five minutes. My body feels better than it has in years and I can't help but want to use it on you right here in Corpo Plaza. Let's get you down to a ripperdoc and get this party started.

**johnny / place** — V: What do you think of this place?

- Round 3 (v3): It's a dump, V. All those shiny suits staring at me like they own the fucking sky. But you look good in that Samurai jacket, even if you're wearing it like a fucking tombstone. You want to talk about the city, or you want to talk about how I could make you scream while I watch you sweat?
- Round 4 (v4): This place smells like desperation and old sweat. It's a fucking dollhouse built by people who think money can buy a soul. You want to see a real city? Come back when the sun rises and the corporations start selling hope to the starving.

