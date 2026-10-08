# Follow-up questions

October 8, 2026. A new, optional setting that makes a conversation feel two-sided: now and then the character shows
real interest in V and pulls the conversation along, like a tug where each side keeps the other engaged. It replaces the
retired toggle of the same name (see "History" at the end), which asked every reply to end with a question.

**Companion Manager > Settings > Voices > Follow-up questions**, next to Natural speech and Expressive emotions. Off by
default. Unlike those two it needs no local voice: it works with Pocket, OmniVoice and the Convai cloud voice, in private
text and microphone conversations and in phone Chat.

## What it does

When the setting is on, the bridge adds one short paragraph to the dynamic context of about a quarter of the turns. The
character reads it, answers first, and then, if the moment fits, turns the answer back toward V: one specific question
about what V just said or did, a follow-up on something from earlier, or a small thought, opinion or story that invites a
reply. It stays inside the reply Convai is already generating:

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

| Character (`traitFor`) | Chance on an eligible turn |
|---|---|
| warm | .45 |
| neutral | .35 |
| dry | .20 |
| cold | .15 |

- Never on two turns in a row, so the share of offered turns is lower than the chance (about 28% warm, 28% neutral, 10% dry
  measured).
- Pity rule: a warm or neutral character is offered a pull at least once in any 5 conversation turns, when one is allowed.
- A dry or cold character (Johnny, Rogue, Takemura, ...) stays rare on purpose.

Never offered on (the log line gives the reason):

| `reason=` | Turn |
|---|---|
| `reaction` | An automatic reaction or bark (battle, loot, distraction). It is not a conversation turn and changes no state. |
| `battle` | V's text while `input.battle.status` is `fighting`. |
| `group` | A group round (F8/F9): several characters answer, and only one may speak for the others. |
| `ending` | V is saying goodbye or wrapping up (English, Spanish, Portuguese, French, German, Italian, Japanese, Korean, Chinese, Russian, Ukrainian and a few more; a short list of farewells, not a language model). |
| `order` | V gives an order or makes a request of the companion: follow me, wait here, go home, take me there, get in the car, you can go (same languages). A question such as "can you explain ..." is not one. |
| `after-offer` | The previous turn was offered. |
| `after-question` | The character's previous reply already ended in a question. |

There is no pre-turn detector of companion actions in the bridge (the actions are offered to the model, which decides
that V meant one), so the order and goodbye checks are word lists. A microphone turn carries the placeholder
"[Microphone]" until the speech is recognized, so on those turns the checks cannot see the words and only the sentence
"ask nothing if the moment calls for just listening or the player seems to be wrapping up" protects them (not measured:
the probes always carry the text, so the bridge checks apply).

## The wording

Final text (`FOLLOW_UP_TEXT`), appended as one paragraph:

> For this reply only, the note above about not asking questions to keep the conversation going does not apply: show that
> you are interested in the player as well, the way people keep a conversation going between them. Answer what they said
> first, then turn it back toward them in the same breath, or end with one short line that draws them in: ask the one
> thing you actually want to know about what they just said or did, pick up something from earlier in your conversation,
> or offer a small thought, opinion or story of your own that invites a reply. Say it plainly, in your own voice and manner
> (a guarded or blunt person does it bluntly, a warm one warmly): one question at most, never a choice between two
> alternatives for them to pick from, never a therapist's question, and never a detail they did not give you. This is part
> of this one reply, not an extra message: it grows out of your answer and never feels tacked on, and nothing in it needs a
> second message from you. Never interrogate, and never ask something generic such as "what about you?" or "anything
> else?"; if they asked you something, give your own answer and ask about their actual situation, not the same question
> handed back. A pull does not have to be a question. Ask nothing if the moment calls for just listening or the player
> seems to be wrapping up.

