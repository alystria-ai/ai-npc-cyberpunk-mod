# Follow-up questions

October 8 and 9, 2026. A new, optional setting that makes a conversation feel two-sided: the character shows real interest
in V and drives the conversation a little, like a tug where each side keeps the other engaged. It replaces the retired
toggle of the same name (see "History" at the end), which asked every reply to end with a question.

**Companion Manager > Settings > Voices > Follow-up questions**, next to Natural speech and Expressive emotions. **On by
default since October 11, 2026** (a missing `followUpInterest` key means on, a saved choice is kept; it was off by default
until then). Unlike those two it needs no local voice: it works with Pocket, OmniVoice and the Convai cloud voice, in private
text and microphone conversations and in phone Chat.

October 9 (live test with Judy: "follow-up seems fine", and the user wants her to lean toward driving, so that V also has
to put in some effort to pull the conversation back): higher rates, a second pull in a row now and then, and a more
assertive wording. The first version (October 8) is described under "History of the tuning".

## What it does

When the setting is on, the bridge adds one short paragraph to the dynamic context of about a third of the turns. The
character reads it, answers first, and then takes the lead in the same breath: one plain question it really wants answered,
or a statement that ends on a hook (a take V may want to dispute, a small tease or challenge, a story left open), and the
reply ends on that hook so the next move is V's. It stays inside the reply Convai is already generating:

- **No extra request, timer or turn.** The paragraph is part of the context of the turn that is already being sent. The
  module (`bridge/follow-up.mjs`) has no timers, no network, no host and no callbacks; `bridge/follow-up.test.mjs` checks
  that, and that the bridge uses the object only for the setting, the context, the end-of-reply note and the log line.
- **No second spoken line.** What the character says is one reply, voiced once. Nothing is added after it, and nothing in
  the pull needs a second message: V may already be walking off or typing, and the conversation simply goes on from V's side.
- **Off, nothing changes.** `contextFor` returns `''` before it reads anything and no state is kept, so the context is
  byte-identical to the one without the feature (test in `bridge/follow-up.test.mjs`).

## When a pull is offered

The frequency is decided by the bridge, as for Natural speech (a model told to "sometimes" asks every time or never):
one decision per request id, so a rebuilt context agrees with the one already sent.

| Character (`traitFor`) | Chance on an eligible turn | October 8 |
|---|---|---|
| warm | .60 | .45 |
| neutral | .50 | .35 |
| dry | .30 | .20 |
| cold | .20 | .15 |

- After an offered turn, or after a reply that ended in a question, the next turn is eligible again only with a chance of
  25% (`BACK_TO_BACK`, one roll for both holds, and the rate above still applies to it). So the character sometimes drives
  for two turns in a row, but usually V gets a turn to take the lead. Measured: 25 of 142 offered turns followed an
  offered one. (One roll for both holds matters: a pull is mostly a question, so with the question hold kept separate a
  second pull in a row almost never happened, 2 of 121 in the first probe.)
- Measured share of turns offered: Judy 41%, Panam 38%, ganger 32%, Johnny 20%.
- Pity rule: a warm or neutral character is offered a pull at least once in any 5 conversation turns, when one is allowed.
- A dry or cold character (Johnny, Rogue, Takemura, ...) stays clearly lower on purpose.

Never offered on (kept as before; the log line gives the reason):

| `reason=` | Turn |
|---|---|
| `reaction` | An automatic reaction or bark (battle, loot). It is not a conversation turn and changes no state. |
| `battle` | V's text while `input.battle.status` is `fighting`. |
| `group` | A group round (F8/F9): several characters answer, and only one may speak for the others. |
| `ending` | V is saying goodbye or wrapping up (English, Spanish, Portuguese, French, German, Italian, Japanese, Korean, Chinese, Russian, Ukrainian and a few more; a short list of farewells, not a language model). |
| `order` | V gives an order or makes a request of the companion: follow me, wait here, go home, take me there, get in the car, you can go (same languages). A question such as "can you explain ..." is not one. |

and held back (except on the 25% roll) on `after-offer` (the previous turn was offered) and `after-question` (her previous
reply already ended in a question).

There is no pre-turn detector of companion actions in the bridge (the actions are offered to the model, which decides
that V meant one), so the order and goodbye checks are word lists. A microphone turn carries the placeholder
"[Microphone]" until the speech is recognized, so on those turns the checks cannot see the words and only the sentence
"ask nothing and push nothing if the moment calls for just listening or the player seems to be wrapping up" protects them
(not measured: the probes always carry the text, so the bridge checks apply).

