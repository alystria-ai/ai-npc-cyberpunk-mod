# Quest briefing recipe (for a helper writing a batch)

You write quest briefings for `research/cyberpunk/quest-briefings.json` (format and purpose: `docs/QUEST_BRIEFINGS.md`). When V asks the
person who gave a job "what now?", the mod picks the stage V is at from the journal objectives that are active and hands that character a
short note: the job, where V is, what comes next. Your batch is a list of quest paths. You write one part file,
`research/cyberpunk/parts/batch-NN.json`, and nothing else (part files are scratch: the lead reviews and merges them, and they are not
committed).

All commands run from the repository root (or the root of the worktree the lead names).

## Hard rules

- Write only your own part file. Do not edit any other file, do not run git, do not commit.
- Do not spawn agents. Do not run `find /` or walk the disk or `node_modules`. Stop any background job you start. Never print or read secrets.
- Copyright: read the walkthroughs to learn the facts, then write short sentences of your own. No quotes, no dialogue, no sentence or
  phrase taken from a web page. Never copy the game's English objective text (what `quest_outline.py` prints) into any field: say it
  differently ("Neutralize Big Pete." becomes "deal with Pete").
- Cyberpunk wiki on fandom.com answers HTTP 402: do not use it. PowerPyx, Gamer Guides, Fextralife, IGN and Sportskeeda work.

## Procedure, per quest

1. **Outline.** `python -I -X utf8 research/cyberpunk/scripts/quest_outline.py --path <quest path>` prints the objectives in **journal file
   order** (not play order) as `phase/objective  (optional) text`. The first column is the exact objective path you put in `objectives`.
2. **Read two walkthroughs.** Search (`WebSearch`: `Cyberpunk 2077 <title> walkthrough`), then `WebFetch` two pages with a prompt like:
   "Summarize this job step by step in play order: who gives it, the client, the target, the places, each step, the branches and what
   triggers them, the tips. Mark which facts are late reveals or twists." Good URL patterns:
   - PowerPyx: `https://www.powerpyx.com/cyberpunk-2077-<title-slug>-walkthrough/` (gigs: `...-<slug>-gig-walkthrough/`). If it 404s, search.
   - Gamer Guides gigs: `https://www.gamerguides.com/cyberpunk-2077/guide/gigs/<watson|westbrook|heywood|santo-domingo|badlands|pacifica>/<slug>`;
     Phantom Liberty gigs and main jobs: search, their slugs are long.
   - Fextralife: `https://cyberpunk2077.wiki.fextralife.com/<Title+With+Plus+Signs>`.
   If no guide anywhere has the quest after two searches, it is probably cut content: skip it (step 8). If only one source exists, write it
   from that one plus the outline and say so in your final report.
3. **Who gives it.** List the roster keys once: `node -e "for (const r of require('./characters/roster.json')) console.log(r.key, '|', r.name, '|', (r.aliases||[]).join(','))"`.
   - `givers`: the roster person who hands V the job or directs it (the fixer for a gig; the person who asks V for a main or side job; a
     companion who leads the job). The candidate in your batch list is a guess: check it on the walkthrough. A gig in one district is
     sometimes given by another fixer.
   - `knowers`: roster people who are on V's side in the job and could explain it (the client, a partner, a companion who is there).
     Never the target or an enemy. A giver is never also a knower. Johnny only when it is his own job (he asks V for it).
   - If nobody in the roster gives or leads the job, skip it with the reason "giver X not in the roster".
4. **Play order and stages.** From the walkthrough, write the steps in play order, then put every objective path from the outline (optional
   ones too) into the step where it becomes active. Group neighbouring steps into stages (rules below). 3 to 8 stages for a gig, up to
   14 for a long main job; at most 24 objectives per stage.
5. **Write the text** (field rules below), giver's point of view, plain English.
6. **Sources.** Add each page you read to `sources` with a short id: `pp-<slug>`, `gg-<slug>`, `fx-<slug>`, `ign-<slug>`, `sk-<slug>`
   or another short site prefix (slug = the quest title in kebab case), and list those ids in the quest's `sources`.