How the pull flows out of the answer: the order is explicit ("answer first, then turn it back toward them in the same
breath, or end with one short line"), the pull is defined as growing out of what the character just said, and the text
says it is part of this reply and needs no second message, so the model writes it as one thought. A shared opinion or a
teasing challenge counts as a pull, which is what Johnny and the Tyger Claws ganger do ("Why spend your night on ghosts
when the real noise is right here?"). Reply length is not constrained (the user said longer replies are fine, up to about
30 seconds spoken); the wording never asks for more or less, and the measured replies stay short (below).

Why "the note above ... does not apply": since October 5 every ordinary turn already carries
`OPEN_QUESTION_POLICY` ("Do not tack a question onto a reply out of habit or just to keep the conversation going",
`bridge/conversation-style.mjs`). The block has to lift that note for the offered turn, or the model follows the older and
more specific-sounding rule. That policy stays in force on every turn that is not offered.

Iterations (`scripts/Probe-FollowUp.mjs`, `--block-file` compares a wording without editing the module):

1. First wording (v1): pulls on 7 of 10 offered turns for Judy, but "what about you?" came back, two-part questions were common.
2. v2: "just one" question, no handing V's own question back. Pulls became more specific (9 of 10), but 43% were an
   "X, or Y?" pair, a pattern a reader quickly hears as a tic.
3. v4 (final): one question at most, never a choice between two alternatives, never a therapist's question, never an
   invented detail, and "a pull does not have to be a question". The "or" pairs fell from 43% to 21% of pulls.

**Order in the context.** The paragraph sits before Natural speech and Expressive emotions and before the reply-language
line (which must stay last). With all of them on and the paragraph after the voice notes, pulls fell to 13 of 41 offered
turns over three runs (Judy and Panam), possibly because Natural speech ends with "Keep the same length and content you would give otherwise". Before them it was 16
of 26. Each of the three alone was fine (Natural speech 8 of 9, Expressive emotions 6 of 9, Multilingual 9 of 9 offered
turns). So the order is: intrinsic and relationship context, follow-up, Natural speech, Expressive emotions, reply language.

## Measurements

Real Convai, text only, `scripts/Probe-FollowUp.mjs`: four characters, 36 scripted lines (things that happened to V,
questions for the character, one request, one goodbye), two runs each for off and on, so 72 lines per character per
setting and 288 per setting. Each run uses a fresh throwaway Convai identity (never the player's), one session per
character, and the memories are cleared afterwards. The same `FollowUp` class makes the decisions as in the bridge.
Judy is warm, Panam warm, Johnny dry, the Tyger Claws ganger neutral.

| | Ended with a question, off | on | Pull in the last two sentences, off | on | Words per reply, off | on |
|---|---|---|---|---|---|---|
| Judy | 13% | 31% | 15% | 35% | 24.7 | 25.9 |
| Panam | 8% | 26% | 13% | 29% | 23.0 | 25.2 |
| Johnny | 3% | 14% | 11% | 18% | 20.6 | 23.2 |
| Ganger | 3% | 22% | 7% | 25% | 18.9 | 24.0 |
| All | 7% | 23% | 11% | 27% | 21.8 | 24.6 |

- Offered turns: 23% of all turns (Judy 28%, Panam 26%, Johnny 10%, ganger 28%); the model made a pull on 53 of 66 offered
  turns (80%); the ones it declined were mostly grief or a request, which is what the wording allows.
- Turns not offered also show some pulls (the baseline habit, plus the earlier pulls in the conversation as examples).
- Reply length: over 50 words, 2 of 288 replies off, 1 of 288 on; over 75 words, none either way; longest 57 off, 51 on.
- Reasons over the 288 turns on: rate 172, after-offer 61, pity 16, order 16, after-question 15, ending 8. Never two offered
  turns in a row.
- A warm character pulls in about 30-40% of lines (Judy 35%, Panam 29%), Johnny about half as often as Judy (18%).

A second reader (a Sonnet model) read all 576 replies of the final runs and judged the pulls against the character:
the pull rate went from 10% (29 of 288) to 30% (86 of 288); of the 86, 79 were specific to what V said, 83 sounded like the
character, 65 flowed out of the answer (21 felt bolted on, mostly the "X, or Y?" closer, 18 in all), and 2 invented a
detail V had not given. The weakest cases are listed under "Known weak spots".

With Natural speech, Expressive emotions and Multilingual all on, the voice tags and `{emotion}` marks of the other
settings came out as usual next to the pulls (see "Order in the context" for the pull rate in that combination).

## Example exchanges (final wording, real Convai replies)

1. **Judy** | V: "I keep dreaming about the old neighborhood." | "I know that feeling. Sometimes the memories of where you came from are the only things that feel real when everything else is just neon and noise. What part of it keeps coming back to you?"
2. **Judy** | V: "Somebody stole my bike again." | "Again? You've gotta start parking that thing in a vault or something. You have any lead on who took it this time?"
3. **Panam** | V: "Somebody stole my bike again." | "Again? You really need to start using a better lock, or just start breaking the fingers of whoever keeps touching your gear. Do you know where it went?"
4. **Panam** | V: "Honestly, I was scared out of my mind back there." | "Being scared is what keeps you alive. It means you know exactly how high the stakes are. When did you realize you were in over your head?"
5. **Panam** | V: "Okay, now tell me a secret." | "I do not just hand those out. If you want a secret, you have to earn it. Or you can tell me one of yours first and we can see who is more honest."
6. **Johnny** | V: "You ever wish you could start over?" | "Start over? I'd just end up in the same fight, just with a different set of scars. The only way to start over in this city is in a crematorium. You thinking of scrubbing the slate clean?"
7. **Johnny** | V: "Tell me the truth. Am I making things worse?" | "In this city? You're probably making things worse for someone. That's how you survive. The real question is if you're making them worse for the right people."
8. **Ganger** | V: "Be honest with me: do you trust me?" | "Trust is a word for people who don't live in Night City. I don't trust anyone I can't see the chrome on. Why would you think you're any different?"
9. **Ganger** | V: "Okay, now tell me a secret." | "Secrets are currency, choom. You have not given me anything worth a trade. What are you offering in exchange?"
10. **Ganger** | V: "I stayed up all night reading about old pre-war music." | "Waste of time. The old world burned for a reason, and its music is just echoes of a dead city. Why spend your night on ghosts when the real noise is right here?"

## Known weak spots

- The "X, or Y?" closer still appears in about one pull in five (Judy most), and Judy and Panam drift toward counsellor
  questions now and then ("What part of it keeps coming back to you?").
- Rarely a pull invents a detail ("You look like you've seen some action lately" to a plain greeting) or hands "what about
  you?" back after V asked the character something.
- Probed on the original English characters only (not the multilingual twins, not other languages, not the Natural
  speech clones), with scripted lines, in text. Voice delivery and live feel need the in-game test.
- The decision uses `traitFor`, which knows 20-odd named characters; everyone else is neutral.

## Files

- `bridge/follow-up.mjs`: the decision (`FollowUp`), the exclusions (`playerIsEnding`, `playerGivesOrder`), `endsWithQuestion`
  and `FOLLOW_UP_TEXT`.
- `bridge/convai-bridge.mjs`: the setting (`followUp.update(settings)`, a change drops prepared replies), `followUpContext`
  in the context list, `logFollowUp` after each reply.
- `mod/manager.lua`, `mod/mcm.lua`: the setting `followUpInterest` (saved in `runtime/settings.json`; the key is not
  `followUpQuestions`, which belongs to the retired toggle and is still dropped on load), the Voices row, and
  "Follow-up questions" on the Characters sidebar "Speech:" line. Lua does nothing per frame: it is one saved boolean.
- `mod/locales/*.lua` (15 languages), `localization/en.json` (`node scripts/Extract-UiCatalog.mjs`).
- `scripts/Probe-FollowUp.mjs`: the probe (`--off`, `--seed`, `--block-file`, `--others`, `--followup-first`, `--clear-memories`).
- Tests: `bridge/follow-up.test.mjs`, `bridge/manager.test.mjs` (setting, row, Speech line), `bridge/multilingual.test.mjs`
  (reply-language line still last), `bridge/voice-routing.test.mjs` (stub).

Log line, one per reply while the setting is on:
`[FollowUp] profile=judy-alvarez setting=on offered=yes reason=rate ended-with-question=yes`.
`reason` is `rate`, `pity`, `after-offer`, `after-question`, `ending`, `order`, `battle`, `group`, `reaction` or `not-spoken`
(no decision was made for that turn); `ended-with-question` says whether the reply ended in a question.
Install: bridge restart (`bridge/follow-up.mjs`, `bridge/convai-bridge.mjs`), CET reload (`mod/manager.lua`, `mod/mcm.lua`,
`mod/locales/*.lua`). No game restart.

## History: the retired toggle (September 29 to October 5)

The earlier **Follow-up questions** toggle told the character, on every ordinary reply, to "ask V one short, relevant
follow-up question". Users heard a question after every answer, so on October 5 the rule was removed from the prompts and
from all profiles' speaking style, and replaced by the neutral `OPEN_QUESTION_POLICY` line on every ordinary turn
(`e56e134`); on October 7 the dead `followUpQuestions` plumbing was removed end to end (settings review, flag 17). Its
saved key is still dropped on load. Automatic battle and loot comments never ask questions. This setting is a different
design: the bridge picks a minority of turns, the character picks the pull, and the exclusions above keep it from
interrupting a goodbye, an order or a fight.
