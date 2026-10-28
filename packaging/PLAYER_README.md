# AI NPC Cyberpunk Mod

Talk to Cyberpunk 2077 characters by voice or text, with companions who answer in their own voices.

## What's new in 0.3.4

- **Default bindings**: F7 talk by voice, F6 talk by text, F10 group voice chat, F8 group text chat and F4 the Companion Manager are set from the start, so a new install works at once. A binding you set before stays yours, the mod only fills actions that had none. Change, clear or restore them on the bindings page of the Companion Manager.
- **Fewer rows in Settings > Voices**: Voice playback is now the first entry of Companion voices (Off keeps the voice you chose, so turning it back on restores it), and Subtitles moved to Voices with Off as its first entry. React to battles and React to collected loot moved to Gameplay.
- **V's voice for typed and for microphone lines**: two rows of the same kind, each with its own Off, so one can be on while the other is off. V speaks with one voice engine for both.
- **Controller talk button removed**: give Talk by voice a controller button, such as the left stick click, on the bindings page of the Companion Manager. If you had the button on, Talk by voice is set to the left stick click for you.
- **Generate report**: the button reads Creating… while the report is made and ignores further clicks until it is done.

## What's new in 0.3.3

- **NPCs react to threats and commands (new, off by default)**: Settings > Gameplay > NPCs react to threats and commands. With it on, ordinary people you threaten or order around react in their own way: they cower, run, throw a punch or obey a plain order like "get down". The game picks the reaction from the person's temper and tells the character, on every provider. A frightened person in a crowd now runs away instead of vanishing.
- **Remote OmniVoice (new, off by default)**: Settings > Voices > Custom voices. The OmniVoice voices can be rendered by a small server on another PC, or on a second graphics card, so your gaming card is left alone. Type the server address, press Test, and nothing of OmniVoice loads on the game PC. The server folder is a separate download. If the server cannot be reached the reply is shown as text.
- **Characters know what V has on right now**: the clothes, the weapon in hand and the cyberware are checked every turn, and what changed replaces what was said earlier in the talk. Characters also notice when V is topless or naked. V asking about themself gets the true state from Dark Future, Flesh and Chrome and Injuries, also when it is fine.
- **Characters you made** with Use the character I'm facing are in Characters to invite and in the phone's Chat tab, and you can call them with a live video holocall, with their own body in the picture. A copy invited from the Model browser takes the character you made from that model.
- **Phone Chat**: opening a character's chat page puts the cursor in the message box, so you type at once. A press on a Chat row is no longer lost when the tab was reset.
- **Steadier replies**: the conversation service, the voice workers and the Local AI model server now run at High priority while a world is loaded, and nothing of ours runs at High on the title screen. If the game stutters, a line `priority = normal` in priority.txt is the way back. V's helper voice now starts when your save loads.
- **Long prompts**: when a model server says the prompt is too large, the mod reads the limit, cuts the prompt to fit, sends it once more and remembers the limit.
- **Convai**: a companion asked to drive with no ride on offer says what is missing instead of claiming to sit down. A reply that arrives as text with no voice is shown as text instead of failing after a minute.
- **Crowd people keep their own memory**: what a stranger heard and the mood carried over are kept per person, not per profile.
- **Setup check**: it says which half is for the wrong game, the Runtime or the Scripts, and names the one to download. The notice waits until the game has settled. A binding can be set from a menu too.
- **OmniVoice on AMD Radeon cards (experimental)**: faster settings for the ROCm route and one retry for a phrase that failed to render. The rows that name Windows blocking something no longer suggest OmniVoice.
- **Error reports**: they cover more problems, including every way a voice stays silent, and the Local AI model row says why the service is not running.

## What's new in 0.3.2

