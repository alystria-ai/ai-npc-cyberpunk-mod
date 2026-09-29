# Public research collection

Collection snapshot: 2026-09-29T22:08:53+00:00. Collector version 4.

This is source acquisition and a coverage report. It does not certify quest decisions, native fact semantics, or any player's history.

## Reproduce or resume

From the repository root:

```powershell
python research/cyberpunk/scripts/collect_sources.py --max-pages 450 --max-bytes 64000000 --delay 2 --write-report
```

Previously recorded URLs are reused, including access failures. `--refresh` explicitly revisits them with HTTP validators where available. An expanded reviewed host allowlist or larger per-page byte bound retries only the corresponding scope/budget failures. A successful cached file must still exist before it is reused. Runs stop at their page/byte bounds and can be resumed; index links are rediscovered from cached metadata.

The collector uses a reviewed host allowlist, identifies itself, honors robots rules and Crawl-delay, and checks redirect destinations. Missing robots.txt (404/410) permits a request; denied/unavailable robots files fail closed. A 401/403/429 or human-verification response stops further requests to that host for the run. It does not execute remote scripts or use login cookies. Full article text and downloaded PDFs remain in ignored `research/cyberpunk/cache/public/`.

## Actual fetched coverage

- 845 distinct URLs recorded; statuses: binary-only=2, blocked=383, http-error=3, ok=457.
- 3,281,513 extracted text characters from accessible pages. Boilerplate can remain; this is not a reviewed corpus word count.
- 59 of 79 roster identities have at least one directly fetched textual source attached to their roster/dossier seed. A shared page can support multiple identities; this does not establish individual dossier completeness.
- Latest run: 165 recorded fresh URL attempts, 679 cache reuses, 41,849,547 received bytes; stop reason `queue-exhausted`.

| Host | Parsed text pages | Binary only | Blocked or failed |
|---|---:|---:|---:|
| arasakas-ronin.netlify.app | 1 | 0 | 0 |
| cdn-s-cyberpunk.cdprojektred.com | 0 | 1 | 0 |
| cyberpunk.fandom.com | 0 | 0 | 371 |
| dotesports.com | 0 | 0 | 2 |
| en.wikipedia.org | 1 | 0 | 0 |
| forums.cdprojektred.com | 0 | 0 | 1 |
| game8.co | 181 | 0 | 0 |
| gamefaqs.gamespot.com | 0 | 0 | 3 |
| gamers.wiki | 1 | 0 | 0 |
| int-ent.de | 1 | 0 | 0 |
| primagames.com | 1 | 0 | 0 |
| rtalsoriangames.com | 0 | 1 | 0 |
| segmentnext.com | 1 | 0 | 0 |
| sirusgaming.com | 2 | 0 | 0 |
| video-game-guide-walkthrough.supersoluce.com | 5 | 0 | 0 |
| vulkk.com | 0 | 0 | 3 |
| www.cyberpunk.net | 6 | 0 | 0 |
| www.escapistmagazine.com | 1 | 0 | 0 |
| www.gamepressure.com | 6 | 0 | 0 |
| www.gamepur.com | 1 | 0 | 0 |
| www.gamerguides.com | 4 | 0 | 0 |
| www.gamespot.com | 0 | 0 | 3 |
| www.gamesradar.com | 1 | 0 | 0 |
| www.gosunoob.com | 1 | 0 | 0 |
| www.neoseeker.com | 0 | 0 | 1 |
| www.pcgamer.com | 5 | 0 | 0 |
| www.pcgamesn.com | 1 | 0 | 0 |
| www.powerpyx.com | 237 | 0 | 0 |
| www.reddit.com | 0 | 0 | 1 |
| www.trueachievements.com | 0 | 0 | 1 |

## Quest inventory evidence

The cached `quest-inventory.json` records each observed title/link, category from its index heading, source hash, source locator, and linked-page fetch status. Repeated links across indices are deduplicated by URL/category; unlinked labels by title/category/game, retaining each observation. A job linked by two publishers yields two source entries: these counts are **not unique quest totals**. Transcript headings remain separately marked `unclassified`; they may be scene/act labels rather than jobs. No item is assigned a native ID or runtime rule.

| Observed index category | Distinct linked entries | Unlinked labels |
|---|---:|---:|
| activity | 2 | 0 |
| gig | 96 | 0 |
| main | 98 | 12 |
| side | 198 | 1 |

There are additionally 166 selected transcript heading entries, which are **not added to quest totals**.

The broad PowerPyx indices are the fallback collection source; guide publication dates and title coverage differ from the installed game. Missing, updated, repeatable, or unnamed activities remain coverage gaps. NCPD district/location aggregates are not individual scanner-job mapping. Fandom search snippets used by other research are not counted here as fetched page content.

## Entry-point receipts