7. **Validate** after every quest: `node research/cyberpunk/scripts/build_quest_briefings.mjs --fragment research/cyberpunk/parts/batch-NN.json`.
   Fix every `error:` and every `warning:` (a warning lists a non-optional objective you left out of all stages: place it) until it prints
   `fragment ok`. Never leave the file invalid when you move on.
8. **Skipped quests** go in the part file's `skipped` array: `{"path": "...", "title": "...", "reason": "..."}`.

## Part file shape

```json
{
  "sources": {"pp-olive-branch": {"url": "https://...", "title": "PowerPyx: Cyberpunk 2077 Olive Branch Gig Walkthrough", "accessed": "2026-10-26"}},
  "quests": {"<quest path>": {"title": "...", "givers": [], "knowers": [], "overview": "...", "spoiler": "none", "sources": [], "stages": [], "persistent": []}},
  "skipped": []
}
```

## Field checklist

- `title`: the quest name as the outline prints it (gigs keep the `Gig: ` prefix). Max 80.
- `givers`: 1+ roster keys. `knowers`: 0 to 6 roster keys, none of them a giver.
- `overview`: one sentence, max 220: the job as V hears it at the start (who wants what, where). Third person ("Wakako has V drive..."), no twist.
- `spoiler`: `"light"` if any stage names a place or person V has not met yet at that point; otherwise `"none"`.
- `sources`: ids that exist in the file's `sources`.
- `persistent` (optional, max 8): only an objective that clearly stays active the whole job and restates the whole job (a parent objective like
  `.../main` or "Rescue Hal"). If unsure, put it in the first stage instead. Omit the field when empty.
- `stages[]`, in play order, each with:
  - `id`: unique kebab-case (`meet-sergei`, `chase-the-van`).
  - `objectives`: exact paths from the outline; each path in exactly one stage (or in `persistent`).
  - `now` (max 200): where V is right now in this stage, starting "V is ...".
  - `ahead` (max 280): the next step or two as the giver would lay out the plan. The last stage says there is nothing more to do and who
    wraps up ("Nothing more to do once V is out; Dakota closes the job.").
  - `places` (0 to 3, each max 60), `people` (0 to 3, each max 60): what matters at this stage. Names only V can know by now.
  - `tips` (0 to 2, each max 150): practical advice (routes, a skill check, a weak spot, what not to break). Never a reward or a "best" choice.
- Text: plain characters only. No `< > { } [ ]` or backticks, no double spaces, no line breaks, no leading or trailing space. No words
  "quest", "objective", "journal", "mission". No dialogue, no quotes, no numbers of eddies or XP.

## Stage grouping (journal order is not play order)

- The journal lists objectives by file, not by time: in Olive Branch the trunk objectives come after the drive in the file but happen in the
  middle of it, and the diner talk is listed before the drive. Always order by the walkthrough.
- How the mod picks a stage: the stage holding the tracked objective, else **the last stage in your list** that has an active non-optional
  objective. So:
  - Stages must be in play order.
  - Objectives that are active at the same time (a "drive there" objective still open while a trunk event fires) are fine in different
    stages: the later stage wins, which is what you want.
  - A stage must never come before a step that happens earlier, or the note jumps ahead.
- Alternatives at the same moment (front door / back door, kill / spare, two ways to open a door) go in the **same** stage.
- A branch-only objective that fires only on one path (a failure, a fight if talks break down, "tell X the doctor is dead") gets its own
  stage right after the point where it happens, with `now` text that is only true on that path (it is shown only when that objective is
  active). Example: `diner-fight` in Olive Branch, `tell-odell` in Dogtown Saints.
- Talk / follow / get-in-the-car / leave-the-area objectives join the stage they belong to; a final "leave the area" can be its own last stage.
- One giant stage for a long job is wrong; one stage per objective is also wrong. A stage = one place or one task V would describe in a sentence.