- **Content packs**: a content pack is a small add-on that changes how the characters talk and brings no code of its own. It can add world rules, change the wording of the prompts, rewrite a character's backstory, style and example lines, give characters new names, add name pools for passers-by, point characters at their own Convai twins and keep a separate memory. Switch each pack on or off in Settings > Content packs. New names show after the game restarts and everything else from the next reply. Your own edits in the character editor still win over a pack. Medieval AI NPCs is the first pack and is a separate download on Nexus Mods.
- **Bindings from inside the game**: a new page on Companion Manager's Home sets the binding of each action, a keyboard button or a controller button, with no trip to Cyber Engine Tweaks and no restart. Johnny has his own talk bindings now, Talk to Johnny by voice and Talk to Johnny by text. The normal talk bindings with nobody in front of you talk to the first member of your party (the group ones take the first plus two others). Setting a binding can no longer hang the game.
- **Immersive invitations (new, off by default)**: Settings > Gameplay > Immersive invitations. With it on, inviting a character is an appointment: they come to you on foot or by car (your choice), text when they arrive and wait a while. You can meet them somewhere on the way, or cancel it with plain words like "never mind, cancel that", also when you say it to someone else. If the car cannot be used, the character walks instead and the game log says why. She looks for a street from the traffic cars and the ground, drives up and parks near you, and still walks when no street is found.
- **Housemates (new, off by default)**: Settings > Gameplay > Housemates. With it on, a character you tell they can stay at your place moves into one of your apartments. They stay in your party until you tell them to leave, then go home and live there. They no longer vanish when the flat has a story fact on: they stay in your apartment and step out of the way only during real scenes. In Settings > Gameplay > Housemates you can also pick the Move-in apartment (Ask me, or one of the apartments you own), set the Pause between chats (1, 2, 5 or 10 minutes), let 2 to 4 housemates join one chat with Housemates in one chat, and move everyone out with the Evict all housemates button. Residents show up right away and stay visible as you move around. Housemate chats flow from line to line with short gaps and end naturally, and the repeating "could not join" notice now shows once. Off, nothing of it runs.
- **Companions settle in your flat**: while you stay in your own apartment, your companions sit down on seats by themselves instead of trailing you, and on a bar stool they face the counter. No setting.
- **Revenge ambushes (new, off by default)**: Settings > Gameplay > Revenge ambushes. A gang you keep killing may, rarely, send a small squad after you, and one of them shouts a short threat. Never in a fight, a scene, a call, a vehicle, indoors, in a safe zone or while wanted. The threats are spoken only while Talk to ordinary NPCs is on.
- **Companions change outfits (new, off by default)**: Settings > Gameplay > Companions change outfits. Companions change into other looks, only while you are not looking. One who stood up to change sits down again within seconds.
- **Battle and loot reactions are on by default**: React to battles and React to collected loot (Settings > Automatic reactions). Characters comment on fights and on loot you pick up, and they have their own daily cap. Switch either off there.
- **Dynamic info has twelve switches**: Settings > Conversations > Dynamic info now also covers Time since last talk and Music and TV (new: the radio station and song playing, and the TV channel), and Other mods' state, which is off by default (it reads Dark Future and the Equipment-EX outfit V wears). The rest are on.
- **Companions speak up**: Settings > Conversations > Companions speak up (Speaks up rarely by default). Companions sometimes start a remark by themselves at a calm moment. Off turns it off.
- **Phone Chat** lists every character that has a profile here, not only the game's contacts, and its Chat tab has the same J (invite) and L (dismiss) buttons as the Contacts list.
- **Quest givers explain the job**: ask the character who gave you a job something like "what do I do next?" and they walk you through the step you are on, with the places, people and a tip, never beyond where you are. It covers 171 main jobs, side jobs and gigs, Phantom Liberty included.
- **Better replies**: strangers no longer act as if they knew V, "I gave you eddies" is understood as V paying them, and a companion knows which weapon they carry, also when it is holstered. Ambient NPC barks stay muted for the whole conversation, also in the gaps between turns.
- **Custom characters** spawned from another mod's menu are recognised reliably.
- **Voice workers behind a link**: they work when the Runtime sits behind a symlink or junction above its app folder.
- **OmniVoice on AMD Radeon cards (experimental, untested on AMD hardware)**: you install AMD's ROCm PyTorch in your own Python and the mod downloads nothing for it. On a PC with an AMD card and no NVIDIA card the game points to the steps by itself.
- **Fixes**: a stale player-memory lock no longer stops the mod's background service from starting, the logs are quieter and show start-up timing lines, and error reports are clearer.
- **Search the Model browser**: with Mod Configuration Menu, type in its Search settings box on the Model browser page and the list narrows to the models that match. Words can be in any order, parts of words work, and capitals do not matter. Each result keeps its Invite button.
- **Rita Wheeler** can always be invited, and the Model browser shows proper names, never raw record codes.
- **More sampling controls**: the Prompting page now has Top K, Min P, presence penalty and frequency penalty for each conversation option, and an Advanced parameters box (JSON) for Local AI and Custom models, for any other setting your model server understands.
- **Game 2.5**: RED4ext 1.31.0 (the official release) is the one to use, Codeware 1.21.0 from Nexus Mods now supports 2.5, and Mod Configuration Menu 0.10.6-hf1 was tested on 2.5. The requirements below have the links.
- **Codeware**: the official Codeware 1.21.0 now supports game 2.5, so use it from Nexus Mods (https://www.nexusmods.com/cyberpunk2077/mods/7780) instead of our unofficial build.
- **Local AI and the graphics card**: leaving Local AI for another conversation option no longer leaves a Local AI model loaded on the graphics card.
- **Install notes**: this README now names the right Hugging Face folders for both game versions.

## What's new in 0.3.1

- **Game 2.5 support**: the mod now comes in two builds, one for game 2.5 (the default, the main download) and one for the older game 2.31. Get the Scripts and the Runtime made for your game (the files for 2.31 have "-for-2.31" in their names, and the Runtime for 2.31 is in the game-2.31 folder on Hugging Face). The 2.5 build needs the 2.5 versions of Cyber Engine Tweaks, RED4ext, redscript, Codeware and Native Settings UI, listed under Requirements. Both builds are the same mod, and the features that read the game's quest history (the world knowledge rules, and the relationship facts behind the automatic romantic style and Johnny's remarks) work on both games: the quest data they read was compared between 2.31 and 2.5 and is the same.
- **Controller talk button (optional, off by default, replaced in 0.3.4 by a controller button on the bindings page)**: Settings > Voices > Controller talk button. Hold the left stick click while you look at someone, speak and let go to send. It does nothing in menus, scenes, calls, combat or vehicles, and the click keeps its normal job when the setting is off.
- **V speaks your microphone lines (optional, off by default)**: Settings > Voices. A line you speak is repeated in V's voice like a typed one, and the reply follows V's line. It works with every voice and provider, OmniVoice and Convai included.
- **Convai and the local model**: with Convai chosen, the mod no longer starts the Local AI model server just to look up a setting.
- **Hold to talk**: a game that stalls for a few seconds no longer cancels the voice turn, a late signal no longer takes the microphone back, letting go before the microphone opened fails at once, and words that were heard but never got a final transcript are sent to the character.
- **OmniVoice**: a game started from a packaged app no longer fails with "Model-admission path escaped the runtime".
- **Setup check**: it names the game version your files were made for, and says so when the Scripts and the Runtime are for different games or the build does not match your game.

## What's new in 0.3.0

- **Hold to talk, instantly**: the microphone opens the moment you press the talk binding, so your first words are not lost. Hold it while you speak and let go to send. It stays ready for 15 seconds after a voice turn, and the first press after a pause shows "Opening microphone..." and then "Speak now".
- **Voice activation (optional, off by default)**: Settings > Voices > Voice activation lets the mod hear when you start speaking, so you can talk without holding anything.
- **Quieter streets**: the game's own greeting, grunt and bump lines of people within 15 meters no longer play over an AI voice line, or while V is talking.
- **Convai sign-in that holds up**: a turn that finds no sign-in after a network failure tries once more at once, the waits are longer, and a second sign-in service takes over for players who cannot reach the first one.
- **OmniVoice**: a quick restart waits for the old voice process to let go of the model instead of failing, and a reply in a fixed language skips the English warm-up.
- **Local AI**: a model that spilled onto your processor and has nothing to replace it stays loaded instead of being unloaded.
- **Companions can see in groups**: the picture is prepared early for the next speaker, and no turn waits more than 15 seconds for a picture.
- **Setup check**: a "service never started" row left over from before this service started is dropped, and a row that stays says why the service never started.
- **Multilingual packs**: notices, Help and the setup check now say "multilingual pack" in all 15 languages.

## What's new in 0.2.9

