# Character editor guide

The character editor is a page in your web browser where you change who a character is: their bio, how they talk, what they always know. It runs on your own computer and nothing you write leaves it. This guide is for players. The technical notes are in [CHARACTER_EDITOR.md](CHARACTER_EDITOR.md).

## Open it

1. Start the game and load your save, so the conversation service is running.
2. Open the Companion Manager, then **Settings > Edit characters > Open**. The same page opens from **Character editor** on the manager's Home page.
3. Your browser opens the editor. Choose a character with the button at the top left, or press `/` or Ctrl+K and type a name. The character you were facing when you opened the editor is listed first.
4. Press **Close editor** when you are done. It also closes itself after 30 minutes without use.

## Which conversation providers use your edits

| Provider | Uses the text you write |
| --- | --- |
| Google Gemini | Yes |
| Local AI | Yes |
| Custom | Yes |
| Convai | No |

Convai keeps its own copy of every character in its cloud, shared by all players, so the mod cannot change it. While Convai is answering, the editor shows a warning bar under the top bar and a note above the text fields. Your edits are still saved, and they are used as soon as you choose Google Gemini, Local AI or Custom in **Settings > Conversation provider**.

Convai also answers when the provider you chose cannot be used, for example Google Gemini with no key saved. The warning bar says so. If an edit seems to be ignored, check this first. The page looks again whenever you come back to its tab, so the warning follows what you set in the game.

Some parts of the editor work with every provider, Convai included: **Look and moves** (outfit, gestures, seating, reply length) and **World rules** (the rules for the whole world).

## What each tab does

| Tab | What it is | Limit |
| --- | --- | --- |
| Bio | Who they are, what they know, how they look. | 9,000 characters |
| Speaking style | How they sound: pace, attitude, habits of speech. | 1,800 characters |
| Example lines | Lines in their voice. They show the tone only. Do not put facts here. | 20 lines |
| Speaking rules | Short rules they always follow, such as "Never swear." They outrank the speaking style. | 10 rules |
| Memories, Things they always know | Short facts you write yourself, such as a name or a promise. | 12 facts of 200 characters |
| Memories, Picked up in your talks | Facts the character noticed while you talked. You can change or delete them. A fact you change is kept and is in every talk. Needs the Local AI pack to collect them. | |
| Memories, Short summary of earlier talks | A few sentences about your past talks. Edit or clear them. | |

Everything written for one character together stays under 12,500 characters. **Reset to default** on a tab puts the shipped text back. **Reset everything** does it for the whole character. Your own characters, voice clips and the Prompting page are described in [CHARACTER_EDITOR.md](CHARACTER_EDITOR.md).

## When an edit takes effect

- **At once.** Press **Save** and the very next reply uses the new text. You do not restart the game or the service, and you do not load a save again. A reply that was already being prepared is thrown away and written again.
- **It stays.** Edits are kept on your computer, in the mod's data folder under `%LOCALAPPDATA%\AiNpcCyberpunkMod`. A restart or an update of the mod does not remove them. Only the parts you changed are stored, so a later update to a character still reaches everything you left alone.
- **The old chat steps aside.** When you save, the character stops reading the last few exchanges from before the save. This is on purpose: a small model repeats its own earlier answers, so an old "no, I have no pets" would beat the new fact you just wrote. The talk is not lost. It stays in the character's memory and still feeds the summary of earlier talks. Saving the same words again changes nothing, and **Reset to default** counts as a change.
- **Forget is separate.** **Companion Manager > Settings > Memory > Forget selected character** clears what the character remembers of your talks. It does not touch your edits.

## Make a character know a new fact

1. **Use Memories, Things they always know.** Write one short fact per line, as a plain sentence that names who it is about: "V has a sister called Lena." or "Judy keeps a tabby cat called Biscuit." These lines go into every talk, on every provider, and they are never shortened.
2. **Use the Bio for bigger things:** a history, a look, a change of personality. Put each new piece in a paragraph of its own, with a blank line before and after.
3. **Keep the bio tight.** Smaller models, such as the Local AI Lite model, and slow computers read a shortened character text. When the bio has to be shortened, the paragraphs you added or changed are kept and the shipped paragraphs are dropped from the end first. A very long bio still costs speed, so keep it tight.
4. **Fix the old line, do not just add a new one.** If the shipped bio says the opposite of your fact, change or delete that line. The model reads both and may follow the old one.
5. **Game facts win.** What the game knows about your save, such as quests and how things stand between you and a character, outranks the bio. The editor is best for personal details, habits, history and how someone talks. It cannot change what happened in the story.
6. **Use rules for manners, not for facts.** "Answer in one sentence" is a speaking rule. "Judy has a cat" is a memory.
7. **Test it by asking plainly.** "Do you have any pets?" is a good test. Characters do not bring up their memories on their own unless it fits what you said.

## If a character still does not know

- Is Convai answering? Look for the warning bar. Choose Google Gemini, Local AI or Custom in the settings.
- Did you press **Save**? **Unsaved changes** beside the buttons means you did not. A dot on a tab marks unsaved changes on it.
- Is it the right character? The name at the top of the page is the one you are editing.
- Is the fact buried at the end of a long bio? Move it to Memories.
- Does the bio or a memory say the opposite? Change the old line.
- Is the fact about the story itself, for example who lived or died? The game's facts win, as above.
- Did you edit a fact in **Picked up in your talks**? Up to three of those you changed are in every talk, newest first. More than that, and the rest are found by meaning, which can miss. Move the important ones to **Things they always know**.
- Still wrong? Use **Forget selected character** as described above, then ask again.

## Also on the page

- **New character** makes a character of your own for someone who has no profile, with a name, a bio and a voice clip.
- **World rules** are rules for everyone in every talk, for example "Nobody here knows V by name." They reach Convai as well.
- **Prompting** changes the wording around the character, such as the output rules and the sampling, for each conversation option. Most players never need it.
