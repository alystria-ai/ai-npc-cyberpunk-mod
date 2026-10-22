# Response audit

Drives the bridge's own prompt-building code for a fixed set of scenarios, sends each to a conversation provider and keeps the exact prompt, the reply, its length, its latency and its token counts, so the quality of the replies can be scored and compared before and after a prompt or code change. Not part of the game bridge and not part of the release.

## What is real and what is a stand-in

Real (imported from `bridge/`, never reimplemented): the persona book and `buildMessages` (`mistral-prompt.mjs`), the context blocks of a turn (`quest-context.mjs`, `turn-context.mjs`, `scenery-memory.mjs`, `game-dialogue.mjs`, `player-gear.mjs`, `johnny-head.mjs`, `intrinsic-character-context.mjs` for the reviewed characters' topic lore), the Expressive emotion and Natural speech notes, the follow-up pull, the reply-language note, the `TextProviderHost` with its cleaning, cap, retries, action decision and streaming head, the Mistral, Local and Custom routes (`mistralRoute`, `localRoute`, `customRoute`), the real `LocalLlmServer` on the installed Local AI pack, and `RealtimeHost` for Convai.

Stand-ins: the game request is built in the shape `mod/*.lua` writes (the places, weather, health and heat of `scenarios.mjs`), the character's memory is canned (`history`, `summary`, `remembered` in a scenario, so a run is repeatable), and the relationship and world-knowledge blocks are the fixed stand-in text of `scripts/Eval-MistralPrompt.mjs`. The follow-up pull and the Natural speech note are part of a turn only when the scenario says so (the bridge offers them on a share of turns). Not reproduced: the world-knowledge service's quest text, vendor memory, group rounds, the world rules the player wrote, the player's character overrides.

## Providers

| `--provider` | How it is reached | Notes |
|---|---|---|
| `mistral` | `mistralRoute`, the owner's key through `MistralProvider.load()` (`runtime/player-mistral-key.txt` of the main checkout; read in memory, never printed) | `--model ministral-8b-latest` (default), `ministral-14b-latest`, ... |
| `local` | the real `LocalLlmServer` started on the installed pack (`AUDIT_GAME_APP`, default the dev game's `red4ext/plugins/AiNpcCyberpunkMod/app`), driven by `localRoute` (prompt budget, compact persona) | Run only when the game is not running. One model at a time (`--pin lite` is Bonsai 2 4B). Stopped when the run ends. |
| `custom` | `customRoute` pointed at the same llama-server through its OpenAI-compatible endpoint | No usage counts come back from a server that is not asked for them, and there is no prompt budget on this route. |
| `convai` | `RealtimeHost`, text only (no voice), through the prebuilt browser client of the main checkout (`runtime/realtime-client.js`) | The characters have long-term memory, which needs an end user. Every scenario therefore gets its own throwaway `probe-<uuid>` end user (the family `scripts/cleanup-test-end-users.mjs` recognises), kept in `convai-audit-end-users-<label>.json`. The owner's real memory users are never used. Action offers are not armed on a text-only session (no audio participant), so the action scenarios are not valid for Convai. Convai keeps its own history, so the canned earlier talk is sent as real turns and the character's own replies to it are used. The persona is Convai-side (the provisioned profile); the prompt is the context string only. `convai-usage.mjs` prints the account's counters (read-only) to see what a run used. |

## Run

```
node scripts/response-audit/run.mjs --dry [--show <id>]                       the prompt of every scenario, no request
node scripts/response-audit/run.mjs --provider mistral --model ministral-8b-latest --label base-m8b
node scripts/response-audit/run.mjs --provider local --label base-local
node scripts/response-audit/run.mjs --provider custom --label base-custom
node scripts/response-audit/run.mjs --provider convai --label base-convai
        [--n 1] [--only id,id] [--group lore,short] [--voice pocket|none] [--concurrency 3]
        [--lean 0]     the roster character text as shipped (the default is the lean text the bridge now uses)
        [--compact]    the compact character text a slow machine gets (Local AI and Custom)
node scripts/response-audit/sheet.mjs --runs base-m8b,base-local --name base --parts 10   blind scoring sheets
   (judges write scores-<k>.json next to each sheet, see rubric.mjs)
node scripts/response-audit/aggregate.mjs --name base --by group                           tables
```

Results go to `<main checkout>/deliverables/response-audit-data/` (git-ignored). Each result row holds the exact `prompt` messages of the reply request (all requests of the turn are listed under `requests`), `raw` (with emotion tags) and `spoken` (tags removed), `ms`, `headMs` (when the first sentence could be spoken), `promptTokens` / `completionTokens` (the provider's own counts; a prefix-caching server such as llama-server counts only the uncached part of a prompt), the automatic checks (`problems`, `words`, `sentences`) and, for an action request, which action the host would hand to the game.

## Scoring

`sheet.mjs` writes blind sheets and the two rubrics (`rubric.mjs`: 1 to 5 scores on nine dimensions, and yes/no fault flags). Judges (a Haiku swarm, one agent per sheet) write `scores-<k>.json` and `flags-<k>.json`; `aggregate.mjs --name <sheet set> [--merge "before=run-a,run-b"]` prints the tables. A 1 to 5 score from a small judge piles up near 4.4, so compare the fault rates. `scenarios.mjs` holds the 42 scenarios and what a good reply does for each.