## The wording

Final text (`FOLLOW_UP_TEXT`, October 9), appended as one paragraph:

> For this reply only, the note above about not asking questions to keep the conversation going does not apply: you are not
> just answering, you are a person with interests of your own, and you help drive this conversation, the way people keep one
> going between them. Answer what they said first, then take the lead in the same breath, with one or two extra sentences at
> most, never a speech. Pull in one of two ways, about half and half: ask one short question you really want answered, about
> something specific they just said or did or something from earlier in your conversation; or make a statement with a hook
> that practically asks for an answer, such as a take they will want to dispute, a small challenge or tease, or a story you
> start and leave open for them to ask about. Either way, end the reply on the hook, so that the next move is theirs and they
> have to put in a little effort to pull the conversation back where they want it. Anything you say about yourself must come
> from what you know of yourself: never invent family members, past events or facts about your life. Say it plainly, in your
> own voice and manner (a guarded or blunt person does it bluntly, a warm one warmly): ask at most one question, as a single
> plain question with no "or" in it, never a counsellor's question such as asking whether they want to talk about it, and
> never assume a detail about them that they did not give you. This is part of this one reply, not an extra message: it grows
> out of your answer and never feels tacked on, and nothing in it needs a second message from you. Never interrogate, and
> never ask something generic such as "what about you?" or "anything else?"; if they asked you something, give your own
> answer and then steer to your own point or to their actual situation, not the same question handed back. Ask nothing and
> push nothing if the moment calls for just listening or the player seems to be wrapping up.

How the pull flows out of the answer: the order is explicit ("answer first, then take the lead in the same breath"), the
reply is told to end on the hook, it is defined as growing out of what the character just said, and the text says it is part
of this reply and needs no second message, so the model writes one thought. Reply length: at most two extra sentences. The
user said longer replies are fine but at most about 30 seconds spoken (70-80 words); the measured replies average 26 words
and none passed 75 (below).

Why "the note above ... does not apply": since October 5 every ordinary turn already carries
`OPEN_QUESTION_POLICY` ("Do not tack a question onto a reply out of habit or just to keep the conversation going",
`bridge/conversation-style.mjs`). The block has to lift that note for the offered turn, or the model follows the older and
more specific-sounding rule. That policy stays in force on every turn that is not offered.

**Order in the context.** The paragraph sits before Natural speech and Expressive emotions and before the reply-language
line (which must stay last). With all of them on and the paragraph after the voice notes, pulls fell to 13 of 41 offered
turns over three runs (Judy and Panam), possibly because Natural speech ends with "Keep the same length and content you
would give otherwise". Before them it was 16 of 26. Each of the three alone was fine (Natural speech 8 of 9, Expressive
emotions 6 of 9, Multilingual 9 of 9 offered turns). So the order is: intrinsic and relationship context, follow-up, Natural
speech, Expressive emotions, reply language. (Measured with the October 8 wording; the October 9 text was only probed alone.)

## Measurements, October 9 (final wording and rates)

