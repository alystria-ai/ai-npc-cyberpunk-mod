# Example content pack

A content pack is an add-on that is only data: this folder holds `convai-addon.json` and `characters.json`, nothing else. It needs AI NPC Cyberpunk Mod with add-on API 1.1 and works on both supported game versions with the same files.

What this one does while it is on (Settings > Content packs):

- every character gets two extra world rules and a changed closing line in the prompt (Mistral, Local AI and Custom; Convai gets only the world rules),
- Judy Alvarez is called "Judith of the Example" and speaks from the text in `characters.json` (the old name still works),
- the characters keep a separate memory while it is on.

Install: copy this folder into `bin/x64/plugins/cyber_engine_tweaks/mods/` as `AiNpcCyberpunkModExampleContent`. See `docs/ADDON_API.md`, "Content packs".