- **Fewer mods needed**: Audioware and TweakXL are no longer needed. Voices play through the mod's own audio, so game patches that break Audioware no longer silence the mod. If you still have either installed, nothing changes for you.
- **OpenRouter**: paste a page address from the OpenRouter website as the Custom endpoint and it is saved as the API address (a model page also picks the model), and Test connection works with models that must reason before they answer.
- **Companions can see without the yellow border**: where Windows allows it the picture is taken without the yellow capture border, and only when a turn needs one.
- **Vortex installs the Local AI packs**: they hold no files Vortex mistakes for a different kind of mod, so adding them works. The Runtime now carries the engine they used to carry.
- **Microphone notice**: when the connection to Convai fails at the start of a turn, the notice says so instead of telling you to check your Windows input device.
- **Quest memory is on by default**: characters remember the choices you made in quests and what they saw you do.
- **Three new characters** join the cast with their own voices: Mr. Blue Eyes, Hasan Demir and Pedro Aimar.
- **Voice language**: Settings > Voices > Voice language is English by default, or Automatic, or a fixed language. Short lines like "hows biz" no longer switch the language.
- **Invitations follow your provider**: inviting a companion no longer opens a Convai connection when you use Mistral, Local AI or Custom, and a refused Convai sign-in gets its own message.
- **Party list**: a failed invitation leaves the list after its notice, each row shows one action for its state, and the Character editor button sits above Settings on Home.
- **Johnny**: Johnny in your head waits for the game's own choice list instead of talking over it, and his lips move when he rides as a passenger.
- **Models that must reason** get room to think from the first request, and an empty reply is asked again with more room.
- **Street reputation (optional, off by default)**: gangs, police, corporations and ordinary residents can remember what V did, which quests V finished and how famous V is. Switch it on in the settings.
- **Smaller downloads**: the Runtime no longer carries files nothing loads (test folders, duplicate libraries and the old audio bank), and the OmniVoice pack is about 1.2 GB smaller. The Local AI packs no longer carry a copy of the engine, which the Runtime has.
- **A safer Convai sign-in**: the Runtime no longer contains the shared Convai login. It signs in to the shared account through a small online service instead, and tells you once if it cannot.
- **Prompting page**: the character editor has a Prompting page that edits how each conversation option (Mistral, Local AI Lite and Standard, Custom models) is worded, with a live preview and a reset for each piece of wording. Every option now ships with wording tuned and measured for its model.
- **Dynamic info**: Settings > Conversations > Dynamic info has twelve switches for the live game information a reply carries (all on except Other mods’ state, which reads Dark Future and the Equipment-EX wardrobe outfit V wears, and is off until you turn it on), so you decide what the characters may know about the moment.
- **Replies sound more natural**: no weather on the first turn of a conversation, no echo of your own words at the start of a reply, no stock closing question, shorter character descriptions, and the finished Convai text is cleaned the same way as its first sentence.
- **Characters**: every person is described as who they are before V, with no talk about the mod or the game itself, no weather or district small talk from passers-by, and new kinds for MaxTac, NUSA and joytoy people with their own voices.
- **Voices that do not stall**: V's lines and replies are never cut for being slow, a slow Voxtral start is hedged, Pocket no longer gives up while a slow disk delays its start, and a voice that cannot work (for example a Windows paging file that is too small) says why once instead of being retried.
- **Switching provider mid-game** applies cleanly to the next reply, and a Convai connection that closes before the reply arrives is asked once more on a fresh one.
- **Companions**: a copy that failed to spawn or to come back after fast travel is removed, fast travel recovers the party instead of leaving the mod suspended, a vehicle exit that keeps failing no longer sticks, and reloading the CET scripts no longer leaves party cars behind.
- **Smaller graphics cards**: Local AI keeps room for the game on cards up to 24 GB, and OmniVoice is not started on an NVIDIA card of 8 GB or less, where Pocket speaks at once with one notice.
- **Updating**: every Runtime update leaves a small marker, and Generate report names an update zip you skipped and tells you to apply the update zips one by one.
- **Smoother game**: fewer file reads by the scripts while nothing changes, and a caption you could not hear stays on screen for its whole reading time.
- **Privacy**: error reports are sent only after the notice, tighter redaction of personal details, and the report server is hardened.
- **Fixes from error reports**: a firewall that blocks your own model server is named as such, reports skip noise that is not a bug, and the interface text was reviewed in all 15 languages.

## What's new in 0.2.8

- **Characters in the voice of your language**: optional multilingual packs for Chinese, Japanese, Korean, French, German, Italian, Spanish, Polish, Brazilian Portuguese and Russian. When a character replies in that language, OmniVoice and the Mistral voice copy the game's own dubbed voice for them instead of the English actor's. One zip per language in the multilingual folder on Hugging Face; get only the languages you play in.
- **Pocket speaks five more languages**: with the PocketTTS model for French, Italian, German, Spanish or Portuguese installed next to that language's voice pack, the Pocket voice answers in that language on your processor, in the character's dubbed voice.
- **OmniVoice for V**: when your companions use OmniVoice, V can use it too (Settings > Voices). V's line always plays, so a typed line takes a moment longer.
- **V voice mods**: if you use a mod that replaces V's voice, V's AI lines now sound like it. The mod is found once when the game starts. You can also give V your own voice clip in the character editor.
- **Talk to anyone**: every person you can aim at can be talked to now. People without a character of their own answer as a resident or worker of their kind, receptionists and quest extras included, and quest characters standing at their post get lip sync.
- **Clearer messages**: a story character tells you when Talk to story characters is off and where to turn it on.
- **Johnny**: changed when he counts as busy (just standing around or riding with you). If he still refuses, Generate report shows which rule blocked him.
- **Mod Organizer 2**: fixed "The conversation service did not get that message" when Mod Organizer 2 showed the game two copies of the mod's files.
- **Smaller graphics cards**: Local AI leaves room for the game on cards with 12 GB or less, and a model that runs on your processor gets the time its first reply needs. OmniVoice that does not fit next to the game switches to Pocket with one notice instead of retrying, and the voice menu says when OmniVoice needs an NVIDIA card or 12 GB.
- **Fixes from error reports**: the Pocket voice starts reliably while the game is loading, the memory lock works under Wine and Proton, and crash reports carry what is needed to fix them.

## What's new in 0.2.7

