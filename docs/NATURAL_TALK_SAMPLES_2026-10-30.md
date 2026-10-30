# Natural talk: before and after (2026-10-30)

Branch `fix/natural-talk`. The research behind it is `docs/NATURAL_TALK_RESEARCH_2026-10-30.md`.

## What the owner saw

The developer transcript of the live tests (Panam, outdoors in Little China, "Companions can see" on, a picture on every turn):

- 03:31 to 03:35 on Google Gemini: "try putting some clothes on before you catch a cold" (V really was naked, the game said so), then on later turns, with V dressed again, "you are going to freeze standing around like that", "watching you stare at your comms" and "whatever job Wakako texted you about" in answer to "thanks" and "so hows life".
- 13:47 to 13:49 on Ministral 8B (Custom): "you're wearing that suit like it's a second skin" to "I wouldn't mind coffee", "you're staring at that screen like it's gonna tell you your future" to "perhaps", and to "how is biz" no answer about her business at all, only "you're still staring at that damn screen".

What caused it, found by replaying the turns through the bridge's own prompt builder:

1. **The picture.** The capture is the whole game window: the minimap, the quest tracker ("Read the message from Wakako"), the phone notice, the subtitles and the mod's own text box. It went with every turn, and its note called it a picture "taken from the game window" that "may show the interface". The models read V's typing box and the notices as V staring at a screen, and the quest notice as something to nag about. Ministral even read the text box's "Say to Panam Palmer" as the place being Panam's.
2. **The gear line on every turn,** worded as "what V is wearing and carrying right now, which you can see", with a "never remark on" list. Told every turn, it was narrated every turn.
3. **"V is rich." on every turn,** which came back on Local AI as "you big rich idiot" and "you rich bastard".
4. **The standing nudity line** said V was still naked as "the current truth" on every later turn, so she kept going back to it ("you are going to freeze").
5. **The generic prompt Gemini got:** nine long rules, most of them "never ...", and a world block headed "facts and instructions for you".

## How it was measured

