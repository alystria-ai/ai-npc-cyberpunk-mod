# Romance with any character

Branch `feat/side-romance` (from `release/quests`, which holds the bond system and the story packs). A player asked on Nexus to pursue Takemura. Until now only the game's own romances registered (Judy, Panam, River, Kerry and Meredith's fling, `bridge/relationship-routing.mjs`). Now V's bond with any character can grow into a romance through talk, and V can end it.

Needs Settings > Companions > Character bonds. Nothing changes while it is off.

## How it works

1. **V leads.** Nothing starts from a timer and no character flirts unprompted. A romance starts only when V asks (typed, spoken, Phone Chat or a holocall) or says they are in love: "be my girlfriend", "I love you", "I have feelings for you" and the same in the 15 menu languages (`bridge/romance-intent.mjs`, `bridge/romance-intent-languages.mjs`). A line that is not plain about it ("do you love me?", "I love you guys", "let's split up and search") starts nothing.
2. **The trait decides, the bond is the milestone.** Every character has a row in `characters/romance-traits.json` (`bridge/romance-traits.mjs`): `open` (can they ever), `from` (the bond level, 5 to 9, at which they will say yes), `reason` (one sentence to the character: why they are open, or why they never would) and, for open characters, `style` (how their affection sounds, for example Takemura is formal and restrained). A character with no row (a player's own, a pack's) is open from level 7 with no style line.
3. **The bridge decides before the reply, the model only voices it** (`bridge/romance-bond.mjs`). The turn carries one volatile note:
   * `accept`: V is asking, the level is reached: say yes in your own way (the character's reason is in the note).
   * `defer`: open, but the bond is below `from`: too soon, not never, kindly, no time or condition offered.
   * `sting`: open and close enough, but V threatened or insulted them recently (more than the bond's hurt note level): not now.
   * `refuse`: a character who never would says no for their own reason, in their own way, and keeps the friendship. At any level.
   * `end`: V ends it (only while together): react in character, accept that it is over, no begging unless that is who they are.
   * `already`: V asks (or says they love them) while the two are together already, a game romance on Auto included: answer as V's partner would, never a first yes or a not yet. Nothing changes.
   A spoken turn has no words yet when the context is built (the game sends a placeholder), so it carries the same decision as a condition ("If V says now that they love you ...") and only the transcript read after the reply can start or end anything.
4. **After the reply** the decision is carried out once: the state is kept for the session (`RomanceBond.overlay`) and handed to the game as a change in `runtime/bonds-status.json` (`romance.changes`, ids newer than any a session had). Mod side: `mod/bonds.lua` writes the change into the save.

## Per save

The game is the truth. A romance is one saved quest fact per character, `cyberpunkconvai_rom_<fnv1a32 of the profile key>` (`mod/romance-registry.lua`, the same technique as the housemates' registry in `mod/housemate-registry.lua`), value 1 together, 2 ended. It sits next to the game's own romance facts (`sq030_judy_lover` and the other ten, which stay read only) and follows the save: an older save brings back its older state, a new game starts with none.

Every private turn's `bonds` block carries the saved state of that character (`romance: 'together' | 'ended'`, one fact read at the turn, never per frame). A decision made by the bridge waits as an overlay until the block agrees (the write can lag a turn) and is dropped for another world binding. A reaction (no bond block) uses the state of the last block seen in the same world.

Not yet proven in the game: that a mod fact survives save and load. The housemates rely on the same thing and its live check is still open (`docs/HOUSEMATES.md`, live check 1). If facts do not survive, switch `romance-registry.lua` to the file store of `housemate-registry.lua`.

## What a romance feeds

The same relationship block and partner tone the game romances get (`bridge/romance-context.mjs`): the "you and V are together" line, the style line written for the character (the five native characters keep their measured cues, `ROMANCE_CUES`), the partner tone (pet names, a tease, care, wishing V were here on the phone), the closing reminder after V's words, the bond's romance points (`ROMANCE_POINTS.partner`, 150) and the pack gates that ask for a partner. Mature is untouched: nothing sexual happens unless V leads, or when the bond and the situation fit under the Mature setting's own rules.

How the selection reads it (`bridge/relationship-routing.mjs`): Auto follows the romance for any character. For the five native characters On and Off stay the player's word. A romance V ended (`ended`) makes a native character ordinary too and drops the receipt's "never just friends" line, and a character who was only a casual encounter (Meredith) becomes a partner when V asks and she says yes.

## Breaking up

V says so ("it's over between us", "I don't love you anymore", "let's just be friends", "I want to see other people"). The character reacts in character on that reply, the state becomes `ended`, the manner goes back to ordinary and the relationship block says "You and V were together once and it ended". V can ask again later and the same rules apply.

## Settings

Settings > Conversations > Romantic relationships lists the five of the game as before, then one read only row per romance of the save ("Together", with a line that says how it grew and that it ends when V tells them). The rows are built in the page's own code (`relationshipRows` in `mod/manager-ui.lua`, fed by `bonds.romances()` in `mod/bonds.lua`: the characters V has talked to, one fact read each, kept 5 s). The page did not move, so the settings reorganisation does not touch it.

## The trait data

`characters/romance-traits.json`, 701 characters (every roster character but the two ambient ones). Made on 30 Oct 2026: Haiku helpers drafted every row from the profile text under a written rubric (children and teenagers and anyone who may be under 18 are always closed, machines and monsters closed, closed needs a reason from the text or the lore, open is the default for an ordinary adult, `from` by temperament, text rules), then Sonnet reviewed and rewrote the 126 main-cast rows (flips, levels, reasons and styles made specific). The check is `node scripts/Check-RomanceTraits.mjs --shipped` and the test `bridge/romance-bond.test.mjs`. Judgement calls the owner may want to flip, each one line in the JSON: Jackie Welles (closed, he is with Misty), Padre Ibarra (closed, a priest's vow), Johnny Silverhand (open from 8), Meredith Stout (open from 8, controlled and blunt).

## Files

* `characters/romance-traits.json`, `bridge/romance-traits.mjs`, `scripts/Check-RomanceTraits.mjs`
* `bridge/romance-intent.mjs`, `bridge/romance-intent-languages.mjs` (+ cases), `bridge/romance-bond.mjs`
* changed: `bridge/bonds.mjs` (`romance` in the block, `romanceChange`, status), `bridge/relationship-routing.mjs`, `bridge/romance-context.mjs`, `bridge/eddies.mjs` (`romanceOf`), `bridge/player-knowledge.mjs` (the turn carries the block's romance), `bridge/convai-bridge.mjs`
* game: `mod/romance-registry.lua`, `mod/bonds.lua`, `mod/init.lua`, `mod/manager-ui.lua`
* tests: `bridge/romance-bond.test.mjs`, `bridge/romance-lua.test.mjs`, `bridge/romance-intent-languages.test.mjs`

## Live checks owed

1. Bonds on, a character at the needed level (a quick one: `from` 5 or 6): type "be my girlfriend". Does the reply say yes in the character's manner, and does the next reply carry pet names and warmth? Is the Romantic relationships page showing the row?
2. Save, quit to the main menu, load: does the next turn still carry the partner tone (the fact survived)? Load an older save from before: no romance.
3. The same ask below the level: "too soon" with no rejection. A closed character (Padre Ibarra, Jackie): a no in their own words.
4. Say "it's over between us": a reaction in character, then an ordinary manner. Ask again.
5. A spoken line, same asks.