- **Native plugin fully on**: the native plugin now runs all five of its systems (actions, vehicles, chauffeur, passage and faces) instead of the script path. If one ever misbehaves, put its name on a line of runtime\native-off.txt in the mod folder to switch it off.
- **A newer, faster Local AI engine**: Local AI now uses llama.cpp b11782, equal or faster on every card and about twice as fast when part of the model runs on your processor. The engine is part of the Runtime from this version, so a future engine fix arrives with a small Runtime update instead of a new Local AI download. The Local AI packs you already have work unchanged.
- **Convai voice only when you choose it**: the Convai voice speaks only when you picked it, never as a fallback.
- **Local AI with a non-English Windows user name**: Local AI starts when your Windows user name has accented or non-Latin letters.
- **Lip sync on every line**: a phrase the face model has no mouth shapes for moves the mouth with the audio itself, the same for everyone.
- **Fixes from error reports**: custom characters' receipts, a model server that Windows blocked now says so, clearer messages while a model is still loading, Local AI recovers from a graphics device that ran out of memory, and the Bluetooth audio delay check works when your Windows temp folder has non-English letters.
- **Your own model server**: the model row says why a server cannot be used, and a saved server choice survives a changed id.
- **Memory on Convai**: no memory-fact extraction is attempted while the chat is on Convai.
- **Convai in other languages**: the multilingual character twins start at the right audio rate from their first line, and a turn that fails still teaches the mod the corrected rate.

## What's new in 0.2.6

- **A talk can have consequences**: clearly threaten or insult an ordinary passer-by (not a joke) and they react: they walk or run off, call the police, or, if they are a ganger, merc or guard, fight back, depending on who they are and where you are. Story and quest characters are never affected.
- **Quest crowds talk**: extras such as the patrons of the Afterlife answer like any resident, with a speaking face.
- **Languages are automatic**: characters answer in the language you write in, short lines included. The Multilingual setting is gone; there is nothing to switch on. Convai picks the right character twin for each message, and add-ons follow your language too.
- **Voxtral 3**: the Voxtral voice and transcription use Mistral's new version, with the older ones as a fallback. On the Voxtral voice a passer-by now keeps one steady voice.
- **Local stays local**: if your local voice or Local AI fails, the mod says so or shows text. It never switches to a cloud voice or cloud text on its own.
- **Local AI on small graphics cards**: when the model does not fit next to the game, part of it runs on your processor instead of failing, after a check that there is enough system memory. You get one notice when replies will be slow, with the advice to pick a smaller model or the Custom provider.
- **Your own models**: the Nexus page points to running your own model files or model server. On your own server, "no thinking" is asked from the very first request.
- **Companions understand plain requests better**: slang, typos and other languages in "follow me", "drive me" and the like.
- **Less weather talk**: the weather and the time of day are mentioned once per conversation instead of on every turn.
- **Memory page**: press the chosen character again to unselect it.
- **Settings text fits small screens**: the row text in Mod Configuration Menu scales with the resolution, so labels are not cut off.
- **Mod Organizer 2**: the Pocket and OmniVoice voices start under Mod Organizer 2.
- **Fixes from error reports**: Local AI restarts after a lost graphics device, a Convai connection closed mid-turn no longer errors, a reply that repeats a line is trimmed instead of asked again, and a Runtime of two different versions gets a clear message naming the update zips to apply in order.

## What's new in 0.2.5

- **Local AI on busy graphics cards**: when the game pushes the model out of video memory, the mod notices after a slow reply and reloads it to fit, or switches to the lite model. Before loading it now checks the real fit, so cards with 4 to 5 GB free get the whole model.
- **Faster first replies on slow PCs**: a shorter character description on PCs that read prompts slowly, and prompts are trimmed properly instead of being sent whole.
- **A tidier settings page**: fewer rows, one row each for Johnny and V's voice, and the Custom endpoint on its own page.
- **Companions drive from inside your car**: say "you drive" or "swap seats" while sitting in your own car with a destination set.
- **Convai free tier**: 500 turns a day.
- **Mod Organizer 2**: packs and microphone packs installed as separate mods are found.

## What's new in 0.2.4

- **World rules**: write rules for the whole of Night City on the character editor's World rules page, and every character follows them from the next reply, on every provider.
- **Local AI stays fast in long talks**: a background summary no longer waits in front of your typed line, and the model no longer re-reads the whole character after you open the chat box.
- **Local AI on 8 GB cards**: after two stalled replies it switches to the lite model of the same family, or to cloud text, and says so once. 8 GB cards start on the lite model.
- **V's voice on slower PCs**: a slow Pocket start is no longer stopped while it is still loading.
- **Pocket on Vortex, again**: the Pocket check looks only at the files Pocket ships, so extra files a mod manager leaves beside them no longer silence every voice. If a Pocket file really is wrong, Settings > Help names it.
- **The game starts the service without launcher.ini**: if that file is missing from the plugin folder (seen on a Vortex install), the launcher uses the shipped settings instead of giving up.
- **Your own model server**: a model that only thinks is asked again without thinking, and a server with a small context gets a shorter character description that fits.
- **Smaller updates**: from 0.2.3, the Runtime update is enough; from 0.2.2, apply the two Runtime updates in order.

## What's new in 0.2.3

