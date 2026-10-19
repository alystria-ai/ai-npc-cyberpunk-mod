-- Settings > Edit characters: asks the conversation service to open the character editor (bridge/character-editor-control.mjs) in the
-- player's browser. The editor is a local page served by the service only while it is open; nothing here runs per frame and nothing
-- is polled: choosing Open writes one small file, runtime/editor-command.json, and the service answers in its own time.
--
-- The page's sentences are translated here, with the mod's dictionaries (ui.t), and travel in the same file, so the page follows
-- the interface language the player chose. A sentence with no translation is shown in English.
--
-- The same command carries, when the game can say it, the character V is facing (options.facing: one targeting query, asked once, here, when
-- the player chose Open) so the "New character" form can fill in its match rule. options.watch tells the list of the player's own characters
-- (mod/custom-characters.lua) that one may be made now.
local M = {version = 1}

local COMMAND = 'runtime/editor-command.json'

function M.new(options)
    local ui = options.ui
    local self = {}
    local counter = 0

    -- Every sentence of the page (bridge/character-editor-page.mjs). The key is the English source; the value its translation.
    local function pageText()
        return {
        ['That character was not found.'] = ui.t('That character was not found.'),
        ['Could not save. Try again.'] = ui.t('Could not save. Try again.'),
        ['The bio is too short. Use at least {max} characters.'] = ui.t('The bio is too short. Use at least {max} characters.'),
        ['The bio is too long. Keep it under {max} characters.'] = ui.t('The bio is too long. Keep it under {max} characters.'),
        ['The speaking style is too long. Keep it under {max} characters.'] = ui.t('The speaking style is too long. Keep it under {max} characters.'),
        ['Too many rules. Keep {max} or fewer.'] = ui.t('Too many rules. Keep {max} or fewer.'),
        ['A rule is too long. Keep each one under {max} characters.'] = ui.t('A rule is too long. Keep each one under {max} characters.'),
        ['Too many example lines. Keep {max} or fewer.'] = ui.t('Too many example lines. Keep {max} or fewer.'),
        ['An example line is too long. Keep each one under {max} characters.'] = ui.t('An example line is too long. Keep each one under {max} characters.'),
        ['The example lines are too long together. Keep them under {max} characters in all.'] = ui.t('The example lines are too long together. Keep them under {max} characters in all.'),
        ['Too many memories. Keep {max} or fewer.'] = ui.t('Too many memories. Keep {max} or fewer.'),
        ['A memory is too long. Keep each one under {max} characters.'] = ui.t('A memory is too long. Keep each one under {max} characters.'),
        ['Everything together is too long. Shorten something so it stays under {max} characters.'] = ui.t('Everything together is too long. Shorten something so it stays under {max} characters.'),
        ['Give the character a name.'] = ui.t('Give the character a name.'),
        ['The name is too long. Keep it under {max} characters.'] = ui.t('The name is too long. Keep it under {max} characters.'),
        ['Choose a gender.'] = ui.t('Choose a gender.'),
        ['Too many record names. Keep {max} or fewer.'] = ui.t('Too many record names. Keep {max} or fewer.'),
        ['A record name can only use letters, digits, dots, dashes and underscores, for example Character.Rebecca.'] = ui.t('A record name can only use letters, digits, dots, dashes and underscores, for example Character.Rebecca.'),
        ['Too many display names. Keep {max} or fewer.'] = ui.t('Too many display names. Keep {max} or fewer.'),
        ['A display name is too long. Keep each one under {max} characters.'] = ui.t('A display name is too long. Keep each one under {max} characters.'),
        ['Add a record name or a display name, so the game can find this character.'] = ui.t('Add a record name or a display name, so the game can find this character.'),
        ['Another character of yours, {other}, already answers to this record or name.'] = ui.t('Another character of yours, {other}, already answers to this record or name.'),
        ['{other} already has a profile in the mod, and that profile always wins. Use another record or name.'] = ui.t('{other} already has a profile in the mod, and that profile always wins. Use another record or name.'),
        ['You have made as many characters as the editor keeps ({max}). Delete one first.'] = ui.t('You have made as many characters as the editor keeps ({max}). Delete one first.'),
        ['That file is not a recording the voices can read. Use a WAV, MP3, OGG or FLAC file.'] = ui.t('That file is not a recording the voices can read. Use a WAV, MP3, OGG or FLAC file.'),
        ['This computer cannot convert that file. Save it as a WAV and try again.'] = ui.t('This computer cannot convert that file. Save it as a WAV and try again.'),
        ['You have as many voice clips as the editor keeps ({max}). Remove one first.'] = ui.t('You have as many voice clips as the editor keeps ({max}). Remove one first.'),
        ['That file is too big for a voice clip.'] = ui.t('That file is too big for a voice clip.'),
        ['The recording is too low in quality. Use at least {min} Hz.'] = ui.t('The recording is too low in quality. Use at least {min} Hz.'),
        ['The clip is too short. Use at least {min} seconds.'] = ui.t('The clip is too short. Use at least {min} seconds.'),
        ['The clip is too long. Use at most {max} seconds.'] = ui.t('The clip is too long. Use at most {max} seconds.'),
        ['The recording is distorted. Record it again, a little quieter.'] = ui.t('The recording is distorted. Record it again, a little quieter.'),
        ['The recording is too quiet to copy. Record it louder, or closer to the microphone.'] = ui.t('The recording is too quiet to copy. Record it louder, or closer to the microphone.'),
        ['The clip is mostly silence. Use a clip where somebody is talking most of the time.'] = ui.t('The clip is mostly silence. Use a clip where somebody is talking most of the time.'),
        ['Type the words said in the clip, at least {min} characters.'] = ui.t('Type the words said in the clip, at least {min} characters.'),
        ['The words said in the clip are too long. Keep them under {max} characters.'] = ui.t('The words said in the clip are too long. Keep them under {max} characters.'),
        ['You have changes that are not saved. Leave without saving?'] = ui.t('You have changes that are not saved. Leave without saving?'),
        ['{count} of {max}'] = ui.t('{count} of {max}'),
        ['Delete'] = ui.t('Delete'),
        ['Saved.'] = ui.t('Saved.'),
        ['Go back to the shipped text for {name}? All your changes to this character are removed.'] = ui.t('Go back to the shipped text for {name}? All your changes to this character are removed.'),
        ['Go back to the shipped text for {name}? Your changes to this part are removed.'] = ui.t('Go back to the shipped text for {name}? Your changes to this part are removed.'),
        ['Back to the shipped text.'] = ui.t('Back to the shipped text.'),
        ['Save'] = ui.t('Save'),
        ['Reset to default'] = ui.t('Reset to default'),
        ['Memory'] = ui.t('Memory'),
        ['A memory cannot be empty.'] = ui.t('A memory cannot be empty.'),
        ['Delete this memory?'] = ui.t('Delete this memory?'),
        ['Deleted.'] = ui.t('Deleted.'),
        ['Picked up in your talks'] = ui.t('Picked up in your talks'),
        ['Facts the character noticed while you talked. Change or delete the ones that are wrong.'] = ui.t('Facts the character noticed while you talked. Change or delete the ones that are wrong.'),
        ['The Local AI pack finds these. It is not installed or not ready, so none are collected now.'] = ui.t('The Local AI pack finds these. It is not installed or not ready, so none are collected now.'),
        ['Nothing yet.'] = ui.t('Nothing yet.'),
        ['Short summary of earlier talks'] = ui.t('Short summary of earlier talks'),
        ['A few sentences the character keeps about your past talks. Edit them or clear them.'] = ui.t('A few sentences the character keeps about your past talks. Edit them or clear them.'),
        ['Clear the summary?'] = ui.t('Clear the summary?'),
        ['Cleared.'] = ui.t('Cleared.'),
        ['Clear'] = ui.t('Clear'),
        ['Things they always know'] = ui.t('Things they always know'),
        ['Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'] = ui.t('Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'),
        ['Add a memory'] = ui.t('Add a memory'),
        ['For example: V has a sister called Lena.'] = ui.t('For example: V has a sister called Lena.'),
        ['Everyday people do not keep memories of your talks.'] = ui.t('Everyday people do not keep memories of your talks.'),
        ['The game did not name anyone. Face the character, then choose Settings > Edit characters > Open in the game again.'] = ui.t('The game did not name anyone. Face the character, then choose Settings > Edit characters > Open in the game again.'),
        ['Filled in from the character you were facing: {name}.'] = ui.t('Filled in from the character you were facing: {name}.'),
        ['Saved. The clip is a little short: 10 to 18 seconds copies best.'] = ui.t('Saved. The clip is a little short: 10 to 18 seconds copies best.'),
        ['Saved. The clip is a little long: 10 to 18 seconds copies best.'] = ui.t('Saved. The clip is a little long: 10 to 18 seconds copies best.'),
        ['Delete {name}? The character, its voice clip and what it remembers of you are removed.'] = ui.t('Delete {name}? The character, its voice clip and what it remembers of you are removed.'),
        ['Remove the voice clip? The character goes back to a generic voice.'] = ui.t('Remove the voice clip? The character goes back to a generic voice.'),
        ['Clip removed.'] = ui.t('Clip removed.'),
        ['The saved clip could not be loaded.'] = ui.t('The saved clip could not be loaded.'),
        ['Remove the voice clip? {name} goes back to the shipped voice.'] = ui.t('Remove the voice clip? {name} goes back to the shipped voice.'),
        ['Save clip'] = ui.t('Save clip'),
        ['Chosen file: {name}, {seconds} seconds.'] = ui.t('Chosen file: {name}, {seconds} seconds.'),
        ['Chosen file: {name} ({size}). It is checked when you save it.'] = ui.t('Chosen file: {name} ({size}). It is checked when you save it.'),
        ['Optional. Pocket, OmniVoice and the Voxtral cloud voice copy a clip you add. Without one the character speaks with a generic voice that fits the gender.'] = ui.t('Optional. Pocket, OmniVoice and the Voxtral cloud voice copy a clip you add. Without one the character speaks with a generic voice that fits the gender.'),
        ['A clip you add replaces the shipped voice of this character for Pocket, OmniVoice and the Voxtral cloud voice.'] = ui.t('A clip you add replaces the shipped voice of this character for Pocket, OmniVoice and the Voxtral cloud voice.'),
        ['Use {min} to {max} seconds of one person speaking clearly, with no music or other voices. {goodMin} to {goodMax} seconds copies best. WAV, MP3, OGG or FLAC.'] = ui.t('Use {min} to {max} seconds of one person speaking clearly, with no music or other voices. {goodMin} to {goodMax} seconds copies best. WAV, MP3, OGG or FLAC.'),
        ['Play saved clip'] = ui.t('Play saved clip'),
        ['No clip yet.'] = ui.t('No clip yet.'),
        ['This character speaks with the shipped voice.'] = ui.t('This character speaks with the shipped voice.'),
        ['This character speaks with a generic voice that fits the gender.'] = ui.t('This character speaks with a generic voice that fits the gender.'),
        ['Add voice clip'] = ui.t('Add voice clip'),
        ['A new or removed clip counts from the next line this character speaks, once the current reply is over. Nothing needs restarting.'] = ui.t('A new or removed clip counts from the next line this character speaks, once the current reply is over. Nothing needs restarting.'),
        ['Saved clip: {seconds} seconds.'] = ui.t('Saved clip: {seconds} seconds.'),
        ['Voice'] = ui.t('Voice'),
        ['Words said in the clip'] = ui.t('Words said in the clip'),
        ['Type what the clip says, as spoken. OmniVoice needs it to copy the voice.'] = ui.t('Type what the clip says, as spoken. OmniVoice needs it to copy the voice.'),
        ['Remove clip'] = ui.t('Remove clip'),
        ['Female'] = ui.t('Female'),
        ['Male'] = ui.t('Male'),
        ['Choose a gender'] = ui.t('Choose a gender'),
        ['Use the character I’m facing'] = ui.t('Use the character I’m facing'),
        ['Your own characters talk only with Mistral or Local AI. With Convai they speak as an ordinary person.'] = ui.t('Your own characters talk only with Mistral or Local AI. With Convai they speak as an ordinary person.'),
        ['Name'] = ui.t('Name'),
        ['The name the character goes by. They give it when somebody asks who they are.'] = ui.t('The name the character goes by. They give it when somebody asks who they are.'),
        ['Gender'] = ui.t('Gender'),
        ['It picks the voice when the character has no clip.'] = ui.t('It picks the voice when the character has no clip.'),
        ['How the game finds this character'] = ui.t('How the game finds this character'),
        ['The game recognises the person you talk to by a record name, a display name, or both. A record name looks like Character.Rebecca or NCA.Rebecca. Add at least one.'] = ui.t('The game recognises the person you talk to by a record name, a display name, or both. A record name looks like Character.Rebecca or NCA.Rebecca. Add at least one.'),
        ['Record names'] = ui.t('Record names'),
        ['The name of the character’s record in the game files.'] = ui.t('The name of the character’s record in the game files.'),
        ['Add a record name'] = ui.t('Add a record name'),
        ['For example: Character.Rebecca'] = ui.t('For example: Character.Rebecca'),
        ['Display names'] = ui.t('Display names'),
        ['The name the game shows for the character.'] = ui.t('The name the game shows for the character.'),
        ['Add a display name'] = ui.t('Add a display name'),
        ['For example: Rebecca'] = ui.t('For example: Rebecca'),
        ['Bio'] = ui.t('Bio'),
        ['Who this character is, what they know and how they look. Writing it as “I am …” works best. A long bio makes replies slower, so keep it tight.'] = ui.t('Who this character is, what they know and how they look. Writing it as “I am …” works best. A long bio makes replies slower, so keep it tight.'),
        ['Speaking style'] = ui.t('Speaking style'),
        ['How they sound: pace, attitude, favourite habits of speech.'] = ui.t('How they sound: pace, attitude, favourite habits of speech.'),
        ['Example lines'] = ui.t('Example lines'),
        ['Lines in their voice. They show the tone only and are never said back word for word.'] = ui.t('Lines in their voice. They show the tone only and are never said back word for word.'),
        ['Add a line'] = ui.t('Add a line'),
        ['A line this character might say'] = ui.t('A line this character might say'),
        ['Save the character first. Then it can have a voice clip, and it starts to remember your talks.'] = ui.t('Save the character first. Then it can have a voice clip, and it starts to remember your talks.'),
        ['Delete character'] = ui.t('Delete character'),
        ['Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'] = ui.t('Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'),
        ['Speaking rules'] = ui.t('Speaking rules'),
        ['Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'] = ui.t('Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'),
        ['Add a rule'] = ui.t('Add a rule'),
        ['A short rule'] = ui.t('A short rule'),
        ['Choose a character on the left.'] = ui.t('Choose a character on the left.'),
        ['New character'] = ui.t('New character'),
        ['Your character'] = ui.t('Your character'),
        ['Memories'] = ui.t('Memories'),
        ['Parts of the character'] = ui.t('Parts of the character'),
        ['Edited'] = ui.t('Edited'),
        ['As shipped'] = ui.t('As shipped'),
        ['Reset everything'] = ui.t('Reset everything'),
        ['Your characters'] = ui.t('Your characters'),
        ['Story characters'] = ui.t('Story characters'),
        ['Everyday people'] = ui.t('Everyday people'),
        ['No match.'] = ui.t('No match.'),
        ['Character editor'] = ui.t('Character editor'),
        ['Your changes work with Mistral and Local AI. They do not apply to Convai.'] = ui.t('Your changes work with Mistral and Local AI. They do not apply to Convai.'),
        ['Close editor'] = ui.t('Close editor'),
        ['Search characters'] = ui.t('Search characters'),
        ['Changes are saved on this computer and used from the next reply.'] = ui.t('Changes are saved on this computer and used from the next reply.'),
        ['Convai is answering right now, so these changes have no effect yet. Choose Mistral or Local AI as the conversation provider in the settings.'] = ui.t('Convai is answering right now, so these changes have no effect yet. Choose Mistral or Local AI as the conversation provider in the settings.'),
        ['The editor is closed. You can close this tab.'] = ui.t('The editor is closed. You can close this tab.'),
        }
    end

    local function write(text)
        local ok = pcall(function()
            local file = io.open(COMMAND, 'wb')
            if not file then error('no file') end
            local wrote = file:write(text); file:close()
            if not wrote then error('write failed') end
        end)
        return ok
    end

    -- The Open action. Returns ok, message.
    function self.request()
        local state = options.serviceState and options.serviceState() or 'unknown'
        if state == 'stopped' then
            return false, ui.t('The conversation service is not running, so the editor cannot open. Restart the game.')
        end
        counter = counter + 1
        if options.watch then pcall(options.watch) end
        local facing = nil
        if options.facing then
            local ok, value = pcall(options.facing)
            if ok and type(value) == 'table' then facing = value end
        end
        local sent = pcall(function()
            local payload = {version = 1, id = 'e' .. os.time() .. '-' .. counter, action = 'open', issuedAt = os.time() * 1000.0,
                language = ui.current and ui.current() or 'en', strings = pageText(), facing = facing}
            if not write(json.encode(payload)) then error('write failed') end
        end)
        if not sent then return false, ui.t('The editor could not be opened. Try again.') end
        return true, ui.t('Opening the editor in your browser. Switch to your browser if it does not come to the front.')
    end

    return self
end

return M