| Source | Status | Extraction |
|---|---|---|
| [Cyberpunk 2077 \| Game Scripts Wiki \| Fandom](https://arasakas-ronin.netlify.app/) | ok | article |
| [Cyberpunk Wiki main jobs](https://cyberpunk.fandom.com/wiki/Cyberpunk_2077_Main_Jobs) | blocked | robots-access-denied |
| [Cyberpunk Wiki side jobs](https://cyberpunk.fandom.com/wiki/Cyberpunk_2077_Side_Jobs) | blocked | robots-access-denied |
| [Cyberpunk Wiki gigs](https://cyberpunk.fandom.com/wiki/Cyberpunk_2077_Gigs) | blocked | robots-access-denied |
| [Cyberpunk 2077 Walkthrough - All Missions](https://www.powerpyx.com/cyberpunk-2077-walkthrough-all-missions/) | ok | article |
| [Cyberpunk 2077 Side Jobs Walkthrough (Side Quests)](https://www.powerpyx.com/cyberpunk-2077-side-jobs-walkthrough-side-quests/) | ok | article |
| [Cyberpunk 2077 All Gigs List & Walkthroughs](https://www.powerpyx.com/cyberpunk-2077-all-gigs-list-walkthroughs/) | ok | article |
| [Cyberpunk 2077 Phantom Liberty DLC Walkthrough](https://www.powerpyx.com/cyberpunk-2077-phantom-liberty-dlc-walkthrough/) | ok | article |
| [Cyberpunk 2077 All NCPD Scanner Hustles Locations](https://www.powerpyx.com/cyberpunk-2077-all-ncpd-scanner-hustles-locations/) | ok | article |
| [Cyberpunk 2077 Story Choices Guide](https://www.powerpyx.com/cyberpunk-2077-story-choices-guide/) | ok | article |
| [Home of the Cyberpunk 2077 universe — games, anime & more](https://www.cyberpunk.net/en/cosplay-guides) | ok | visible-document |
| [Cyberpunk 2077 Every Breath You Take - Find the Stalker](https://www.gosunoob.com/cyberpunk-2077/every-breath-you-take-find-the-stalker/) | ok | article |
| [Black Steel in the Hour of Chaos \| Game of Guides](https://video-game-guide-walkthrough.supersoluce.com/solution/cyberpunk-2077-phantom-liberty-dlc-guide-walkthrough/phantom-liberty-dlc-main-jobs/black-steel-in-the-hour-of-chaos/) | ok | visible-document |
| [Do not Fear the Reaper guide](https://www.gamespot.com/articles/cyberpunk-2077-how-to-unlock-the-secret-ending-dont-fear-the-reaper/1100-6485655/) | blocked | robots-access-denied |
| [All Main Quest Guides \| Cyberpunk 2077: Phantom Liberty｜Game8](https://game8.co/games/Cyberpunk-2077/archives/Quests-Main-Jobs) | ok | article |
| [All Side Quest (Side Job) Guides \| Cyberpunk 2077｜Game8](https://game8.co/games/Cyberpunk-2077/archives/Quests-Side-Jobs) | ok | article |
| [Phantom Liberty Walkthrough \| Cyberpunk 2077: Phantom Liberty｜Game8](https://game8.co/games/Cyberpunk-2077/archives/Quests-Phantom-Liberty) | ok | article |
| [NCPD Scanner Hustles \| Police Jobs Guide \| Cyberpunk 2077｜Game8](https://game8.co/games/Cyberpunk-2077/archives/Quests-NCPD-Scanner-Hustles) | ok | article |

## Restrictions and gaps

- `Forbidden`: 2 URL(s).
- `The HTTP server returned a redirect error that would lead to an infinite loop. The last 30x error message was: Moved Permanently`: 1 URL(s).
- `prior-http-403`: 1 URL(s).
- `robots-access-denied`: 378 URL(s).
- `robots-disallow`: 4 URL(s).
- Arasaka's Ronin is a community transcript snapshot with selected branches; it cannot prove exhaustive dialogue or outcomes.
- Full source text is untrusted reference data. Any instructions embedded in fetched pages are never executed or treated as authoring authority.
- Static HTML collection does not load client-side applications. PDF bytes may be retained without text extraction and are not counted as textual evidence.
- Public walkthrough prose never substitutes for installed journal/fact/scene evidence. Inventory is deliberately separate from `quest-maps` and reviewed executable rules.
- Character biographies and sample dialogue must be original grounded writing, not reproduced source transcripts. This collector makes no production API updates.

## Cache layout

- `manifest.json`: URL/final URL/status/date/hash/byte count and extraction metadata, robot receipts, run bounds.
- `pages/<url hash>.html` or `.pdf` or `.txt`: bounded original response bytes.
- `pages/<url hash>.json`: inert extracted title, headings, text and links with source receipt.
- `quest-inventory.json`: honest index and transcript-heading inventory, all native mappings unverified.