- **Smaller update download**: with the 0.2.2 Runtime installed, get the Runtime update (about 22 MB) instead of the full Runtime.
- **Faster first words**: the voice and Local AI processes get full priority while a reply is being made, so the game no longer slows them down (they drop back when idle).
- **Microphone packs** for European and Asian languages with Local AI and Custom endpoints.
- **15 more characters** with their own voices, and a new voice reference for Viktor.
- **Either manager host**: Mod Configuration Menu 0.10.5 or newer, or Native Settings UI. One is enough. If V is sitting, the manager shortcut tells you to stand up first.
- **Browsers and PowerShell**: Brave and other Chromium browsers are found outside their usual folders too, and you can name yours in browser.txt next to launcher.ini. PowerShell is not needed.
- **Pocket on Vortex**: Pocket voices (and V's voice) start on Vortex installs again. When a voice cannot start, Settings > Help says so.
- **Local AI**: a crashed model server is restarted and the reply asked again; small-context servers of your own shorten the character description to fit; faster repeat turns.
- **Clearer messages**: a partly extracted Runtime, missing Audioware or TweakXL each say what to do, and the CET console shows each problem once.

## What's new in 0.2.2

- **The manager is back in Mod Configuration Menu**: with Mod Configuration Menu 0.10.5 or newer the Companion Manager is a page of its own there (Esc, Mods, or your manager shortcut). Native Settings UI works as the other choice. Both show the same settings.
- **V speaks your typed lines sooner**: V's voice is prepared ahead, so a line you type is heard in V's own voice before the reply.
- **Your own AI service**: a new conversation provider, **Custom**, works with any OpenAI-compatible service: OpenRouter, Nano-GPT, or Ollama or LM Studio on your own PC. Set it up in Settings > Conversation provider > Custom endpoint and press Test connection.
- **Voice clips for characters**: in the character editor, give a story character or a character you made a voice of their own from a short recording. Pocket, OmniVoice and Voxtral copy it, from that character's next line: no restart.
- **Make your own characters**: create and edit characters of your own in the editor, with a profile, a way of speaking and memories.
- **The microphone in other languages**: with Mistral, speak in your own language and it is understood. With Local AI or a Custom endpoint, two optional Microphone packs add Russian, Ukrainian, Polish, Czech, Hungarian, German, French, Spanish, Italian, Portuguese, Mandarin Chinese, Japanese and Korean, on your own computer. English stays on the fast local path.
- **Your own Local AI models survive reinstalls**: put them in `%LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai` and updates, clean installs and mod managers leave them alone.
- **Local AI fixes**: it starts reliably at launch, loads much faster while the game is running and then steps back so the game stays smooth, says plainly why a reply did not come, and the first turn after loading no longer goes to Convai.
- **Mod Organizer 2**: the Runtime can be installed as a Mod Organizer 2 mod, and your settings and chats survive a launch.
- **Automatic error reports** (on by default; turn off in Settings > Privacy): when something fails, a short report goes to the developer so it can be fixed without asking you for logs. It leaves out passwords and account details, what you and the characters say, and your microphone audio.
- **A missing requirement no longer breaks everything**: the scripts compile without Codeware or Audioware and tell you clearly what is missing, and Help has a Setup check.
- **Faces come back**: a character's face is rebuilt after you change appearance or another mod replaces the model.
- **Packs no longer clash**: if Windows asks about files with the same names, choose Replace: it is always safe.
- **Story and character fixes**: many characters were checked against the game's own text and corrected, so they know and say the right things. Plus many smaller fixes to notices, languages and timing.

## Requirements

- Cyberpunk 2077 on Windows 10 or 11 (64-bit), version 2.5, or the older version 2.31. The mod comes in two builds, one for each game version. The Scripts and the Runtime must both be the build for your game, and the files of the 2.31 build have "-for-2.31" in their names. To play 2.31 on Steam, right-click the game in your Library, then Properties, Game Versions & Betas, and pick 2_31_old. Settings > Help names the build and tells you when the two do not match.
- Install these from Nexus Mods first: Cyber Engine Tweaks, RED4ext, redscript, Codeware, and either Mod Configuration Menu 0.10.5 or newer (https://www.nexusmods.com/cyberpunk2077/mods/31640) or Native Settings UI (https://www.nexusmods.com/cyberpunk2077/mods/3518). One of the two is enough; with both, the manager uses Mod Configuration Menu.
- Tested with these versions. For game 2.5: Cyber Engine Tweaks 1.38.0, RED4ext 1.31.0, redscript 0.5.32, Codeware 1.21.0 and Native Settings UI 1.97. For game 2.31: Cyber Engine Tweaks 1.37.1, RED4ext 1.30.0, redscript 0.5.31, Codeware 1.20.5 and Native Settings UI 1.96. On game 2.5, Cyber Engine Tweaks 1.38.0 can hang a NEW game: start the new game without Cyber Engine Tweaks, save once, then put it back.
- A Chromium browser for the conversation service: Microsoft Edge, which comes with Windows, is enough. Google Chrome, Brave, Vivaldi, Opera and other Chromium browsers work too; Firefox does not
- An internet connection while you talk with Convai, Mistral, a cloud Custom endpoint or the Voxtral voice (Local AI, or a Custom server on your own PC, with a local voice needs none)
- About 3 GB of free disk space (about 13 GB more while installing the optional OmniVoice pack, 7.4 GB once installed)
- Optional Local AI packs: about 5.3 GB for standard and about 1.3 GB for lite (about 11 GB free while installing the standard one, which counts the downloaded zip)
- Optional Microphone packs: about 0.67 GB for the European languages and about 0.24 GB for Chinese (they use no video memory)

RED4ext is needed because it starts the voice service with the game and loads the plugin that comes with the Runtime download.

You do not need to install anything else. The voice service, its voices and models are included and start with the game.

## Install

Close the game, then extract each download into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge. If Windows asks about files with the same names, choose Replace: it is always safe.

1. **Runtime, once**: for game 2.5 https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/Runtime.zip (the mod's Hugging Face page), for the older game 2.31 https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/game-2.31/Runtime.zip. This is the Runtime base: the large parts (Node, Python, the voices and models). You install it once, and get it again only when Settings > Help says the Runtime base is too old (it names the version it needs).
2. **Scripts, at every update**: from Nexus Mods, with Vortex or by hand. Pick the file for your game version: the main file for 2.5, or the optional file "Scripts - for game 2.31 (older game version)" for 2.31. The Scripts carry all of the mod's own code, so a new version of the mod is usually just new Scripts.

The optional packs are on the same Hugging Face page, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs, in folders next to the Runtime (`voice`, `local-ai`, `mic` and `multilingual`). Each pack is one zip file, so there is nothing to join, and each works on its own.

3. **OmniVoice pack (optional)**: a higher-quality voice for NVIDIA graphics cards with at least 12 GB of video memory and a current driver. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/voice/OmniPack-OmniVoice-0.6B.zip and extract it after the Runtime. Then choose an OmniVoice option in Settings > Voices. AMD Radeon cards (experimental): install the same pack, then open Settings > Voices > OmniVoice for AMD and press Install. It downloads AMD's ROCm PyTorch (about 1.5 GB) by itself. Details: https://github.com/alystria-ai/ai-npc-cyberpunk-mod/blob/main/docs/OMNIVOICE_AMD.md

4. **Local AI packs (optional)**: let the characters answer with an AI model that runs on your own graphics card, with no account and no internet connection. There are two, and you can install neither, one or both: **Local AI standard** (Gemma 4 E4B, about 5.3 GB, needs about 6 GB of free video memory) for the best replies, and **Local AI lite** (Bonsai 2 4B, about 1.3 GB, needs about 2 GB of free video memory) for smaller graphics cards. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/LocalAI-Standard-Gemma-4-E4B.zip and https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/LocalAI-Lite-Bonsai-2-4B.zip (one or both) and extract each. They hold the models only and need the Runtime of version 0.2.7 or newer: the engine that runs them is part of the Runtime. Each pack includes the engine and the memory model it needs, so one alone is enough. Then choose Local AI in Settings > Conversation provider. See "Local AI" below to pick a combination.

5. **Microphone packs (optional)**: let you speak to the characters in your own language when the Conversation provider is Local AI or a Custom endpoint. You do not need one for English, and not for other languages with Mistral, which understands them by itself. There are two, and you can install neither, one or both: **European languages** (about 0.67 GB) understands Russian, Ukrainian, Polish, Czech, Hungarian, German, French, Spanish, Italian and Portuguese, and **Asian languages** (about 0.24 GB) understands Mandarin Chinese, Japanese and Korean. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip and https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mic/MicPack-Asian-SenseVoice-Small-234M.zip (one or both) and extract each after the Runtime. There is nothing to switch on: when you speak, the mod uses the pack for the language you have been typing or speaking, or the game's language. A pack is loaded only while you use it, on the processor (not the graphics card), and leaves memory about a minute after your last recording. The very first recording after installing can take a minute while Windows checks the new file; later ones start in a few seconds. The words appear once you press the voice shortcut again, not while you speak. The packs are used under their own licences, see the notice inside each zip.

6. **Multilingual packs (optional)**: when a character replies in Chinese (Mandarin), Japanese, Korean, French, German, Italian, Spanish (Spain), Polish, Portuguese (Brazil) or Russian, their voice is cloned from the game's own dubbed voice in that language instead of the English actor. Works with the OmniVoice and Mistral voices. One zip per language, about 150-170 MB each: get only the languages you play in, from the multilingual folder on the Hugging Face page, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual. Extract each after the Runtime.

7. **PocketTTS models (optional)**: the Pocket voice, which runs on your processor, speaks English. With the PocketTTS model of a language it also speaks French, Italian, German, Spanish (Spain) and Portuguese (Brazil), in the character's own dubbed voice. Get the multilingual pack for your language (item 6), and if you use the Pocket voice, also get the PocketTTS model for that language: `PocketTTS-Model-100M-<Language>.zip`, about 219 MB each, from the same multilingual folder, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual. Extract it after the voice pack. The PocketTTS model needs the voice pack of the same language, because it copies the voice from the pack's clips; with the model but not the pack, replies in that language show as text, and the game tells you once. OmniVoice and the Mistral voice need only the voice pack.

### Vortex

- **Scripts**: use Vortex's download button on the Nexus page, or drop the Scripts zip onto Vortex's Mods page.
- **Runtime**: download the zip from Hugging Face and drop it onto the Mods page too. Then click Deploy. Every file lands in the right place. Vortex moves only the "HOW TO INSTALL" text file to its mod-extra-files folder, which is harmless. At its first start the mod copies its code from the Scripts into the Runtime's folder, so Vortex may then report "external changes" in the Runtime mod: click Save all changes.
- **The warning sign in the Version column** only means the mod was added from a file and not downloaded from Nexus. It is harmless.
- **Local AI packs and the other model packs**: Vortex shows "You Have Reached The Fallback Installer". Choose "Yes, Install To Staging Anyway" and every file lands correctly. With two of these packs Vortex reports "unresolved file conflicts" because they share identical files (the licences and the embedding model). Pick either one to load after the other, it makes no difference.
- **The OmniVoice pack**: extract it into the game folder by hand. Vortex can't install it, because it holds DLLs.
- **External changes**: if Vortex shows External Changes ("Mod files were changed outside Vortex") for this mod's files after an update, click Save all changes (or Use newer file for all changes) so it keeps the newer files, never Revert, then Confirm.
- **Versions**: the Scripts need a Runtime base of at least the version Settings > Help names (a newer Runtime is fine too), and both must be for the same game. Settings > Help shows both.

### Mod Organizer 2

Install the Scripts as one mod and the Runtime as another. Put the Runtime update zips, the multilingual packs and the PocketTTS models INTO that Runtime mod's folder (replace files), not into mods of their own. The other packs can be mods of their own.

Start the game. The first start after installing takes a little longer while the voice service prepares itself.

If Windows reports an error while extracting, use 7-Zip (https://www.7-zip.org) instead of the built-in extractor.

If an optional pack ended up in a folder of its own named after the zip, the mod moves the pack's files into place at the next start. The Scripts and Runtime are not moved: extract those again, into the Cyberpunk 2077 folder itself.

## What companions can do

Invite someone from Companion Manager > Characters to invite. Party members follow you everywhere, sit with you when you sit (couches, benches, bar stools), ride along in your car and fight with you. A few things you just ask for in conversation, in your own words:

- **Drive you somewhere:** set a waypoint on the map and have your car nearby (call it, or stand within 20 m of one of your cars). Ask them to drive, for example "can you drive us to the waypoint?". They walk to the car and take the wheel; get in the passenger seat yourself within a few minutes. Change the waypoint and they follow it. Stop trip in the Companion Manager ends it; fast travel or loading a save does too.
- **Fight someone:** tag the enemy with your scanner (or look right at them) and tell them to attack. They fight on their own anyway when a fight starts.
- **Leave:** tell them to go home or leave the party, or use Dismiss in Companion Manager > Parties > Current party.
- **Save a party:** in Companion Manager > Parties, press Save current party under your party. It is saved as Party 1, Party 2 and so on, with your copies and the characters you made. Each saved party has a Spawn party button that invites everyone in it to your side with one press (it adds to your party and does not dismiss anyone, and a character who is already with you is not invited twice), Update with current party, Rename party (type the name in the Search box of Mod Configuration Menu, then press Rename) and Delete (press it twice).

They can't wait, stay or sit on command yet.

## Local AI

Convai free tier works out of the box with no setup and gives better quality responses. Local AI is for playing without an account or without the internet. It needs a separate graphics card that supports Vulkan (NVIDIA or AMD), at least 16 GB of system memory (32 GB is better) and about 5 GB more than usual while it runs. The first start after installing takes about a minute while your graphics card prepares the model; the Local AI model row in Settings > Conversation provider shows "Warming up" until the model is ready. The model is unloaded after ten minutes without a conversation.

**Your own model (advanced, optional).** You can add a chat model of your own: put its `.gguf` file in a `custom` folder inside `%LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai` (paste that into the Explorer address bar and make the `local-ai` folder if it is not there; it survives reinstalls and mod managers), list it in a small `manifest.custom.json` in that same folder, and it appears in the **Local AI model** row marked "(custom)". It is listed with the others from the smallest model to the largest and takes part in the default choice by its size. It must be a GGUF instruct or chat model that llama.cpp supports (Q4_K_M is a good choice), and it needs about its file size plus 1 GB of free graphics memory; one too large for your card is shown as such and never used. If it does not show up, the reason is in `bridge.stderr.log` (in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; paste that into the Explorer address bar), on lines with `[custom models]`. Your own model runs on the mod's own engine, so a Local AI pack must be installed. The Local AI folder inside the mod (`red4ext\plugins\AiNpcCyberpunkMod\app\local-ai\`, with the `manifest.custom.json` next to the other manifests) works as before, and both folders are read, but a clean reinstall deletes the one inside the mod: to keep a model you set up there, copy its `custom` folder and `manifest.custom.json` into the `%LOCALAPPDATA%` folder. The full steps, with an example, are on the mod's Nexus Mods page.

**Your own model server (advanced, optional).** If you already run a model in KoboldCpp, LM Studio, Ollama, a llama.cpp server or any program with an OpenAI-compatible API, Local AI can use it, with no Local AI pack. Put the server's address in the same `manifest.custom.json` as an `endpoint`, for example `{"version":1,"models":[{"endpoint":"http://127.0.0.1:5001/v1","name":"My Server"}]}`. Start the server before the game, then choose it by name in the Local AI model row, where it is marked "(custom)". A server on this computer or your home network needs nothing more; any other needs `"remote": true` and an `https://` address. The usual addresses and the other options are on the mod's Nexus Mods page.

If your graphics card is short of memory the mod steps down by itself and keeps your voice before it keeps the model: the standard model gives way to the lite model, and if the lite model does not fit either, the text comes from Mistral or Convai, with one notice. Your voice only changes as a last resort. The standard model checks that about 6 GB of video memory is free when it starts; with less, the lite model is used.

## Custom provider (advanced, optional)

Settings > Conversation provider > **Custom (OpenAI-compatible)** uses any endpoint that speaks the OpenAI chat-completions protocol: OpenRouter, Nano-GPT, or a server on your own computer such as Ollama or LM Studio. Press **Open** on the **Custom endpoint** row, under the Mistral row; its page holds the rows. Use the three Paste buttons in order, each after copying the value from your provider:

1. **Paste endpoint URL**, the endpoint's base address. OpenRouter: `https://openrouter.ai/api/v1`. Nano-GPT: `https://nano-gpt.com/api/v1`. Ollama: `http://localhost:11434/v1`. LM Studio: `http://localhost:1234/v1`.
2. The second button, for the access code of your account. A server on your own computer needs none.
3. **Paste model ID**, a model name from the provider's list: for example `meta-llama/llama-3.1-8b-instruct` on OpenRouter, or `llama3.2` on Ollama.
4. Press **Test connection**. It sends one tiny request and says OK, or what the provider answered.
5. Go back with **Back to settings** and choose **Custom (OpenAI-compatible)** as the provider.

Each paste reads the clipboard once, checks it and saves it on your computer; **Remove** deletes it. Only the last four characters of the access code are ever shown, and it goes to that endpoint and nowhere else. An `http://` address works only for your own computer or home network; any other host needs `https://`. A server on your own PC must be running before the game starts. Nothing is sent until you choose the provider or press Test connection. Without an address and a model ID, conversations use Convai and one notice says so. The replies, their price and their limits are your provider's, and your lines go to it. The values are kept in `player-custom-endpoint.txt` in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; its three lines are described in docs/CUSTOM_PROVIDER.md in the mod's repository.

## Choosing a setup

Every voice sounds like the character, Pocket and Voxtral included, so pick by what matters to you:

- **Least effect on your frames:** go all cloud. Convai or Mistral for the text, Voxtral or Convai's voice for the speech. Nothing runs on your PC for the companions (set V's voice for typed lines to Off or Voxtral to keep V's line off your processor too). The default (Convai with the Pocket voice) is nearly as light.
- **Fastest replies:** Mistral for the text with Pocket for the voice. Pocket starts speaking in a fraction of a second.
- **Fully local, best replies:** Local AI standard, with Pocket for the voice (or OmniVoice on an NVIDIA graphics card).
- **Fully local, lightweight:** Local AI lite with Pocket.
- **Extra expression:** OmniVoice can laugh and sigh, and Natural speech adds pauses and hesitations. OmniVoice is the heaviest voice and starts speaking a little later.

Set Windows power mode to Balanced or Performance and plug a laptop in: it is the biggest single factor for reply speed.

Extra video memory each setup uses on top of the game's own:

| Voice | Text | Extra video memory |
|---|---|---|
| Voxtral | Convai or Mistral | none |
| Pocket | Convai or Mistral | none |
| Pocket | Local AI lite | about 1.8 GB |
| Pocket | Local AI standard | about 3 GB |
| OmniVoice | Convai or Mistral | about 2 GB |
| OmniVoice | Local AI lite | about 4 GB |
| OmniVoice | Local AI standard | about 5 GB |

## Your own characters

With Mistral or Local AI as the Conversation provider, you can give a person who has no profile in the mod (a character spawned by another mod, such as a Night City Allies follower) a name, a bio, a way of speaking and memories. Face the character, open Settings > Edit characters > Open, and choose **New character** in the page that opens in your browser. **Use the character I'm facing** fills in how the game recognises them (their record name or the name the game shows); you can also type those in. Add a gender and a bio, and Save. The next time you talk to them they answer as the person you wrote. An optional voice clip (see below) gives them a voice of their own; without a clip they speak with a generic voice of their gender. With Convai they talk as an ordinary person, and the game says so once. Characters, clips and what they remember stay on your PC, in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`.

**Voice clips.** You can give a story character, or one of your own characters, a voice clip in the same page: open the character (a story character has a Voice tab), choose **Add voice clip**, pick a WAV, MP3, OGG or FLAC file of 5 to 20 seconds of one person speaking clearly (10 to 18 seconds works best), type the words said in it and choose **Save clip**. Pocket, OmniVoice and Voxtral then copy that voice from that character's next line, once the current reply is over: you do not restart the game or the service. **Remove clip** brings the original voice back the same way. The clip stays on your PC.

**World rules.** In the same editor, choose **World rules** (above the list of characters) to write a few rules for the whole world, for example "Nobody in Night City knows V's name unless V tells them" or "Everyone speaks casually". Every character follows them in every talk (in person, Phone Chat and group chats) with Local AI, Mistral and a Custom endpoint, and Convai gets them with the rest of what the game tells it each turn. They are saved on this computer (up to 2,000 characters), kept when you update the mod, and used from the next reply with no restart. They add facts and style for the setting; they never change the mod's own rules.

**Story characters.** The game's own story characters, such as Judy or Jackie, answer where they stand in their own voice, and their face follows what they say, once you turn it on (Settings > Conversations > Talk to story characters, off by default; reload your save after switching it). Nothing else about them changes.

## Update

Close the game and install the new Scripts over the old ones (Nexus Mods, with Vortex or by hand). That is all most updates need: the Scripts carry the mod's code, and the first start copies it into the Runtime. Get a newer Runtime only when Settings > Help says the Runtime base is too old: it names the version needed, and the update zips below bring you there. Your conversations, memories and settings are kept.

From 0.3.4 the launcher and the native plugin come with the Scripts too, in `red4ext\plugins\AiNpcCyberpunkCode`. An older Runtime's copies of them are renamed at the first start (to `.retired`) and removed later; you do not delete anything.

**When the Runtime base must be updated.** If you already have a Runtime installed, you can skip the full Runtime and download the small **Runtime update** zips instead, from the updates folder on the Hugging Face page (https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates): `Runtime-Update-<from version>-to-<to version>.zip`. Each one holds only the files that changed. The folder keeps every update: apply the update zips one by one, starting from your version. Extract each into your Cyberpunk 2077 folder over your existing Runtime, in the place of the full Runtime (the Scripts and any optional packs are extracted as usual). If Windows asks about files that already exist, choose **Replace**: that is always safe. You do not delete anything yourself (never delete the mod's folders to update: the optional packs live inside them): files that the new version no longer needs are removed by the mod the next time the game starts. If you do not have a Runtime yet, or are not sure which version you have, use the full Runtime; it works for new installs and for any update.

**Game 2.31.** The update zips above are for game 2.5, the default. The update zips for the older game 2.31 are in their own folder, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/game-2.31/updates, with every step since 0.2.2 (the steps after 0.3.1 end in `-for-2.31`). They belong to the 2.31 build only: never extract them over a Runtime for game 2.5, or the other way round. Already on 0.3.0 and moved your game to 2.5? `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip` in the updates folder of the Hugging Face page brings your Runtime to 0.3.1 for game 2.5 in one step, then apply the later steps one by one as usual, together with the 2.5 Scripts. Any other version, or going back to 2.31, needs the full Runtime of your game.

**Updating with Vortex.** Drop the new Scripts zip onto Vortex's Mods page, and only when Settings > Help asks for a newer Runtime base, the Runtime update zips one by one, oldest first. When Vortex asks, choose "Replace the existing mod" (it may first ask to replace the file, say yes), then click Deploy. The full Runtime works the same way: choose Replace. The switch zip for game 2.5 uses the same steps. With Mod Organizer 2, extract each update zip into the Runtime mod's folder.

## Uninstall

Delete these folders from your Cyberpunk 2077 folder. Uninstalling or reinstalling the game through Steam, GOG or Epic leaves them in place, because the launcher only removes its own files:

- `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod` (this also deletes your settings and phone chats)
- `red4ext\plugins\AiNpcCyberpunkCode` (the mod's code, from 0.3.4)
- `red4ext\plugins\AiNpcCyberpunkMod` (this also removes the OmniVoice and Local AI packs)
- `red4ext\plugins\AiNpcCyberpunkModNative`
- `r6\scripts\CyberpunkConvai` (the scripts; internal name), and `r6\audioware\CyberpunkConvai` if an older version left it
- `archive\pc\mod\convai_facial.archive`, `convai_gestures.archive` and, if it is there, `cyberpunk_convai_ambient_driver_guard.archive`
- `HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt`, if it is still there

Then delete `%LOCALAPPDATA%\AiNpcCyberpunkMod` (paste that into the Explorer address bar). It is outside the game folder and holds your memories, conversation history, logs and reports (and the models you added in its `local-ai` folder; copy those out first if you want to keep them), so a mod manager leaves it behind too.

## Error reports

When something in the mod goes wrong, it sends a short error report to the developer's server, so problems can be fixed without asking you for logs. It is on by default. Settings > Privacy > Send error reports automatically turns it off; then nothing is recorded or sent. The first time you load the game after updating, a notice says so once.

A report holds: the error and where in the code it happened; the versions of the mod, the game and the required mods; your conversation provider, voice and Local AI model choices and a few other settings (on or off); what kind of PC it is: your graphics card's name and memory, the PC's total RAM and the memory limit Windows sets (RAM plus the paging file), the processor, the Windows edition, build and display language, the security products Windows lists and whether Smart App Control is on, whether the game runs as administrator, the game's drive (kind, free space, whether it is under Program Files), and the screen's size and refresh rate; the names of your installed mods (the folder and file names of Cyber Engine Tweaks mods, RED4ext plugins, redscript mods and archives, never a path); the setup check's lines; and up to 150 log lines from around the error, with access codes, IDs and your Windows user name removed. Your installation is identified only by a random number hashed twice.

A report never holds: access codes or passwords, what you or the characters say, typed lines, character memories, microphone audio, or your Windows user name. Your IP address is not stored. Reports are sent in the background, never while a character is answering. Reports are kept for 30 days.

## Licence

AI NPC Cyberpunk Mod is released under the AI NPC Cyberpunk Mod Use License (see `LICENSE.txt`): you may use, modify and share it, including commercially, as long as modified versions that offer AI character conversations keep Convai available as a selectable option. You do not have to use Convai. Bundled components keep their own licences (see `THIRD-PARTY-NOTICES.txt`), and Cyberpunk 2077 and its assets belong to their owners.

## Help

Open Settings > Help > Help and support in game. It shows the service status and can create a report to share when asking for help. Generate report saves it in `%LOCALAPPDATA%\AiNpcCyberpunkMod\reports`. If the conversation service is not running, it writes a shorter report at once instead: `runtime\convai-report-lua.txt` in the mod folder (`bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod`). If the service row says "Needs a browser", install a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera, then restart the game.

The mod does not load, or the manager will not open? Post what you see (a screenshot helps) on the mod's Nexus Posts tab or on Discord.

Known issue: if V keeps walking in one direction after you type a message, tap that direction (W, A, S or D) once.