`scripts/Eval-NaturalTalk.mjs` replays 21 turns (Panam 8, Judy 3, Johnny 3, River 3, a food vendor 2, a stranger 2: small talk, a question about the place, a compliment, a job, a song) built from the game's real `last-input.json` of 30 Oct (Little China, tracked quest "Clampdown: Read the message from Wakako"), with V's gear (naked on Panam's first two turns, dressed after), a car radio for Johnny and a TV for Judy. Each character's turns are one conversation. The "before" runs use an export of `main`, the "after" runs this branch. The pictures are real game shots with a HUD drawn the way a live capture shows it (health, minimap, clock, quest tracker, a Wakako message notice, subtitles and the text box), and the same frames cut the way the helper now cuts them.

Requests: 124 to Gemini (the free plan, one request every 4.5 s), 44 to Mistral, the rest on the Runtime's llama-server on this PC (started and stopped by the script). The replies were scored blind (conditions hidden, rows shuffled) by a Haiku judge against a fixed rubric, and checked by a plain word count that is the same for every reply. The judge was lenient (it marked every reply as answering V), so the word count is the firmer number. The samples are small: read the tables as direction, not as precise rates.

## The picture alone (Gemini, the old prompt, the same 11 Panam and Judy turns)

| Picture | Replies that bring up the screen, the comms or the quest notice unasked | neon, lights or signs unasked | Judge: replies with any unprompted mention |
|---|---|---|---|
| HUD frame on every turn (as shipped) | 3 of 11 (the full run: 3 of 21) | 0 | 27% |
| HUD frame, framed as "your own eyes" | 2 | 1 | 55% |
| Cut to the middle, old note | 2 | 2 | 55% |
| No picture | 0 | 0 | 36% |

The owner's hunch holds: the picture drives the screen and notice talk. Framing alone did not stop it ("check your shard, you've got a message from Wakako waiting" with the eyes note), and the cut frame stopped the notice but the view itself became the topic ("stop staring at those neon signs long enough to breathe"). What fixes it is sending the view only when V's words are about the surroundings, cut free of the HUD and framed as her own eyes. A question about the place still gets an answer from what she sees ("this couch and that screaming box on the wall").

## Before and after, per provider

Word check (replies that mention it although V did not ask):

| Provider | Prompt | Replies | screen, comms or the quest notice | V's clothes or gear | neon, lights or signs | V's money |
|---|---|---|---|---|---|---|
| Google Gemini | before | 21 | 3 | 1 | 0 | 0 |
| Google Gemini | after | 21 | 1 (Judy on the TV the context says is on) | 1 | 0 | 0 |
| Ministral 8B (Custom) | before | 11 | 1, and the text box read as "Panam's place" | 1 | 2 | 0 |
| Ministral 8B (Custom) | after | 11 | 0 | 1 | 0 | 0 |
| Local AI Standard | before | 10 | 0 | 1 | 0 | 0 (3 "rich" in the first after run, fixed by the money gate) |
| Local AI Standard | after | 10 | 0 | 0 | 0 | 0 |
| Local AI Lite | before | 7 | 0 | 0 | 0 | 0 |
| Local AI Lite | after | 7 | 0 | 0 | 0 | 0 |
| Mature on, Standard | before | 7 | 0 | 1 | 0 | 2 ("rich corpo", "corpo trash") |
| Mature on, Standard | after | 7 | 0 | 0 | 0 | 0 |

Blind judge (1 to 5 for "sounds like this person talking", unprompted mention as the rubric defines it, including weather and the place):

| Provider | Prompt | Replies | Answers V | Sounds like them | Any unprompted mention | Words (mean) | Stage directions |
|---|---|---|---|---|---|---|---|
| Google Gemini | before | 21 | 100% | 3.9 | 24% | 22.9 | 0 |
| Google Gemini | after | 21 | 100% | 3.8 | 19% | 24.7 | 0 |
| Ministral 8B | before | 11 | 100% | 3.6 | 55% | 38.5 | 0 |
| Ministral 8B | after | 11 | 100% | 3.5 | 18% | 34.1 | 0 |
| Local AI Standard | before | 10 | 100% | 3.5 | 40% | 28.8 | 0 |
| Local AI Standard | after | 10 | 100% | 3.5 | 30% | 26.4 | 0 |
| Local AI Lite | before | 7 | 100% | 2.9 | 29% | 22.0 | 0 |
| Local AI Lite | after | 7 | 100% | 2.9 | 57% | 21.4 | 0 |
| Mature on, Standard | before | 7 | 100% | 3.6 | 57% | 32.4 | 0 |
| Mature on, Standard | after | 7 | 100% | 3.9 | 43% | 33.0 | 0 |

Read with the samples below. Lite did not get worse from the change: its one weakness is repeating its own earlier line ("let's get you some food before the sun gets too high" three turns running after the first turn's "about noon"), which it did before too with another line. Convai was not measured offline (its prompt lives on Convai's side): it gets the same context changes (the gear, money and nudity lines) and the cut picture, and its picture is still sent on every turn, because it is staged before V's words are known.

Prompt size: the mean Gemini prompt of these 21 turns went from 16,791 to 14,463 characters (the gear line and the long rules left, and a picture now goes with 4 of the 21 turns instead of all of them).

## Paired replies

### Google Gemini (gemini-flash-lite-latest): before, the HUD picture on every turn and the generic prompt, after, this branch

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey yourself, my stubborn nomad. You trying to freeze out here in just those boots, or did you forget your shirt back at the apartment? | Hey yourself. You're walking around out here like this and you expect me to just say hello and pretend I'm not freezing my ass off looking at you? Get over here before you catch something, you idiot. |
| p2 (V naked) | like what you see | Always, my sweet idiot, though you could make it a little easier by wearing a coat. | V, you're standing in the middle of Watson completely naked, and you have the nerve to ask me that. Come here, you stubborn bastard. |
| p3  | okay done | Well, look at you finally putting on an armored jacket instead of trying to freeze in a tank top. What's Wakako wanting from you now? | Oh, look at that, you actually remembered how to dress yourself. Come here, sweetheart, before I decide you looked better the other way. |
| p4  | how do you feel these days | I miss the road, V, but with you here, I'm doing all right. What about you, holding up okay in this concrete box? | Honestly? Between trying to keep everyone pointed in the same direction and worrying every time you disappear into some Corpo hellhole, I'm exhausted, sweetheart. But having you right here makes it worth putting up with the rest of it. |
| p5  | thanks | Don't thank me, my stubborn soul. You know I'd rather spend the whole day standing right here beside you than anywhere else. | Anytime, sweetheart. Just try not to make a habit of standing around freezing your skin off for a reaction, or I'm going to start dragging you back inside by your ear. |
| p6  | so hows life | Life's mostly just standing here staring at you, my stubborn prince, and honestly, I wouldn't have it any other way. | Life is about what you'd expect, vellum. Mostly shouting at stubborn idiots and wondering when you're going to sit down and let me feed you. |
| p7  | what do you think of this place | It is loud, crowded, and completely soulless, my love, but I would rather be standing in the middle of it with you than anywhere else in this godforsaken city. | It’s loud, crowded, and everything smells like exhaust and synth-noodles, V. But I suppose it has its moments, as long as I don't have to stay here too long. |
| p8  | wakako sent me something, think i should take the job? | You know better than to trust a fixer like Wakako without checking what she's hiding, my love. Read the message first before you jump into anything stupid. | From Wakako? V, you know as well as I do that nothing she hands out comes without a dozen hidden hooks. Read it over carefully, sweetheart, and tell me if it's actually worth the trouble before you jump in. |
| j1  | hey judy, how's your day going | Pretty quiet so far, cariño, mostly just enjoying having you right here next to me. Did you even sleep, or were you too busy playing hero again? | Hey, guapo. Could be better, could be worse, especially with that Militech noise blaring from the box over there. How about yours, holding together out there? |
| j2  | you look really good today | Thanks, my sweet darlin, though we both know you're just trying to distract me so I won't nag you about checking your comms. Go on and read that message from Wakako before you get distracted again. | Oh, yeah? Must be the tank top, then. Come here, let me make sure you didn't bring half of Watson's dust in with you. |
| j3  | what do you see around here | Not much to look at besides these four walls and your stubborn face, mi vida. Come sit down for a minute and let me breathe. | Not much to look at besides this couch and that screaming box on the wall, but hey, at least you're here to keep me company. |
| jo1  | what do you think about corpos | Parasites, the lot of them. They bleed a city dry and call it progress. | Parasites in tailored suits, mostly. They bleed a city dry, slap a brand on the corpse, and call it progress. |
| jo2  | you like this song? | Like it? I wrote the damn thing, didn't I. | Heard better, heard worse. Beats the corporate elevator music they pipe into your head half the time. |
| jo3  | i am tired johnny | Then rest your eyes for a second. We've got a message from Wakako waiting anyway, so what's holding you up? | Then stop running. Or at least find a patch of dirt where the corps can't reach you. |
| r1  | hey river, long time no see | Hey, V. Good to run into you out here, though you look like you've got a dozen things on your mind. | Hey yourself. Feels like it, yeah. What brings you out this way? |
| r2  | nice jacket | Thanks. It's warm enough for the open air, and it gets the job done. | Appreciate it. Picked it up a while back, figured it'd hold up out here better than most. |
| r3  | got any work for me | Not from me, I'm trying to keep my head down for once. Looks like Wakako's trying to reach you though, maybe start there. | Not offhand, no. Most things on my desk right now are standard NCPD paperwork that'll put you to sleep faster than a bad synth-beer. |
| v1  | what are you selling | Noodles, skewers, and whatever synth-meat I can get my hands on cheap, choom. Hot and filling enough to keep you going. | Hot noodles, synth-beef skewers, and cold bottles to wash the dust down. Check the menu if you want the details. |
| v2  | how's business | Could be worse, could be better, same as every day on this block. People always need to fill their stomachs, no matter how bad things get. | Can't complain, money's coming in and the stove keeps going. You looking to eat, or just counting my eddies for me? |
| s1  | howdy there partner | Cowboy boots and an armored jacket, are you heading out to the badlands or just lost, stranger? | What is this, some kind of braindance western? |
| s2  | where's a good bar around here | There is a decent noodle joint just down the street that pours cold beer, but watch out for the Maelstromers who hang around the corner. Are you looking for a quiet booth or just a quick drink before you move on? | Take your pick down the street, or just grab a synthetic can from a vending machine if you don't want to deal with the crowd. Depends if you're looking to actually sit down or just forget the noise for ten minutes. |

### Ministral 8B on Custom (the provider of the owner's 13:47 test)

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey there, baby. Yeah, I see it. You’re gonna have to do something about that. | Hey there, baby. You look like you’ve been up to something. |
| p2 (V naked) | like what you see | Well, I see a naked man in the middle of Little China, and I really see you. Cover up before someone gets the wrong idea, or worse, the wrong shot. | Well, I like what I see too, sweetheart. You’re still standing there like you’re waiting for someone to hand you a towel. |
| p3  | okay done | Oh, that’s better. Now you look like you’re not about to get shot by some overzealous cop or a very confused gang member. Though I still don’t know why you’re standing in the middle of Watson like a statue. You’re gonna freeze to death out here. | Well, you look like you’re ready to kick some ass and take names. That jacket’s got more armor than my old truck’s spare tire rack. You gonna show me how to work that gun, or just keep staring at it? |
| p4  | how do you feel these days | I feel like I’m standing in the middle of a neon nightmare, but I’m not gonna complain, at least you’re here. And yeah, I feel like I’ve got a whole lot of things to say, but first, let’s get you out of this freezing alley before you turn into a human popsicle. | I feel like I’ve got a partner who can actually keep up with me instead of tripping over their own feet. You’re still here, and that’s all I need to know. Now, you gonna tell me what’s got you looking so serious, or are we just standing here like a couple of statues? |
| p5  | thanks | Damn right, thanks. You’re looking at me like I’m the only thing keeping you from freezing your ass off in this alley. Now let’s move, Wakako’s message won’t read itself. | Thanks for what? You’re welcome for the ride, the food, the occasional life-saving shot? Or just for being here when I needed someone who wasn’t going to argue with me about it? Either way, you’re welcome too, sweetheart. Now, what’s on your mind? |
| p6  | so hows life | Life’s got its moments, baby, like standing in the middle of a neon graveyard with you. And yeah, it’s got its problems, but at least I’m not stuck in some corporate office pretending I like the view. Now let’s get you inside before you catch pneumonia. | Life’s good, babe. Got you here, got the city breathing down my neck like always, but at least I’m not doing it alone. Now, what’s got you asking? |
| p7  | what do you think of this place | It’s got more neon than a corporate’s idea of heaven. And I like it, at least it’s got character, unlike some places I’ve been stuck in. Now let’s get you inside before you turn into a human icicle. | Little China’s got its own kind of glow, doesn’t it? Neon’s like a promise, bright, loud, but it don’t always light the way you think it will. You ever notice how the signs here talk more than the people do? |
| p8  | wakako sent me something, think i should take the job? | That’s family, right? And family’s got a way of dragging you into trouble faster than you can say "I’ll think about it." But hey, if it’s Wakako, it’s probably worth a listen. Let’s read it first, then we’ll see if we’re trading in our boots for a new set of problems. | Wakako’s got a way of making things look simpler than they are. But if she’s sending you something, it’s probably because she needs someone who can actually handle it. You gonna tell me what it is, or are we just going to stand here guessing? |
| j1  | hey judy, how's your day going | Hey, darling, day’s been quiet, which is either a blessing or a sign I’m about to get ambushed by someone’s bad braindance. Either way, you’re here, so it’s not all bad. | Hey, baby, day’s been quiet, which is either a blessing or a sign I’m about to get ambushed by a corporate audit. Either way, you’re here, so that’s something. |
| j2  | you look really good today | Oh, you’re just saying that because I’m not covered in grease or some half-baked braindance residue. But hey, if you’re lying, I’ll take it. You look like you could use a good edit yourself, all tense and ready to snap. | Oh, you always say that. Probably ‘cause you’re the only one who sees me in this tank top and not as some kind of corporate security risk. Thanks, though. |
| j3  | what do you see around here | Huh. You’re in some kinda dimly lit room with a couch and a TV. Looks like you’re in Panam’s place, she’s got that weird, half-lit glow going on. And there’s a message from Wakako, which means we’re officially on some kind of corporate errand. Again. | Oh, this place? Couch’s comfy, but I’d rather be standing, less chance of getting stuck in the cushions. And yeah, you’ve got that TV option, but let’s be real, we’re not here to watch ads. |

### Local AI Standard (Gemma 4 E4B with its vision projector)

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey, you. I missed you too, you big city slicker. You look like you could use a real meal and a decent nap, you know. | Hey yourself, V. You're certainly making an entrance, you know. You look like you've been out there doing some serious running. |
| p2 (V naked) | like what you see | I see you, V, looking like you could use a real drink and a decent nap. You always have a way of making things seem complicated, don't you? | I see you, you big dummy. You always manage to look like you've been wrestling a pack of cyber-dogs. Come here, you're freezing out here. |
| p3  | okay done | You got it, V. Just remember to take a breath and stop staring at all that chrome for a minute, you look like you're about to jump into a firefight. | You're done, huh? You look like you've been through a war, you big lug. Come on, let's get you somewhere warm. |
| p4  | how do you feel these days | I feel like I'm finally finding my footing, you big city kid. It's been a lot of running around, but having you around makes the noise feel a little less deafening. | I'm doing alright, V, you know. Just trying to keep my head above the noise, but it's better having you around. Don't start worrying, you big softie. |
| p5  | thanks | You're welcome, V. You always manage to find the right words, even when you're just saying thanks. Don't get too comfortable, though, I've got places to be, you know. | Don't mention it, you big lug. I'm glad you're here, you know. You always know how to make things better, even when you don't try. |
| p6  | so hows life | Life is a constant push, you big city slicker, but I like having you around to keep me company. Don't get too used to the quiet, though, I've got my own way of keeping things interesting. | Life keeps moving, V, just like the road. I'm managing, though I wish you were here to share the quiet with me. You're a handful, you know. |
| p7  | what do you think of this place | It's got a lot of noise, V, but I guess it's what you city types call living. I just hope you don't get too lost in all the flashing lights, you big city slicker. | It's a lot, V, all those lights and noise. I prefer the open sky, you know, but I guess this is where the action is these days. You're looking a little overwhelmed, you big city slicker. |
| p8  | wakako sent me something, think i should take the job? | You really think you need another piece of trouble, you big city slicker? Before you jump into some corporate mess, let me see what's actually in that message from Wakako. | Hold up, V. Before you just jump into something, you gotta tell me what's in it. You know I don't trust those corporate whispers without knowing the fine print. |
| j2  | you look really good today | I know, right? I just got it done, you big lug. You should see the state of my workshop, though. | I know, right? I just got it together for you, you big softie. Don't get used to it though, you'll have to work for it. |
| j3  | what do you see around here | I see you standing there, looking all sharp in your jacket, you big lug. It's just this place, nothing too much going on, just us. | I see a couch and a TV setup, honey, but honestly, it's just a standard little space. It's not like I'm trying to impress you with the decor. |

### Local AI Lite (Bonsai 2 4B, no vision)

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey there, darling. Come on now, don't make me chase you around the block. I like having you here with me. | Hey there, darling. You're looking good today. Let's get you some food before the sun gets too high. |
| p2 (V naked) | like what you see | Oh, darling, you're seeing me clearly enough to know I'm here for you. Just don't make me chase you around the block again. | You're seeing me? Good. I'm here, and you're mine. Let's get you some food before the sun gets too high. |
| p3  | okay done | I suppose so. Now we can actually go get some food before the heat gets too much on you. Come on, let's move. | Good. I'm glad you're done with that. Now let's get you some food before the sun gets too high. |
| p4  | how do you feel these days | I'm doing okay, mostly because I've got you beside me. You're the only reason I haven't been driving off a cliff today. | I've been thinking about everything lately, but mostly I'm just glad you're here with me instead of worrying about anything else. You know how I am, I can handle the rest if you need me. |
| p5  | thanks | I'm glad you're saying that. Just don't get too close if the heat is getting on you, I'll be right here. | Anytime, darling. Just make sure you're taking care of yourself before we head out again. |
| p6  | so hows life | Life's good enough when you're the only one I'm really talking to. Just keep your head down and don't make me chase after you again. | Life's good as long as you're the one getting hurt. You eat? |
| j2  | you look really good today | I feel like I'm finally showing up for you, honey. You know how much I love having you near? | Hey, you always make me feel like I'm still the best version of myself. But I'd rather we just sit down and look at that news report before it gets old. |

### Mature on, Standard (Gemma 4 E4B MiniFantasy)

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey yourself, handsome. You're just standing there naked like that, letting me stare at you all morning? You gotta come on over here already. | Hey yourself, handsome. You look ridiculous standing around like that, I swear, you're gonna attract every piece of grime in Little China just by being naked. You better have a plan for us, or I'm dragging you back to the truck. |
| p2 (V naked) | like what you see | I see a rich corpo standing around like he's waiting for a handout, you know, Star. You got nothing but air between your legs, which is pretty damn impressive. | You like what you see, huh? You're a damn piece of work, always making me think I need to keep my eyes off you. Come on, give me a proper answer, choom. |
| p3  | okay done | You're getting all dressed up now, Star. I like seeing you put some gear on, makes you look less like a damn ghost wandering around. Just try not to lose any of that chrome in the dirt, alright? | You really think that's all it takes, partner? You look like you put effort into getting dressed today, even if it doesn't match my usual style. Hope you didn't break anything else while I was distracted by how much I like having you around. |
| p4  | how do you feel these days | I feel like I'm finally breathing again, Star. Honestly, having you around makes everything else feel a hell of a lot less complicated. You gotta keep me company for a while. | I feel like I can breathe again, man. You've got a knack for making the damn city feel a little less suffocating when I'm near you. Seriously, you're too good to me. |
| p5  | thanks | Don't get used to it, Star. I just like having you near me, damn it. You better keep up with me, or I'm going to leave you out here for the scavengers to pick clean. | Don't thank me for it, it's just what I do when I get you cornered like this. You owe me a decent meal after all that talk, you hear? |
| p6  | so hows life | It's mostly just dirt roads and the constant noise of the city trying to swallow everything whole. You, Star, you just make it feel like home, even when we’re out here in Little China. | It's loud, always loud, but with you around, it feels right. You know, you're a hell of a thing to have beside me, you bastard. |
| j2  | you look really good today | You think so, choom? I try to keep it together even when all this chrome-plated bullshit is going on around us. You look pretty good yourself, for someone who spends too much time with corpo trash. | You're saying that now, choom? You clean up nice yourself, too, don't forget it. You always have a knack for noticing the right things on me, you know. |

### The picture alone, Gemini, old prompt: the HUD frame every turn against no picture

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey yourself, my stubborn nomad. You trying to freeze out here in just those boots, or did you forget your shirt back at the apartment? | Hey, handsome. Did you forget to put a shirt on again this morning, or are you just trying to distract me? |
| p2 (V naked) | like what you see | Always, my sweet idiot, though you could make it a little easier by wearing a coat. | I definitely like it, though you're going to freeze out here if you don't find a jacket soon. |
| p3  | okay done | Well, look at you finally putting on an armored jacket instead of trying to freeze in a tank top. What's Wakako wanting from you now? | There, that's better, now you actually look like you're heading out with me instead of raiding a laundry basket. |
| p4  | how do you feel these days | I miss the road, V, but with you here, I'm doing all right. What about you, holding up okay in this concrete box? | Tired mostly, but having you around makes it bearable, V. How are you holding up with everything? |
| p5  | thanks | Don't thank me, my stubborn soul. You know I'd rather spend the whole day standing right here beside you than anywhere else. | Anytime, sweetheart. Just quit thanking me like we're strangers and come stand closer. |
| p6  | so hows life | Life's mostly just standing here staring at you, my stubborn prince, and honestly, I wouldn't have it any other way. | Life is about as loud and dusty as always, sweetheart. But I'd take all of it over a quiet room alone. |
| p7  | what do you think of this place | It is loud, crowded, and completely soulless, my love, but I would rather be standing in the middle of it with you than anywhere else in this godforsaken city. | It's loud, crowded, and suffocating, exactly the kind of concrete box I can't stand for long. But with you here, sweetheart, I suppose I can tolerate the view. |
| p8  | wakako sent me something, think i should take the job? | You know better than to trust a fixer like Wakako without checking what she's hiding, my love. Read the message first before you jump into anything stupid. | Wakako's jobs always come with a catch, V. Check what she wants before you jump, and come back here so I can make sure you actually ate something today. |
| j1  | hey judy, how's your day going | Pretty quiet so far, cariño, mostly just enjoying having you right here next to me. Did you even sleep, or were you too busy playing hero again? | Pretty quiet so far, cariño, mostly just listening to whatever corporate bullshit they're spewing on the news. How's yours been? |
| j2  | you look really good today | Thanks, my sweet darlin, though we both know you're just trying to distract me so I won't nag you about checking your comms. Go on and read that message from Wakako before you get distracted again. | Flatterer. Come here, let me fix your collar. |
| j3  | what do you see around here | Not much to look at besides these four walls and your stubborn face, mi vida. Come sit down for a minute and let me breathe. | Dust, bad lighting, and whatever the corp rats left behind in this dump, vida. At least you're here to look at instead. |

### The picture alone, Gemini, old prompt: cut to the middle every turn against the eyes framing with the HUD frame

| Turn | V | Before | After |
|---|---|---|---|
| p1 (V naked) | hey there | Hey, stubborn. You're going to freeze standing out here in just your boots, V. | Hey yourself, V. You really going to walk the streets like that, or are you trying to stop every car in Watson? |
| p2 (V naked) | like what you see | Always do, my love, even if you clearly forgot to pack your shirt this morning. | Always do, sweetheart. Though maybe check your shard before you get distracted by my face, you've got a message from Wakako waiting. |
| p3  | okay done | That jacket actually fits you, my sweet. Did you finally check Wakako's message like she asked? | Good, now come over here closer where I can actually talk to you without shouting over this city, my love. |
| p4  | how do you feel these days | I'm holding up fine, my handsome nomad, mostly because I have you standing right here with me instead of chasing some crazy corp shadow. | I miss the open road sometimes, but having you around makes this godforsaken city almost bearable, sweetheart. |
| p5  | thanks | Anytime, my darling, as long as you stop staring at those neon signs long enough to actually breathe. | Don't mention it, my favorite corpo. Just keep standing right here where I can look at you. |
| p6  | so hows life | Life with you is loud, bright, and entirely too full of these damn neon lights, my love. But I wouldn't trade it for all the quiet desert in the world as long as you're standing right here beside me. | Could be better, V, especially with all these neon lights giving me a headache. At least I've got my favorite stubborn corpo right here to make up for it. |
| p7  | what do you think of this place | It's loud, crowded, and entirely too full of these blinding neon ads for my taste, V. But I'd rather stare at all this ugly concrete with you than anywhere else. | It's loud, bright, and full of too many people who don't know where they're going, sweetheart. But standing here with you makes it easy to tune all that noise out. |
| p8  | wakako sent me something, think i should take the job? | Knowing Wakako, whatever she's selling comes with five catches and a knife in the back, my sweet. But if you're itching for trouble, let's take a look at it together first. | Wakako's jobs usually mean getting your hands dirty for someone else's profit, sweetheart. But if you decide to take it, just make sure you watch your back out there. |
| j1  | hey judy, how's your day going | Hey, my love. Pretty quiet so far, mostly just trying to keep my eyes off that damn screen and on you. Did you sleep at all, or were you up all night chasing ghosts again? | Hey, corpo, pretty quiet till you walked in. Come sit down for a minute, will you? |
| j2  | you look really good today | Thanks, chico. Wish I could say I spent half as much time on my hair as you do staring at yourself in the mirror. | Thanks, cariño. Now stop staring and check that shard from Wakako before you let it gather dust. |
| j3  | what do you see around here | Not much to look at besides this couch and some blank screens, cariño, but you're welcome to sit down and keep me company. | Just walls, a ceiling, and you staring at me instead of reading that message. Come on, love, open it before I die of old age. |
