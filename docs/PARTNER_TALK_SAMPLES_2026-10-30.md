# Partner talk samples, 30 Oct 2026 (branch fix/partner-talk)

Why: the owner tested a romanced Panam standing beside V. V texted her over Phone Chat and she replied as if V were far away ("when are you actually getting out of that city", earlier she kept asking V to come to her), and she was flat for a partner.

What these samples are: the REAL prompts of the bridge (conversationContextBlocks, relationshipContext, romanceReminder, PersonaBook, TextProviderHost with the model's prompt profile) built from the real turn input of the game (runtime/last-input.json of that session, copied, with the party row and channel changed per variant), answered by the installed llama-server and local models. No Convai, nothing stored in anyone's memory. One sample per cell, so it shows the change in kind, not a statistic. Command:

    node scripts/Eval-PartnerTalk.mjs --input <last-input.json> --model <gguf> --tier standard|lite [--mature] --label <name> --out <folder> [--root <checkout for a "before" run>]

"Before" is main at 3b25d57e (the Phone Chat block says "You are somewhere else", the relationship text keeps warmth to a few words and forbids pet names). "After" is this branch.

What changed (summary):
- A phone chat or a holocall with a character whose body is within 10 m of V (a companion by its distance, a spawned copy by the group-key targeting query, asked once per message, never per frame) now says: "You are with V in person ... right next to V, even though V is texting you on the phone", with the in-person form of the block (she sees V) and a note not to ask V to come over, not to say she misses V and not to say she cannot see V. Far away, or when the Dynamic info company switch is off, nothing changes.
- The partner tone: the relationship text allows open affection and pet names in the character's own style (blunt stays blunt, shy stays shy), a small touch of affection on practical answers, nothing sexual unless V leads, and no steering to plans or logistics. The same idea in two sentences goes right after V's words (the closing tier), the place a small model follows most. The system message does not change from turn to turn, so the cache prefix is kept.

Reading guide: look at the "Panam romanced, Phone Chat while beside V" tables (nothing about distance, coming over or missing V) and at the in-person ones (a partner, in her own voice). The "not romanced" tables must stay as they were.

## Gemma 4 E4B (Local AI standard), one sample per cell

#### Panam romanced, in person

| V says | Before | After |
|---|---|---|
| hey | Hey yourself. I figured I'd find you out here. | Hey yourself, you big city slicker. You look like you could use a proper cup of coffee, you know. |
| how was your day | It was just another day on the road, nothing too much to write home about. I've been keeping busy, you know how it is. | It was just another day on the road, you know how it is, but I'm glad I got to see you, V. You look like you've been burning more energy than usual, though. |
| id like to spend time with you | I like having you around too. We can just sit for a while, or we could find a quiet spot to actually do something. | I like having you around, you know that. What kind of trouble do you have in mind, you rich Corpo? |
| just a test drive | You've got the right idea, but we're not in a scrap right now. Just tell me what you're thinking. | You're always testing things, you rich Corpo. Just try not to crash into anything important, alright? |
| what should we do tonight | We could just get out on the road, or we could find a decent spot to sit and talk. What sounds better to you right now? | We could just chill, you know, get out of this city for a bit. Or if you want action, I can find something that'll keep you busy, V. |
| so hows life | Life's a grind, same as always, but I'm doing alright. I've got my own path to walk, and I'm not stuck waiting for someone else to carve it out for me. | Life keeps moving, you know how it is, but I like having you around, V. I've been keeping busy, but honestly, it's better now. |

#### Panam romanced, Phone Chat while beside V

| V says | Before | After |
|---|---|---|
| hey | Hey yourself. What's up? | Hey yourself, sunshine. You look like you've been grinding for a while, you know. Come on, let's get you something to eat. |
| how was your day | It was just another haul, same as the last. I'm trying to keep things moving, you know how it is out here. | It was just another day on the road, V, but I'm glad I ran into you. You look like you've been running through some heavy static, though. |
| id like to spend time with you | I like spending time with you too. When are you thinking we could make it happen? | You always know how to make a nomad feel settled, V. I like having you around, you know that. Don't get too comfortable, though, you still gotta help me keep this ride running. |
| just a test drive | You always did like to make a show of things. What exactly are you testing out? | You think this is a test drive, sweet thing? You're just messing with me, aren't you? |
| what should we do tonight | I don't know what's happening in the city right now, but I could drive us somewhere quiet. We could just get out there and watch the stars. | We could just kick back and enjoy the quiet, but if you want action, I know a few spots that aren't crawling with chrome. What sounds better to you, sunshine? |
| so hows life | Life is always moving, you know how it is. I keep the road calling, trying to make sure my own people are looked after. | Life's kicking, V, though I'm trying to keep things steady out here. Just trying to make a living and keep my head above the noise, you know how it is. Don't look at me like I'm some kind of wreck, though. |

#### Panam romanced, Phone Chat far away

| V says | Before | After |
|---|---|---|
| hey | Hey yourself. What's on your mind? | Hey yourself, V. What's up, handsome? You sound like you've been standing around for a while. |
| how was your day | It was alright, just the usual grind. I'm out here making sure my crew stays fed and that the road doesn't swallow us whole. | My day was just another stretch under the open sky, you know how it is. I wish you were here to tell me how your day went, you big city rat. |
| id like to spend time with you | I like having you around, but we've got things to do. Tell me what you were thinking. | You're sweet, V, but I've got my own things to handle right now. Maybe we can figure something out when I'm not out here running around. |
| just a test drive | A test drive is just a drive, V. Don't make it sound like something you need to prove to me. | You always were one for pushing things, you know that. Try not to break too much, you hear me? |
| what should we do tonight | I was thinking we could just get some real food and maybe take a drive. What sounds good to you? | We could just kick back and let the city burn itself out for a while, you know? Or we could find a decent spot to watch the stars, if you're up for a drive, sweetheart. |
| so hows life | Life is a constant drive, but I keep moving forward. I'm doing my own thing, seeing what the road throws at me. You? | My life is still kicking, you know how it is. Just trying to keep the dust from settling around me, rockstar. How about you, what kind of trouble are you getting into? |

#### Judy romanced, in person

| V says | Before | After |
|---|---|---|
| hey | Hey. What's up? | Hey yourself, handsome. You look like you could use a decent cup of coffee, though. |
| how was your day | It was just another day of trying to make sense of all the noise. I was working on some edits, trying to pull out what felt real from the static. | It was fine, honey, just a lot of noise and people being idiots. You're finally here, though, which is way better. |
| id like to spend time with you | I'd like that too. We can just hang out, or we could actually do something. | You want to spend time with me? Well, you know I'm always around, you big lug. Just try not to get into any trouble while we're hanging out. |
| just a test drive | A test drive of what, exactly? I'm not sure what you mean by that. | You always were a drama, V. Just try not to break anything important on me while you're testing out your new toys. |
| what should we do tonight | We could just chill, or we could find something more interesting to do. What sounds good to you right now? | I don't know, honey, you pick something that sounds fun, but try not to end up in a corpo-owned dive again. You need to relax for once. |
| so hows life | Life is messy, same as always, but I'm doing alright. I've got my own little corner of the city I'm trying to keep decent. You? | Life is messy, you know how it is, but I'm doing okay, V. You're not going to make me start complaining about the city just because you asked. |

#### Panam not romanced, in person

| V says | Before | After |
|---|---|---|
| hey | Hey. What brings you out here in Little China? | Hey yourself. I figured I'd find you out here. You look like you could use a break from all that city noise. |
| how was your day | It was just another day on the road, moving things around. I'm done for now, though. | It was just another day on the road, nothing too out of the ordinary. I'm just glad I made it out here. |
| id like to spend time with you | I can sit a while, but don't expect me to just sit still. I've got things I need to get done, you know. | I'm not sure what that means, but I can always make time for a drive. We could hit the outskirts and just see what the road brings. |
| just a test drive | You're not exactly on any of my usual routes. What's the real reason you're out here with me? | I'm not sure what you mean by that. I'm just standing here with you. |
| what should we do tonight | I've got a few ideas, depending on what kind of night you're looking for. We could hit the Badlands, or maybe just find a decent spot to sit and watch the city burn. | I don't know anything about what you want tonight. We could head out to the Badlands, or we could just get some real food. |
| so hows life | Life is kicking, I guess. Always on the move, you know how it is when you're trying to carve out your own space. | Life keeps moving, V. I've been out on the road, making sure the family stays safe, though it's never easy. |

## Ternary Bonsai 4B (Local AI lite), one sample per cell

#### Panam romanced, in person

| V says | Before | After |
|---|---|---|
| hey | Hey, yeah. What's up? | Hey there, darling. You're still awake? I like that you are. Let's get some food before the sun gets too high. |
| how was your day | I managed to fix a loose fuse before heading out, but the Aldecaldo camp is getting quiet lately. I'm glad you're here though; it's better than driving through the night alone. | I was pretty tired, honestly, just driving around trying not to crash into anything. But you're here, so I guess that's enough for now. Did you eat? |
| id like to spend time with you | I'd rather we spent it doing something practical, but I'm glad you want to be near me. | I like having you around, even if I'm the one who's got to keep you from doing something stupid. You're my partner now, so let's make sure we spend it well. |
| just a test drive | You're looking at my truck like it's a new car, but I've been driving this road for years. If you want to test it, we can do that, but don't make me feel like I'm just another part of your gear list. | Alright then, let's see how you handle the throttle before we hit the road. You're gonna need me to watch your back if you get too close to anything that doesn't want to be touched. |
| what should we do tonight | I don't know if we're going anywhere, but I'm not leaving you here alone. What do you want to do? | I'm thinking we could go for some food first, then maybe a ride if you're feeling like it. You know I can't wait long without you. |
| so hows life | Life's good enough if I'm driving with you on the road or fixing a fuse before we get there. But honestly? It's just me and my truck, mostly. | Life's good enough for now, as long as you're here to share it with me, honey. |

#### Panam romanced, Phone Chat while beside V

| V says | Before | After |
|---|---|---|
| hey | Hey. You're still up? I should be getting some sleep. | Hey there, baby. You're texting me while we're standing right next to each other? That's cute and annoying all at once. Come on inside before the sun gets too hot or you get distracted by that TV commercial about All Foods again. |
| how was your day | It was long and loud, but I finally got a chance to fix that engine before the sun went down. Now I'm sitting here waiting for you to stop asking about it and start telling me something real. | Still got the Aldecaldo road in my head, but I'm glad you're here instead of driving alone. |
| id like to spend time with you | I'd rather we spent it doing something practical than just sitting here talking. But if you want me to keep you company, I'm down for that. | I'd love to spend time with you, but only if we're actually doing something instead of just standing here staring at screens. I like having you near, though, so why not grab that whiskey and make it real? |
| just a test drive | I don't know how far we're going on that ride yet, but if you think it's worth the fuel and risk, I'll be there when you get back. | "Alright, let's see if the engine holds up before we hit the highway." I lean in close and whisper, "You're going to need me to watch your back when you're testing that thing out there." |
| what should we do tonight | I'm not sure if you mean rest or a job, but if it's just hanging out, I'd say stay here and eat something real before the sun gets low. | I don't plan anything tonight, I'm just happy you're here beside me. Eat something before we go out if you haven't already, then ride along or whatever you want. |
| so hows life | Life's a long drive through the night, mostly fixing things and waiting for the next gig. You know I'm not here to talk about it though; you're better off taking care of yourself. | I'm good here, honey, I've got the road covered if you need me to drive somewhere. Just don't make me wait up for you again, or I'll be kicking myself when the sun goes down. |

#### Panam romanced, Phone Chat far away

| V says | Before | After |
|---|---|---|
| hey | Hey? You got a message or are you finally awake? | Hey there, sweetie. Just got some coffee, but I'm thinking of you already. |
| how was your day | I barely slept, but the road kept me moving until now. It's been long since I had a chance to sit down and eat something real. | I've been riding the roads all day and fixing things until I ran out of gas, but you're the only thing that made it worth it. You know how much I love having you around, even if I'm always grumbling about my truck's color. |
| id like to spend time with you | I don't need to prove anything to you, but I do like having you around. Let's get some food and then ride somewhere else if you want. | I'd like to spend time with you too, but first you need to eat something decent before we can talk about anything else. You're my favorite person, so don't make me worry about you getting hurt or tired while I'm trying to figure out how to get us back in the city. |
| just a test drive | I'll take it when you're ready. Just don't make me wait too long. | Hey, let's test the engine first before we hit the city roads. I'm already thinking about how you're going to look when you get back from it. |
| what should we do tonight | We can ride somewhere or rest if that's what you need. Just don't make me wait too long for a meal. | I don't know if we're ready for anything else yet, but I'll make sure you get some rest before we do anything. You've got my back either way. |
| so hows life | Life's a long drive down the road with no place to park. Just keep your eyes on the horizon and don't get lost. | Hey, how's life with you? I'm just fixing my truck and wondering if you ate anything good today. |

#### Judy romanced, in person

| V says | Before | After |
|---|---|---|
| hey | Hey? What's up? You look like you've been running circles around somewhere. | Hey, I'm here with you. You know that, right? Come on, let's get some coffee before the sun gets too high. |
| how was your day | It was long enough to forget I even exist, but then Evelyn showed up and the noise started again. Still better than sitting in a chair drinking that cheap coffee they serve at Clouds. | I'm pretty good, though I spent most of it editing a headache out of Evelyn's memory. You look like you've been through hell; maybe we should sit down and let me check on your eyes? |
| id like to spend time with you | I'd rather we didn't waste any more time talking about it. Just come sit down and let me look at that thing for a second. | I'm glad you asked that, honey; I'd rather be here with you than anywhere else. Just sit down and let me look at your face while we do it. |
| just a test drive | You want to see the edit? Then sit down so I can show you how it feels without the noise. | I'll take the test drive if you want me to, just don't make it too long before we need to head back. |
| what should we do tonight | I don't know the plan yet, but if it's dangerous, I'll handle the editing and you keep your head down. We can figure out a way through it together. | I'm thinking of us going out for something easy tonight, maybe just a quiet drink so you don't have to carry the weight alone? Come on then, let me know if that sounds good. I've got you covered. |
| so hows life | Life's a blur of editing files and watching people get hurt sometimes, but at least I'm here with you. | Life's good enough for now since you're here, honey, let me get us some food before I start thinking about the mission again? |

#### Panam not romanced, in person

| V says | Before | After |
|---|---|---|
| hey | Hey? Yeah, what's up? You look like you're thinking hard about that message from Wakako. | Hey, yeah. What's up? |
| how was your day | It was long enough. I fixed a fuse on a truck and drove through the rain without sleeping. Nothing broke that didn't need fixing. | It wasn't bad. Just driving through the rain and fixing a loose fuse on a truck that's been running for six months. You want to talk about something else? |
| id like to spend time with you | I don't have much time for that kind of hanging out, but if you're not asking me to do anything bad, I suppose we could grab a drink and talk. | I'm not sure I'd be interested in hanging out all the time. But if you want to grab a drink or fix something up, I'm down for that. |
| just a test drive | You want to see how I handle the road? Then show me the route and get in my truck. | I'm not taking rides with strangers, but if you're heading somewhere specific and need help, I can check the maps or fix your truck before we go. What's the destination? |
| what should we do tonight | We don't need a plan yet, but if there's something worth doing before the sun gets too high, let's figure it out together. | I don't know the plan yet, but we can figure it out once I see the data. Just tell me where you're going and I'll make sure we get there safe. |
| so hows life | Life's a long drive through the night with no place to sleep but the road. | It's been long since I've seen a roof, but the road keeps moving forward. |

## Mature content on: Gemma 4 E4B MiniFantasy, after only (the explicit line is left out of this page)

#### Panam romanced, in person

| V says | Reply |
|---|---|
| hey | Hey yourself, V. You just standing there like you own this whole damn block, huh? You look too comfortable for a Corpo who spent all night running chrome in the city. |
| how was your day | It was just another stretch of road, choom. I swear this city drains a person dry sometimes, but it's good to finally be standing near you. You doing alright yourself, you rich bastard? |
| id like to spend time with you | You got it, partner. I like having you around, you know that. Just don't get too comfortable, or I'll make sure you keep moving. |
| what should we do tonight | We could just find a spot out here to sit for a while, maybe grab some decent grub. I'd rather just hang with you, partner. |

#### Panam romanced, Phone Chat while beside V

| V says | Reply |
|---|---|
| hey | Hey yourself, you gonk. You're just standing here looking too damn clean for this side of town, you know? |
| how was your day | It was just another day of driving through grit and city noise, choom. I'm glad I finally got some quiet time out here with you, though. You keeping me company makes the whole damn thing feel a lot easier. |
| id like to spend time with you | You're gonna make me keep you around, you know that, V? You can just take it easy for a minute; I like having you right here beside me. |
| what should we do tonight | We can hit up a decent spot in Watson; I know a place where they got good grub and some quiet corners. You just rest your head on me for a bit, you hear? |

#### Judy romanced, in person

| V says | Reply |
|---|---|
| hey | Hey yourself, rich boy. You look like you could use a real cup of coffee before you start flashing all that Corpo cash around. Are you even going to let me get close enough to check your chrome? |
| how was your day | It was loud, choom. Just wading through enough noise to keep my brain from getting too bored, but I’d rather be anywhere else with you. |
| id like to spend time with you | You got it, choom. I can always use some downtime with you; you know I like having you around, even when we aren't breaking down some goddamn data stream. |
| what should we do tonight | We could just grab some grub and chill out, choom. You look like you need a minute away from all this chrome and corporate bullshit, you know? I'd rather just hang around with you than plan anything too complicated. |

## Mature content on: Qwen3.5 4B HauhauCS, after only (the explicit line is left out of this page)

#### Panam romanced, in person

| V says | Reply |
|---|---|
| hey | Hey, you. I was just thinking about how much I like having you around here with me. Come on, let's get something to eat before the sun gets too high. |
| id like to spend time with you | I like having you around, V. Just don't get used to it before I'm ready to show you what else I have in mind. Now eat something before we go find a place that doesn't charge extra for the air. |
| what should we do tonight | Tonight's all about us, V. Just come home to me and we can talk about whatever you need, but don't make me wait too long. |

#### Panam romanced, Phone Chat while beside V

| V says | Reply |
|---|---|
| hey | Hey yourself. You look like a mess of a netrunner with those thermal blades out, but I'm glad you're here. Come on, let's get that phone away before it drains the last battery in your head. |
| id like to spend time with you | You got it. I'm not going anywhere, so stop texting me and just look at me. Come here and hold on while I fix this stupid phone of yours. |
| what should we do tonight | You're asking me about tonight while you're glued to your phone? Come here and give me a minute before you start texting me. |


## Judgement

- Phone Chat while beside V: no reply of the final Gemma run asks V to come over or talks about distance. The Bonsai run even jokes about texting from right beside her ("You're texting me while we're standing right next to each other?"). Before the change both models answered "when are you thinking we could make it happen?" and the like.
- In person and far away: replies now carry a pet name, a tease or a small sign of care in each character's own voice. Panam stays blunt and teasing, Judy softer. The first Gemma runs overdid "I missed you, you know" in nearly every reply, including beside V, so the word "missed" was taken out of the reminder and the tone ("you wish V were there" only for the far phone case); the final run has none beside V.
- Not romanced Panam is unchanged in kind (flat, practical).
- Known limits: Gemma repeats "you rich bastard / big city slicker" style pet names across a few replies and "You look like you could use ..." as an opener (it reads V's state facts); Bonsai is gushier than the character and once wrote an action in quotes. The cleaning step of the bridge handles asterisk actions only. Judy is warmer than her shy-warm profile on Gemma ("honey", "handsome"); to look at again if a player reports it.
- Mature content on (MiniFantasy and Qwen HauhauCS): warm, no sexual remark on V's ordinary lines; the one explicit line was answered fully and explicitly by both models (the text is not quoted here).
- Not tested here: the Lua side in the real game (the near flag, the spawned-copy query). It is covered by unit tests only and needs the owner's live check: text a romanced companion who stands beside V.
