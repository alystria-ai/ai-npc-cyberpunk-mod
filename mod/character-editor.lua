-- Settings > Edit characters: asks the conversation service to open the character editor (bridge/character-editor-control.mjs) in the
-- player's browser. The editor is a local page served by the service only while it is open; nothing here runs per frame and nothing
-- is polled: choosing Open writes one small file, runtime/editor-command.json, and the service answers in its own time.
--
-- The page's sentences are translated here, with the mod's dictionaries (ui.t), and travel in the same file, so the page follows
-- the interface language the player chose. A sentence with no translation is shown in English.
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
        ['You have changes that are not saved. Leave without saving?'] = ui.t('You have changes that are not saved. Leave without saving?'),
        ['{count} of {max}'] = ui.t('{count} of {max}'),
        ['Delete'] = ui.t('Delete'),
        ['Saved.'] = ui.t('Saved.'),
        ['Go back to the shipped text for {name}? All your changes to this character are removed.'] = ui.t('Go back to the shipped text for {name}? All your changes to this character are removed.'),
        ['Go back to the shipped text for {name}? Your changes to this part are removed.'] = ui.t('Go back to the shipped text for {name}? Your changes to this part are removed.'),
        ['Back to the shipped text.'] = ui.t('Back to the shipped text.'),
        ['Save'] = ui.t('Save'),
        ['Reset to default'] = ui.t('Reset to default'),
        ['Things they always know'] = ui.t('Things they always know'),
        ['Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'] = ui.t('Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'),
        ['Add a memory'] = ui.t('Add a memory'),
        ['For example: V has a sister called Lena.'] = ui.t('For example: V has a sister called Lena.'),
        ['Everyday people do not keep memories of your talks.'] = ui.t('Everyday people do not keep memories of your talks.'),
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
        ['Bio'] = ui.t('Bio'),
        ['Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'] = ui.t('Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'),
        ['Speaking style'] = ui.t('Speaking style'),
        ['How they sound: pace, attitude, favourite habits of speech.'] = ui.t('How they sound: pace, attitude, favourite habits of speech.'),
        ['Example lines'] = ui.t('Example lines'),
        ['Lines in their voice. They show the tone only and are never said back word for word.'] = ui.t('Lines in their voice. They show the tone only and are never said back word for word.'),
        ['Add a line'] = ui.t('Add a line'),
        ['A line this character might say'] = ui.t('A line this character might say'),
        ['Speaking rules'] = ui.t('Speaking rules'),
        ['Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'] = ui.t('Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'),
        ['Add a rule'] = ui.t('Add a rule'),
        ['A short rule'] = ui.t('A short rule'),
        ['Choose a character on the left.'] = ui.t('Choose a character on the left.'),
        ['Parts of the character'] = ui.t('Parts of the character'),
        ['Edited'] = ui.t('Edited'),
        ['As shipped'] = ui.t('As shipped'),
        ['Reset everything'] = ui.t('Reset everything'),
        ['Story characters'] = ui.t('Story characters'),
        ['Everyday people'] = ui.t('Everyday people'),
        ['No match.'] = ui.t('No match.'),
        ['Character editor'] = ui.t('Character editor'),
        ['Your changes work with Mistral and Local. They do not apply to Convai.'] = ui.t('Your changes work with Mistral and Local. They do not apply to Convai.'),
        ['Close editor'] = ui.t('Close editor'),
        ['Search characters'] = ui.t('Search characters'),
        ['Changes are saved on this computer and used from the next reply.'] = ui.t('Changes are saved on this computer and used from the next reply.'),
        ['Convai is answering right now, so these changes have no effect yet. Choose Mistral or Local as the conversation provider in the settings.'] = ui.t('Convai is answering right now, so these changes have no effect yet. Choose Mistral or Local as the conversation provider in the settings.'),
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
        local sent = pcall(function()
            local payload = {version = 1, id = 'e' .. os.time() .. '-' .. counter, action = 'open', issuedAt = os.time() * 1000.0,
                language = ui.current and ui.current() or 'en', strings = pageText()}
            if not write(json.encode(payload)) then error('write failed') end
        end)
        if not sent then return false, ui.t('The editor could not be opened. Try again.') end
        return true, ui.t('Opening the editor in your browser. Switch to your browser if it does not come to the front.')
    end

    return self
end

return M
