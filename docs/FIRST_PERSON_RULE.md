# Speaking as "I": the third-person leak (October 10, 2026)

## What the user heard

Evelyn Parker, asked "why blue hair?" (request `1791575306-1-11150607ULL`, OmniVoice, settings: Natural speech, Follow-up
questions and Expressive emotions all on): "It is a choice, and a loud one. I suspect she enjoys the way it makes people look
twice before they realize she is the one in control. Do you usually go for something that screams for attention, or do you
prefer to blend in?" To the player it sounded like Evelyn narrating herself.

## Cause (reproduced offline)

It was not one block written in the third person. Three things lined up, and the first is the one that made the turn odd:

1. **The journal block pulled in an unrelated quest.** `selectJournalHistory` (`bridge/journal-history.mjs`) matches the player's
   words against quest titles and objectives. "blue" matched the objectives of "Every Breath You Take" ("wait for Blue Moon",
   "Don't let Blue Moon get hurt"), and "why" matched "Find out why the NCPD dropped the investigation" in a second quest. The
   context of that turn (rebuilt from `runtime/last-input.json`) therefore carried a block of third-person quest data about a
   woman named Blue Moon, on a question about hair.
2. **Evelyn's profile has no hair.** Convai's model reads "blue hair" as Judy's (it knows her) and answers about Judy. With no other
   blocks it says so out loud ("You're asking about Judy. It suits her"). The player's premise (Evelyn does look like that) is
   true in the game, but nothing in the context says it.
3. **The Follow-up block wins the format.** "Answer first, take the lead, end on a hook, never invent facts about your life" keeps
   the model from stopping to say whom it thinks V means, so the reply opens "It is a choice" and then talks about Judy, often
   without her name. That is the leak the user heard: a pronoun with no antecedent, in a reply that sounds like it is about the
   speaker.

The Convai profile text (`characters/profile-text/*.txt`) is itself third person for 71 of 80 characters ("Evelyn is a Night City
doll... she studies people"), and `bridge/natural-speech-talk.mjs` labelled each line "How Evelyn Parker talks:". Neither alone
leaked (see the rates below), but they are why a narrator's voice is always close. The profile text was not touched (see below).

## Reproduction

`scripts/Probe-ThirdPerson.mjs` (text-only Convai turns, one fresh session per sample, blocks forced on, one fixed test
end-user id `third-person-probe-fixed` with its memories wiped after every job; never the player's) and
`scripts/Summarize-ThirdPerson.mjs`. Replies were labelled by one Haiku agent per batch: `self3` (the speaker describes herself in
the third person, or says "she" about someone never named), `other` (about a named third party), `ok`.

The 19:48 turn's real context, "why blue hair?", Evelyn, 10 to 20 turns per row (the model is close to deterministic, so repeats
mostly repeat). Third person about someone = `self3` + `other`:

| blocks on (all with the Blue Moon rows) | before | rules only | rules + reminder | + retrieval fix |
| --- | --- | --- | --- | --- |
| none (base context only) | 20/20 "You're asking about Judy" | 0/20 | 0/20 | 0/10 |
| Follow-up + Natural + Expressive (live) | 10/20 | 0/20 | 0/20 | 0/10 |
| Follow-up + Expressive | 10/10, near-verbatim to the live line ("I suspect Judy enjoys the way it makes people look twice") | 0/10 | 0/10 | 0/10 |
| Natural + Expressive | 10/10 | 10/10 ("I assume you are talking about Judy") | 2/10 | 0/10 |
| Follow-up only | 5/10 | 0/10 | 0/10 | 0/10 |
| Natural only | 0/10 | 9/10 | 3/10 | 0/10 |
| Expressive only | 10/10 | 1/10 | 0/10 | 0/10 |

Without the journal rows, before any rule, the same question was mostly answered in the first person ("It is a choice. I imagine it
makes me a bit harder to forget"), or with "I don't have blue hair. I suspect you're thinking of Judy".

Broad check, six characters (Evelyn, Judy, Johnny, Panam, Takemura, Dexter), 48 to 60 turns per condition, no journal rows: ten
questions about themselves ("tell me about yourself", "what is your deal", "why are you so guarded"...) and eight phrasings of
"why blue hair?". Third-person self-reference was already near zero before (0 to 2 %: the one real case is Panam "a nomad who wants
her family to be free") and stays there; the profile text and the old blocks do not leak on ordinary self questions. After the fix
the only labelled cases are Dexter's and Takemura's "a man in my position" idiom (first person, kept). So the measurable failure
is the one above: a question that presupposes a trait the profile lacks, plus extra context about another person.

## The fix

* `bridge/journal-history.mjs`: question and function words ("why", "who", "was"...) and colour and body words ("blue", "red",
  "hair", "eyes", "jacket"...) never match a quest. A quest's own name words still do ("what about Blue Moon?" matches).
* `bridge/quest-context.mjs` `SPOKEN_OUTPUT` (every turn): speak in the first person, never as a narrator; never your own name
  or she/he/they about yourself; V is looking at you, so what V says about how you look is about you even if your profile never
  mentions it, never ask or guess whether V means someone else. And `FIRST_PERSON_REMINDER`, one sentence appended by
  `bridge/convai-bridge.mjs` after the voice blocks (they pull a reply away from the base rule) and before the reply-language
  line; not sent on automatic reactions.
* `bridge/follow-up.mjs`: the "never invent facts about your life" sentence now says you say it as "I", and that how you look is
  not one of those facts.
* Third-person phrasing removed from the other blocks: `bridge/natural-speech-talk.mjs` ("How you talk:" for every character, never
  "How Evelyn Parker talks:"), "this character" in `bridge/natural-speech.mjs`, "an annoyed character" and "characters show
  less" in `bridge/emotion-tags.mjs`, and the intrinsic topic header in `bridge/intrinsic-character-context.mjs` ("these facts are
  about you ... say it as yourself").
* Not changed: the romance cues in `bridge/romance-context.mjs` are third person ("Judy's affection comes out sideways...") but
  measured clean (1 of 50 replies, the same Panam "her family" case, with and without the block).

## Benefits kept (same harness, blocks forced on, 48 to 60 turns per condition, before then after)

* Expressive emotions: reply starts with a tag 100 % then 100 %; any tag 100 % then 100 %.
* Natural speech: a voiced sound or pause in 94 to 98 % then 95 to 100 %.
* Follow-up: replies ending in a question 57 % then 73 % with all three blocks (general questions), 67 % then 94 % Follow-up
  alone (blue-hair phrasings). The pull is not weakened. Side effect: with no block at all, replies to the blue-hair phrasings
  end in a question more often (15 % then 40 %), mostly a tease back about the look ("You like it, or is it too much for you?"),
  because the character now accepts the premise instead of asking whom V means.

## What is still open

* The model cannot know how a companion actually looks. A question about a visible trait the profile lacks is answered by
  accepting it, or denying it ("I don't have blue hair") in the first person. A real fix is a per-companion appearance line
  (hair, clothes) from the spawned appearance in the dynamic context; the game adapter gives none today.
* Residual: with the old journal rows present, Natural speech alone still produced an unnamed "she" in 2 to 3 of 10; with the
  retrieval fix those rows are not summoned by this kind of question.
* The profile texts of 71 characters are third person. Rewriting them in the second person ("You are Evelyn...", as the nine
  that already are) would remove the root of the narrator voice, but it means re-uploading every Convai character and
  re-measuring; not done here.

## Install

Bridge restart only (`bridge/*.mjs`). No game restart, no CET reload.