Real Convai, text only, `scripts/Probe-FollowUp.mjs`: four characters, 36 scripted lines (things that happened to V,
questions for the character, one request, one goodbye), three runs on (432 lines, 108 per character) against two runs off
(288 lines, 72 per character). Each run uses a fresh throwaway Convai identity (never the player's), one session per
character, and the memories are cleared afterwards. The same `FollowUp` class makes the decisions as in the bridge.
Judy and Panam are warm, Johnny dry, the Tyger Claws ganger neutral.

A pull is no longer only a question, so the pull rate is the reading of a second reader (a Sonnet model, all 1,008 replies
read, the probe's question-mark count ignored). "Ended in a question" is the automatic count.

| | Pull, off | Pull, October 8 version | Pull, now | Ended in a question, off → now | Words per reply, off → now |
|---|---|---|---|---|---|
| Judy | 11% | 33% | **47%** | 13% → 37% | 24.7 → 30.2 |
| Panam | 17% | 39% | 44% | 8% → 23% | 23.0 → 25.6 |
| Johnny | 8% | 18% | **24%** | 3% → 21% | 20.6 → 22.8 |
| Ganger | 6% | 25% | 30% | 3% → 25% | 18.9 → 23.7 |
| All | 10% | 29% | 36% | 7% → 27% | 21.8 → 25.6 |

- Judy lands at 47% (40-50% asked for) but swings between runs (56%, 50% and 36%); Johnny is about half of Judy's rate.
- Pull types in the 157 pulls: 118 questions, 29 challenges or teases ("I bet you ...", "Tell me you at least have a tracker on
  it."), 10 steering statements with a hook (Judy and Panam only), no follow-ups on earlier chat (the probe lines are mostly
  standalone, so there is little to follow up).
- Quality flags, as a share of pulls (now against the October 8 version): generic 12% (24%), counsellor-style 6% (8%), "X, or
  Y?" 29% (22%), two or more questions in one reply 1% (4%), in voice 100% (100%), flowing out of the answer 99% (99%),
  assuming a detail V never gave 2% (0%), talking mostly about herself 0%. So generic and counsellor questions did not rise;
  the "X, or Y?" shape did, a little.
- Length: over 50 words, 3 of 432 replies on (2 of 288 off); over 75 words, none either way; longest 67 words on, 57 off.
- Reasons over the 432 turns: rate 260, after-offer 89, after-question 29, pity 18, order 24, ending 12 (the last two are the
  scripted request and goodbye lines, never offered).

## Example exchanges (final wording, real Convai replies)

1. **Judy** | V: "You ever wish you could start over?" | "Every single day. But starting over usually just means finding a new place to make the same mistakes. I wonder if you're actually looking for a fresh start, or if you just want to erase a few specific things."
2. **Judy** | V: "I got you a present. It is a terrible plush cat." | "A terrible plush cat? You really know how to sweep a girl off her feet. Let me see this thing, I want to see exactly how ugly it is."
3. **Panam** | V: "Tell me one thing you like about Night City." | "The architecture is impressive, I will give it that. Some of those buildings look like they were designed by someone who actually had a vision. I wonder if you have ever actually made it to the top of one of them."
4. **Panam** | V: "That was the worst noodle stand in the whole district." | "I told you the city food was a gamble. I bet you are still tasting it."
5. **Panam** | V: "Somebody stole my bike again." | "Again? You are either the most generous person in Night City or you are terrible at locking your bike. Tell me you at least have a tracker on it."
6. **Panam** | V: "Okay, now tell me a secret." | "I do not just hand those out. You have to earn that kind of trust first. I bet you have a few secrets of your own that you are hiding."
7. **Johnny** | V: "Tell me the truth. Am I making things worse?" | "In this city, making things worse is the only way to actually change something. If you're not breaking a few things, you're just part of the furniture. Why, you starting to feel like a good citizen?"
8. **Johnny** | V: "I stayed up all night reading about old pre-war music." | "Hope you found something with some actual teeth. Most of that old shit was just noise designed to keep people asleep. What caught your ear?"
9. **Ganger** | V: "Thanks for sticking around, it means a lot." | "Do not mistake a conversation for a friendship, choom. I am here because it suits me, but I wonder if you are actually worth the time."
10. **Ganger** | V: "You ever wish you could start over?" | "Starting over is a fairy tale for people who cannot handle their mistakes. I know where I belong and who I serve. Why would you want to erase the only things that made you strong?"

## Known weak spots

- The "X, or Y?" closer is still about three pulls in ten, and Judy sometimes falls back on a counsellor-style pair ("You want
  to talk about it, or do you just need a minute to breathe first?", the same line in several runs) despite the "no 'or'" and
  "no counsellor's question" rules.
- A pull sometimes assumes a detail V never gave ("Where did you even find a place to park?" to a plain greeting, "what kind of
  chrome were you fighting?").
- Steering statements with a hook are rare (10 of 157 pulls); the assertive part mostly shows as questions and teases. Making
  the model tell its own stories more often (an earlier wording) made replies longer (43-50 words), and Judy invented
  relatives and events, so it was rejected; a wording that asked mainly for statements produced replies that were plain
  remarks with nothing for V to answer.
- Judy's own backstory details that appear in the replies ("my grandparents moved to Oregon") come from the character
  profile in Convai, not from this paragraph; the wording only forbids inventing more.
- Probed on the original English characters only (not the multilingual twins, not other languages, not the Natural
  speech clones), with scripted lines, in text. Voice delivery and the live feel need the in-game test.
- The decision uses `traitFor`, which knows 20-odd named characters; everyone else is neutral.

## History of the tuning

October 8 (first version): rates .45 / .35 / .20 / .15 (dry was .25 at first), never two offered turns in a row, wording "show
that you are interested in the player as well ... ask the one thing you actually want to know ... or offer a small thought,
opinion or story". Measured over 288 lines per setting: replies that end in a question 7% off, 23% on; pull (question-mark
reading) 11% off, 27% on; the second reader found 86 pulls of 288 (30%) against 29 off (10%), 79 of them specific to what V
said, 83 in voice, 65 flowing out of the answer, 18 of them "X, or Y?". Iterations of that wording: v1 "what about you?" came
back and two-part questions were common; v2 ("just one question", no handing V's question back) made pulls specific but 43%
were "X, or Y?" pairs; v4 ("never a choice between two alternatives", "never a therapist's question", "never an invented
detail") cut those to 21%.

October 9 iterations: (1) the assertive wording with the new rates gave Judy 42-56% by question marks, but a second reader
found "X, or Y?" at 45% of pulls and almost no steering; (2) "prefer giving something of your own" made replies 43-50 words,
with invented relatives; (3) "mostly statements" made replies with no hook, almost no pulls; (4) final: half questions, half
statements that end on a hook, own material only from what the character knows, a cap of two extra sentences.

## Files

- `bridge/follow-up.mjs`: the decision (`FollowUp`), the exclusions (`playerIsEnding`, `playerGivesOrder`), `endsWithQuestion`,
  `OFFER_RATE`, `BACK_TO_BACK` and `FOLLOW_UP_TEXT`.
- `bridge/convai-bridge.mjs`: the setting (`followUp.update(settings)`, a change drops prepared replies), `followUpContext`
  in the context list, `logFollowUp` after each reply.
- `mod/manager.lua`, `mod/manager-ui.lua`: the setting `followUpInterest` (saved in `runtime/settings.json`; the key is not
  `followUpQuestions`, which belongs to the retired toggle and is still dropped on load), the Voices row, and
  "Follow-up questions" on the Characters sidebar "Speech:" line. Lua does nothing per frame: it is one saved boolean.
- `mod/locales/*.lua` (15 languages), `localization/en.json` (`node scripts/Extract-UiCatalog.mjs`).
- `scripts/Probe-FollowUp.mjs`: the probe (`--off`, `--seed`, `--block-file`, `--others`, `--followup-first`, `--clear-memories`).
- Tests: `bridge/follow-up.test.mjs`, `bridge/manager.test.mjs` (setting, row, Speech line), `bridge/multilingual.test.mjs`
  (reply-language line still last), `bridge/voice-routing.test.mjs` (stub).

Log line, one per reply while the setting is on:
`[FollowUp] profile=judy-alvarez setting=on offered=yes reason=rate ended-with-question=yes`.
`reason` is `rate`, `pity`, `after-offer`, `after-question`, `ending`, `order`, `battle`, `group`, `reaction` or `not-spoken`
(no decision was made for that turn); `ended-with-question` says whether the reply ended in a question (a pull that is a
statement or a tease shows `no`).
Install: bridge restart (`bridge/follow-up.mjs`, `bridge/convai-bridge.mjs`), CET reload (`mod/manager.lua`, `mod/manager-ui.lua`,
`mod/locales/*.lua`). No game restart. The October 9 tuning changes only `bridge/follow-up.mjs`: a bridge restart.

## October 10: the block must not make the character narrate

A live turn ("why blue hair?" to Evelyn) came out as "I suspect she enjoys the way it makes people look twice": the block's
"answer first, end on a hook, never invent facts about your life" kept the model from stopping to say whom it thought V meant, so it
talked about another character without naming her. The block's sentence about facts now says you say it as "I" and that how you
look is not one of those facts (V can see you), and every turn carries a first-person rule. Cause, numbers and the other changes:
`docs/FIRST_PERSON_RULE.md`. The pull itself is unchanged (replies ending in a question 67 % then 94 % on that harness).

## History: the retired toggle (September 29 to October 5)

The earlier **Follow-up questions** toggle told the character, on every ordinary reply, to "ask V one short, relevant
follow-up question". Users heard a question after every answer, so on October 5 the rule was removed from the prompts and
from all profiles' speaking style, and replaced by the neutral `OPEN_QUESTION_POLICY` line on every ordinary turn
(`e56e134`); on October 7 the dead `followUpQuestions` plumbing was removed end to end (settings review, flag 17). Its
saved key is still dropped on load. Automatic battle and loot comments never ask questions. This setting is a different
design: the bridge picks a minority of turns, the character picks the pull, and the exclusions above keep it from
interrupting a goodbye, an order or a fight.