## Spoiler rule

The stage choice already hides later stages; your text is the second guard.
- `overview` and every `ahead`: only what the giver would plan or know beforehand. Never a twist, a betrayal, a death, a secret identity,
  who is really behind it, the outcome of a choice, which choice is better, a reward, or the fact that something hidden is waiting (the man
  in the trunk, the brainwashing, the malware) before V finds it.
- `now` may name what V has just seen or learned at this stage, because V knows it already (`the-trunk`: "found a man inside").
- An `ahead` never announces an attack, an ambush, a chase, a breakdown or a person who turns up unexpectedly (the most common slip in the
  first full run): "Before the talk gets anywhere, a sound at the door cuts it short" becomes "V helps Takemura make his case to Hanako". The
  attack belongs in the `now` of the stage where it is active.
- At a choice, stay neutral: "V decides what to do about him", "however that meeting goes, V then...". Do not list the options' results.
- A giver who is part of the secret must not give it away: in Dream On both Peralezes are givers, so the text never says what the van held
  or that Elizabeth meets V alone to hide something; it says "V goes over the findings" and "meets Elizabeth to talk them over".
- Endings and epilogues: describe only the step V is on; never which ending it is or what it leads to.

## Worked examples

Read these entries before you start; they are the standard:
- `research/cyberpunk/quest-briefings.json` (pilot): `quests/street_stories/watson/northside_industrial_district/sts_wat_nid_01`
  (Occupational Hazard: a simple gig, one `persistent`), `quests/main_quest/act_01/q103_warhead` (Ghost Town: a long main job in 10 stages).
- The recipe's own examples, in the same file: `quests/street_stories/badlands/inland_avenue/sts_bls_ina_02` (Big Pete's Got Big Problems:
  gig, an umbrella objective kept in the first stage), `ep1/quests/street_stories/sts_ep1_01` (Dogtown Saints: Phantom Liberty gig with a
  standoff and a failure-only last stage), `quests/street_stories/wesbrook/japan_town/sts_wbr_jpn_01` (Olive Branch: journal order vs play
  order, a twist kept out of `ahead`, a knower), `quests/main_quest/act_01/q110_voodoo` (I Walk the Line: main job with two branches that
  share stages), `quests/side_quest/sq006_dream_on` (Dream On: side job whose twist both givers share).

Olive Branch, journal order of the outline vs the stages written:

| Journal order | Stage |
| --- | --- |
| meet | meet-sergei |
| get_inside | drive-car |
| drive | drive-car |
| check (optional) | drive-car |
| talk | hand-over |
| get_inside_garage | drive-car |
| talk_sergei | meet-sergei |
| talk_bound (optional) | the-trunk |
| leave_diner | leave-diner |
| leave_car_gift | hand-over |
| defeat_tc | diner-fight (only if talks break down) |
| open_trunk | the-trunk |
| park | drive-car |
| free_alex | the-trunk |
| talk_with_alex | the-trunk |

Its first stage, as written (note the `ahead`: it plans the delivery and says nothing of what is in the trunk):

```json
{"id": "meet-sergei", "objectives": ["sts_wbr_jpn_01/meet", "sts_wbr_jpn_01/talk_sergei"],
 "now": "V is meeting Sergei Karasinsky outside his garage in Japantown.",
 "ahead": "Sergei hands over the car in the garage, and V drives it to the Tyger Claws' diner to deliver it as his peace gift.",
 "places": ["Sergei's garage, Japantown"], "people": ["Sergei Karasinsky"], "tips": []}
```

## Before you finish

- The part file passes `--fragment` with no errors and no warnings.
- Read every `ahead` once more against the spoiler rule, and every stage order against the walkthrough.
- Report: quests written, quests skipped (reason), any quest written from one source only, any giver you changed from the candidate, and any
  stage you were unsure about.
