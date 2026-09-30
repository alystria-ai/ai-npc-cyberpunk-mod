-- Loaded by the adapter on demand. The output stays in this mod's runtime directory.
local requestFile = io.open('runtime/diagnostic-request.txt', 'rb')
local request = requestFile and requestFile:read('*a') or ''
if requestFile then requestFile:close() end
if request:match('^speech%-cadence:') then
    if request:match('^speech%-cadence:stop:') then
        if convaiSpeechCadenceProbe then convaiSpeechCadenceProbe.stop('cancelled') end
    else
        if convaiSpeechCadenceProbe then convaiSpeechCadenceProbe.stop('replaced') end
        convaiSpeechCadenceProbe = dofile('speech-cadence-probe.lua').new({
            speech=assert(convaiSpeech), face=assert(convaiFacialPlayback)})
        convaiSpeechCadenceProbe.start()
    end
    return
end
if request:match('^fact%-identity%-read:') then
    if not convaiFactIdentityProbe then
        convaiFactIdentityProbe = dofile('fact-identity-probe.lua').new({request = request,
            names = dofile('fact-identity.lua').factNames,
            getFacts = function() return Game.GetQuestsSystem() end,
            observe = function(class, method, callback) ObserveAfter(class, method, callback) end,
            world = function()
                local player = Game.GetPlayer()
                return {playerPresent = player ~= nil, attached = player and player:IsAttached() or false,
                    preGame = Game.GetSystemRequestsHandler():IsPreGame()}
            end,
            publish = function(value)
                local raw = json.encode(value)
                assert(#raw <= 131072, 'read-only probe report too large')
                local file = assert(io.open('runtime/fact-identity-probe.json', 'wb'))
                file:write(raw); file:close()
            end})
        convaiFactIdentityProbe.arm()
    elseif request:match('^fact%-identity%-read:stop:') then
        convaiFactIdentityProbe.stop()
    else
        convaiFactIdentityProbe.read()
    end
    return
end
if request:match('^knowledge%-capture:') then
    return dofile('knowledge-probe.lua')
end
if request:match('^subtitles%-style:') then
    local report = {request = request}
    local ok, err = pcall(function()
        local style = request:match('^subtitles%-style:([%a]+):')
        assert(style == 'dialogue' or style == 'overhead', 'Choose dialogue or overhead')
        assert(not (convaiSpeech and convaiSpeech.requestId), 'Wait for the current reply to finish')
        local api = assert(GetMod('ModConfigurationMenuAPI'), 'MCM unavailable')
        local provider = assert(api.providers.getProvider('cyberpunk-convai'), 'Companion Manager unavailable')
        report.before = convaiSubtitles.style()
        -- Use the running manager's transaction, so memory and disk agree.
        local result = provider.applyBatch('manager', {{id = 'subtitleStyle', value = style == 'overhead' and 1 or 2}})
        assert(result and result.ok, result and result.error or 'Subtitle preference was not saved')
        convaiSubtitles.clear()
        report.after = convaiSubtitles.style()
        assert(report.after == style, 'Running subtitle preference did not change')
        if not api.hasDrafts('cyberpunk-convai:manager') then api.reloadMod('cyberpunk-convai:manager') end
    end)
    report.ok, report.error = ok, not ok and tostring(err) or nil
    local file = io.open('runtime/subtitles-style.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^subtitles%-refresh:') then
    local report = {request = request}
    local ok, err = pcall(function()
        assert(not (convaiSpeech and convaiSpeech.requestId), 'Wait for the current reply to finish')
        local subtitles = dofile('subtitles.lua')
        subtitles.clear()
        assert(subtitles.install(), 'Native subtitle hook unavailable')
        -- The provider owns the live manager closures. Refresh just this row's
        -- reset value without recreating the manager or disturbing MCM drafts.
        local api = GetMod('ModConfigurationMenuAPI')
        local provider = api and api.providers.getProvider('cyberpunk-convai')
        if provider and not provider.convaiDialogueDefault then
            local previousLoad = provider.loadMod
            provider.loadMod = function(id, ...)
                local schema, problem = previousLoad(id, ...)
                for _, category in ipairs(schema and schema.categories or {}) do
                    for _, row in ipairs(category.settings or {}) do
                        if row.id == 'subtitleStyle' then
                            row.defaultValue = 2
                            row.description = 'Use the regular dialogue HUD by default, or place subtitles above the speaking companion. The Subtitles switch controls both.'
                        end
                    end
                end
                return schema, problem
            end
            provider.convaiDialogueDefault = true
        end
        report.managerDefaultUpdated = provider and provider.convaiDialogueDefault or false
        if api and not api.hasDrafts('cyberpunk-convai:manager') then api.reloadMod('cyberpunk-convai:manager') end
        report.adapter = subtitles.status()
        report.style = subtitles.style()
    end)
    report.ok, report.error = ok, not ok and tostring(err) or nil
    local file = io.open('runtime/subtitles-refresh.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^overhead%-state:') then
    local report = {request = request, controllers = {}, rendered = convaiOverheadProbe and convaiOverheadProbe.rendered,
        adapter = convaiSubtitles and convaiSubtitles.status and convaiSubtitles.status()}
    local ok, err = pcall(function()
        for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
            for _, controller in ipairs(layer:GetGameControllers()) do
                if controller:IsA('ChattersGameController') then
                    local entry = {visible = controller:GetRootWidget():IsVisible()}
                    report.controllers[#report.controllers + 1] = entry
                end
            end
        end
    end)
    report.ok, report.error = ok, not ok and tostring(err) or nil
    local file = io.open('runtime/overhead-state.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^overhead%-probe:') or request:match('^subtitles%-preview:') then
    local report = {request = request}
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        assert(player and player:IsAttached() and not player:IsDeadNoStatPool(), 'Player unavailable')
        assert(not Game.GetSystemRequestsHandler():IsGamePaused(), 'Game is paused')
        local people = convaiCompanions.conversationCandidates(player, 20)
        assert(people and people[1] and people[1].npc, 'No nearby companion')
        local person, subtitles = people[1], convaiSubtitles
        local previewStyle = request:match('^subtitles%-preview:([%a]+):') or 'overhead'
        assert(previewStyle == 'overhead' or previewStyle == 'dialogue', 'Choose dialogue or overhead')
        assert(subtitles, 'Subtitle adapter unavailable')
        assert(not subtitles.line and not (convaiSpeech and convaiSpeech.requestId), 'Wait for the current reply to finish')
        assert(person.npc:IsAttached() and not person.npc:IsDeadNoStatPool(), 'Companion unavailable')
        local settings = UserSettings.new()
        report.nativeOverheads = settings:GetVar('/accessibility/subtitles', 'Overheads'):GetValue()
        report.speaker, report.entity = person.name, person.entity
        convaiOverheadProbe = convaiOverheadProbe or {}
        if not convaiOverheadProbe.afterHook then
            convaiOverheadProbe.afterHook = true
            ObserveAfter('ChatterLineLogicController', 'SetLineData', function(controller, shown)
                local capture = convaiOverheadProbe
                if not capture.id or os.time() > capture.expiresAt or tostring(shown.id) ~= capture.id then return end
                local passed, detail = pcall(function()
                    return {id = tostring(shown.id), entity = tostring(controller:GetOwnerID().hash),
                        text = shown.text, widgetVisible = controller:GetRootWidget():IsVisible(),
                        hasProjection = controller:GetProjection() ~= nil, at = os.time()}
                end)
                capture.rendered = passed and detail or {error = tostring(detail)}
            end)
        end
        if not convaiOverheadProbe.dialogueHook then
            convaiOverheadProbe.dialogueHook = true
            ObserveAfter('SubtitleLineLogicController', 'SetLineData', function(controller, shown)
                local capture = convaiOverheadProbe
                if not capture.id or os.time() > capture.expiresAt or tostring(shown.id) ~= capture.id then return end
                capture.rendered = {id = tostring(shown.id), text = shown.text,
                    renderer = 'native-dialogue', widgetVisible = controller:GetRootWidget():IsVisible(), at = os.time()}
            end)
        end
        -- Previewing either layout does not change the saved or running choice.
        local previousStyle = subtitles.styleProvider
        subtitles.configure({style = function() return previewStyle end})
        local shown, result = pcall(subtitles.show, person.name,
            'These streets never seem to sleep. Keep close and watch the next dark corner.', person.npc, person.entity)
        subtitles.configure({style = previousStyle})
        assert(shown and result, 'Test subtitle unavailable: ' .. tostring(result))
        local line = subtitles.line
        convaiOverheadProbe.id, convaiOverheadProbe.expiresAt, convaiOverheadProbe.rendered = tostring(line.id), os.time() + 10, nil
        subtitles.remaining = 8
        report.line = tostring(line.id)
        report.previewStyle, report.savedStyle = previewStyle, subtitles.style()
    end)
    report.ok, report.error = ok, not ok and tostring(err) or nil
    local file = io.open('runtime/overhead-probe.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^loot%-state:') then
    local report = {request = request, at = os.time() * 1000,
        observer = convaiLootObserver and convaiLootObserver.status() or {available = false},
        policy = convaiLootReactions and convaiLootReactions.status() or {available = false},
        pending = convaiLootReactions and convaiLootReactions.capture() or {available = false},
        battle = convaiBattleReactions and convaiBattleReactions.status() or {available = false}}
    local file = io.open('runtime/loot-state.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^loot%-inventory%-state:') then
    local report = {request = request}
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        local first, second = Game.GetTransactionSystem():GetItemList(player)
        report.firstType, report.secondType = type(first), type(second)
        local items = type(second) == 'table' and second or type(first) == 'table' and first
        report.count = items and #items
        report.examples = {}
        for i = 1, math.min(items and #items or 0, 3) do
            report.examples[i] = {identity = tostring(ItemID.GetCombinedHash(items[i]:GetID())), quantity = items[i]:GetQuantity()}
        end
    end)
    report.ok, report.error = ok, not ok and tostring(err) or nil
    local file = io.open('runtime/loot-inventory-state.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^loot%-test%-drop:') then
    local report = {request = request, record = 'Items.LowQualityDrink10', quantity = 2}
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        assert(player and player:IsAttached() and not player:IsDeadNoStatPool(), 'Player is unavailable')
        assert(PlayerPuppet.GetSceneTier(player) == 1 and not player:IsInCombat(), 'Return to safe open gameplay')
        local id = ItemID.FromTDBID(TweakDBID.new(report.record))
        local transaction = Game.GetTransactionSystem()
        report.before = transaction:GetItemQuantity(player, id)
        assert(transaction:GiveItem(player, id, report.quantity), 'Test item grant failed')
        report.afterGrant = transaction:GetItemQuantity(player, id)
        assert(report.afterGrant == report.before + report.quantity, 'Unexpected test item count')
        local instructions = {DropInstruction.Create(id, report.quantity)}
        report.spawnAccepted = Game.GetLootManager():SpawnItemDropOfManyItems(player, instructions,
            CName.new('playerDropBag'), player:GetWorldPosition())
        report.afterDrop = transaction:GetItemQuantity(player, id)
        assert(report.spawnAccepted, 'Native drop request failed; the two test drinks remain in inventory')
        report.position = {x = player:GetWorldPosition().x, y = player:GetWorldPosition().y, z = player:GetWorldPosition().z}
    end)
    report.ok, report.error = ok, not ok and tostring(err) or nil
    local file = io.open('runtime/loot-test-drop.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^loot%-probe:') then
    local probe = dofile('loot-probe.lua')
    local action = request:match('^loot%-probe:([^:]+):')
    local report
    if action == 'start' then report = probe.start({seconds = 300, maxEvents = 512})
    elseif action == 'stop' then report = probe.stop('diagnostic-finished')
    else report = probe.status() end
    report.request = request
    local file = io.open('runtime/loot-probe.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^battle%-context:') then
    local observer, player = dofile('battle-observer.lua'), Game.GetPlayer()
    local report = observer.sample(player)
    report.companions = {}
    report.candidateRadius = 100
    if convaiCompanions and player then
        for _, person in ipairs(convaiCompanions.conversationCandidates(player, report.candidateRadius)) do
            local available, reason, waiting = observer.canSpeak(person.npc, report.combat and 'start' or 'end')
            local speaker = {profile = person.profileKey, distance = person.distance, available = available,
                reason = reason, temporarilyBusy = waiting, withinReactionRange = person.distance <= 20}
            pcall(function()
                local scene = Game.GetSceneSystem():GetScriptInterface()
                speaker.dialogue = scene:IsEntityInDialogue(person.npc:GetEntityID())
                speaker.scene = scene:IsEntityInScene(person.npc:GetEntityID())
                speaker.combat = NPCPuppet.IsInCombat(person.npc)
                speaker.autonomous = person.npc:IsOnAutonomousAI()
            end)
            report.companions[#report.companions + 1] = speaker
        end
    end
    if convaiBattleReactions then report.scheduler = convaiBattleReactions.status() end
    local file = io.open('runtime/battle-context-probe.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^quest%-context:') then
    local context = dofile('quest-context.lua')
    local report = {snapshot = context.capture()}
    report.error = context.lastError
    local file = io.open('runtime/quest-context-probe.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^phone%-chat%-style:') then
    local style = dofile('phone-chat-style.lua')
    style.lastError = nil
    local ok, err = pcall(function() style.install(true); style.refresh(true) end)
    if ok and convaiPhoneChat then convaiPhoneChat.dirty = true end
    local failure = style.lastError
    if not ok then failure = tostring(err) end
    local file = io.open('runtime/phone-chat-style.json', 'wb')
    if file then
        file:write(json.encode({ok = ok and failure == nil, error = failure,
            header = style.headerPatched, selectedIndex = style.headerIndex,
            composer = style.composerPatched, choicesHidden = style.choicesHidden}))
        file:close()
    end
    return
end
if request:match('^phone%-chat%-state:') then
    local chat = convaiPhoneChat
    local report = {contact = chat and chat.contact, error = chat and chat.lastError,
        styleError = convaiPhoneChatStyle and convaiPhoneChatStyle.lastError,
        storedLines = chat and #(chat.history[chat.contact] or {}),
        pending = chat and chat.pending and {contact = chat.pending.contact, id = chat.pending.id},
        widgets = {}}
    local ok, err = pcall(function()
        local player = Game.GetPlayer()
        report.typing = player and player:ConvaiPhoneChatTyping()
        for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
            for _, controller in ipairs(layer:GetGameControllers()) do
                local class = NameToString(controller:GetClassName())
                if class == 'PhoneMessagePopupGameController' or (request:find(':all:') and class == 'NewHudPhoneGameController') then
                    if class == 'PhoneMessagePopupGameController' then
                        report.popup = {}
                        pcall(function() report.popup.contact = controller:ConvaiChatContact() end)
                    end
                    local function visit(widget, depth, path)
                        if not widget or depth > 18 or #report.widgets >= 1800 then return end
                        local item = {name = NameToString(widget:GetName()), class = NameToString(widget:GetClassName()),
                            depth = depth, visible = widget:IsVisible(), width = widget:GetWidth(), height = widget:GetHeight()}
                        if item.name == '' then
                            for _, name in ipairs({'convaiChatTabLayout', 'convaiChatTabGlyph', 'convaiChatTabLabel',
                                'convaiChatTabUnderline', 'convaiPhoneChatStyleMode'}) do
                                if widget:GetName() == CName.new(name) then item.name = name; break end
                            end
                        end
                        item.path = path .. '/' .. item.name
                        pcall(function() item.state = NameToString(widget:GetState()) end)
                        pcall(function() item.opacity = widget:GetOpacity() end)
                        if request:find(':messages:') then
                            pcall(function() item.text = string.sub(widget:GetText(), 1, 200) end)
                        end
                        pcall(function() local c=widget:GetTintColor(); item.tint={r=c.Red,g=c.Green,b=c.Blue,a=c.Alpha} end)
                        pcall(function() item.fontSize=widget:GetFontSize(); item.fontStyle=NameToString(widget:GetFontStyle()) end)
                        pcall(function() item.desiredWidth=widget:GetDesiredWidth(); item.desiredHeight=widget:GetDesiredHeight() end)
                        pcall(function() local s=widget:GetScale(); item.scale={x=s.X,y=s.Y} end)
                        pcall(function() local s=widget:GetTranslation(); item.translation={x=s.X,y=s.Y} end)
                        local margin = widget:GetMargin()
                        item.margin = {left=margin.left, top=margin.top, right=margin.right, bottom=margin.bottom}
                        item.anchor, item.halign, item.valign = tostring(widget:GetAnchor()), tostring(widget:GetHAlign()), tostring(widget:GetVAlign())
                        local logic = widget:GetController()
                        if logic then
                            item.controller = NameToString(logic:GetClassName())
                            if item.controller == 'JournalEntriesListController' then
                                pcall(function() item.listSize = logic:Size() end)
                            end
                            if item.controller == 'CyberpunkConvai.ConvaiPhoneChatInput' then
                                pcall(function() item.placeholder = logic:GetDefaultText() end)
                            end
                            if item.controller == 'MessengerDialogViewController' then
                                pcall(function() item.hasChoices = logic:HasReplyOptions() end)
                            end
                            if request:find(':messages:') then
                                pcall(function()
                                    local data = logic:GetData()
                                    if data then item.dataClass = NameToString(data:GetClassName()) end
                                end)
                            end
                        end
                        local parent = widget:GetParentWidget()
                        if parent then item.parent = NameToString(parent:GetName()) end
                        report.widgets[#report.widgets + 1] = item
                        local compound, count = pcall(function() return widget:GetNumChildren() end)
                        if compound then for index = 0, count - 1 do visit(widget:GetWidgetByIndex(index), depth + 1, item.path) end end
                    end
                    visit(controller:GetRootWidget(), 0, class)
                end
            end
        end
    end)
    if not ok then report.probeError = tostring(err) end
    local file = io.open('runtime/phone-chat-debug.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^party%-weapon%-state:') then
    -- Read attachment state as well as combat state: Relaxed alone does not
    -- establish that a weapon has left either hand. Never mutate equipment here.
    local function read(fn)
        local ok, value = pcall(fn)
        if not ok or value == nil then return 'unavailable' end
        if type(value) == 'boolean' or type(value) == 'number' or type(value) == 'string' then return value end
        return tostring(value)
    end
    local function weapon(getter)
        local ok, item = pcall(getter)
        if not ok then return {present = 'unavailable'} end
        if not item then return {present = false} end
        return {present = true,
            class = read(function() return NameToString(item:GetClassName()) end),
            entity = read(function() return tostring(item:GetEntityID().hash) end),
            record = read(function() return TDBID.ToStringDEBUG(ItemID.GetTDBID(item:GetItemID())) end),
            itemHash = read(function() return tostring(ItemID.GetCombinedHash(item:GetItemID())) end),
            isWeapon = read(function() return item:IsA('WeaponObject') end),
            isFists = read(function() return WeaponObject.IsFists(item:GetItemID()) end)}
    end
    local function hands(owner)
        return {
            right = weapon(function() return Game.GetTransactionSystem():GetItemInSlot(owner, TweakDBID.new('AttachmentSlots.WeaponRight')) end),
            left = weapon(function() return Game.GetTransactionSystem():GetItemInSlot(owner, TweakDBID.new('AttachmentSlots.WeaponLeft')) end),
            active = weapon(function() return ScriptedPuppet.GetActiveWeapon(owner) end)}
    end
    local player = Game.GetPlayer()
    local report = {at = os.time() * 1000, scope = 'Configured managed companions within 100 metres', companions = {},
        player = {combat = read(function() return player:IsInCombat() end),
            dead = read(function() return player:IsDeadNoStatPool() end),
            threats = {
                remembered = read(function() return TargetTrackingExtension.HasHostileThreat(player) end),
                visible = read(function() return TargetTrackingExtension.HasHostileThreat(player, true) end),
                entities = read(function() return TargetTrackingExtension.HasHostileThreat(player, false, true) end),
                visibleEntities = read(function() return TargetTrackingExtension.HasHostileThreat(player, true, true) end)},
            tier = read(function() return PlayerPuppet.GetSceneTier(player) end), hands = hands(player)}}
    local cached, cachedOK = {}, false
    local listOK, rows = pcall(convaiCompanions.list)
    if listOK then
        cachedOK = true
        for _, row in ipairs(rows) do cached[row.entityID] = row end
    end
    local ok, candidates = pcall(convaiCompanions.conversationCandidates, player, 100)
    report.candidatesAvailable, report.movementAvailable = ok, cachedOK
    if ok then
        for _, person in ipairs(candidates) do
            local npc, snapshot = person.npc, cached[person.entity] or {}
            report.companions[#report.companions + 1] = {
                name = person.name, entity = person.entity, distance = person.distance,
                record = read(function() return TDBID.ToStringDEBUG(npc:GetRecordID()) end),
                combat = read(function() return NPCPuppet.IsInCombat(npc) end),
                highLevel = read(function() return tostring(npc:GetHighLevelStateFromBlackboard()) end),
                upperBody = read(function()
                    return tostring(Enum.new('gamedataNPCUpperBodyState', npc:GetPuppetStateBlackboard():GetInt(GetAllBlackboardDefs().PuppetState.UpperBody)))
                end),
                autonomous = read(function() return npc:IsOnAutonomousAI() end),
                hostileThreat = read(function() return TargetTrackingExtension.HasHostileThreat(npc) end),
                threatEntities = read(function() return TargetTrackingExtension.HasHostileThreat(npc, false, true) end),
                visibleThreatEntities = read(function() return TargetTrackingExtension.HasHostileThreat(npc, true, true) end),
                scene = read(function() return Game.GetSceneSystem():GetScriptInterface():IsEntityInScene(npc:GetEntityID()) end),
                dialogue = read(function() return Game.GetSceneSystem():GetScriptInterface():IsEntityInDialogue(npc:GetEntityID()) end),
                follower = read(function() return npc:IsPlayerCompanion() end),
                role = read(function() return NameToString(npc:GetAIControllerComponent():GetAIRole():GetClassName()) end),
                hands = hands(npc), behavior = snapshot.behavior, behaviorReason = snapshot.behaviorReason,
                operation = snapshot.operation, npcSpeed = snapshot.npcSpeed, groupIntent = snapshot.groupIntent,
                equipment = snapshot.equipment}
        end
    end
    local file = io.open('runtime/party-weapon-state.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^party%-combat%-state:') then
    local report = {records = {}, companions = {}}
    for _, record in ipairs({'Character.Silverhand', 'Character.Judy', 'Character.Grayson',
        'CyberpunkConvai.JohnnyCompanion'}) do
        local row = {record = record, fields = {}}
        local ok, err = pcall(function()
            row.exists = TweakDB:GetRecord(record) ~= nil
            if not row.exists then return end
            for _, field in ipairs({'abilities', 'archetypeData', 'primaryEquipment',
                'secondaryEquipment', 'reactionPreset', 'entityTemplatePath'}) do
                local value = TweakDB:GetFlat(record .. '.' .. field)
                if field == 'abilities' then
                    row.fields[field] = {}
                    for _, ability in ipairs(value or {}) do
                        row.fields[field][#row.fields[field] + 1] = tostring(ability)
                    end
                else row.fields[field] = tostring(value) end
                if field == 'primaryEquipment' and value then
                    local equipment = TweakDB:GetRecord(value)
                    row.weapons = {}
                    if equipment then
                        for _, item in ipairs(equipment:EquipmentItems()) do
                            row.weapons[#row.weapons + 1] = tostring(item:Item():GetID())
                        end
                    end
                end
            end
        end)
        if not ok then row.error = tostring(err) end
        report.records[#report.records + 1] = row
    end
    for _, item in ipairs(convaiCompanions.conversationCandidates(Game.GetPlayer(), 100)) do
        local row = {name = item.name, entity = item.entity}
        local ok, err = pcall(function()
            row.record = tostring(item.npc:GetRecordID())
            row.combat = NPCPuppet.IsInCombat(item.npc)
            row.state = tostring(item.npc:GetHighLevelStateFromBlackboard())
            row.role = NameToString(item.npc:GetAIControllerComponent():GetAIRole():GetClassName())
            row.follower = item.npc:IsPlayerCompanion()
            row.stats = {}
            for _, stat in ipairs({'CanUseRightHand', 'CanUseLeftHand', 'CanShootWhileMoving',
                'CanPreciseShoot', 'CanSwitchWeapon'}) do
                local readOK, value = pcall(function()
                    return Game.GetStatsSystem():GetStatValue(item.npc:GetEntityID(), stat)
                end)
                row.stats[stat] = readOK and value or tostring(value)
            end
        end)
        if not ok then row.error = tostring(err) end
        report.companions[#report.companions + 1] = row
    end
    local file = io.open('runtime/party-combat-state.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^party%-face%-probe:') or request:match('^party%-face%-articulation:') then
    local mode = request:match('^party%-face%-articulation:') and 'articulation' or 'jaw'
    local key = request:match('^party%-face%-probe:([^:]+):')
        or request:match('^party%-face%-articulation:([^:]+):')
    local stage = 'load'
    local ok, err = xpcall(function()
        local probe = dofile('face-probe.lua')
        stage = 'start'
        if key == 'cancel' then probe.stop('cancelled') else probe.start(key, mode) end
    end, function(value)
        return debug and debug.traceback and debug.traceback(tostring(value), 2) or tostring(value)
    end)
    if not ok then
        local file = io.open('runtime/face-probe.json', 'wb')
        if file then file:write(json.encode({state = 'start-error', stage = stage, error = err})); file:close() end
        error(err)
    end
    return
end
if request:match('^party%-face%-state:') then
    local rows = {}
    for _, item in ipairs(convaiCompanions.conversationCandidates(Game.GetPlayer(), 100)) do
        local row = {name = item.name, entity = item.entity}
        local ok, err = pcall(function()
            row.ready = item.npc:ConvaiFaceReady()
            row.status = item.npc:ConvaiFaceStatus()
        end)
        if not ok then row.error = tostring(err) end
        rows[#rows + 1] = row
    end
    local file = io.open('runtime/party-face-state.json', 'wb')
    if file then file:write(json.encode(rows)); file:close() end
    return
end
if request:match('^party%-face%-reflect:') then
    -- Read-only discovery, restricted to this mod's attached companion copies.
    -- Do not retain components after the probe or change animation inputs.
    local report = {classes = {}, companions = {}}
    local function describe(className)
        if report.classes[className] then return end
        local row = {properties = {}, functions = {}, staticFunctions = {}}
        report.classes[className] = row
        local ok, err = pcall(function()
            local cls = Reflection.GetClass(CName.new(className))
            if not cls then row.missing = true; return end
            for _, prop in ipairs(cls:GetProperties()) do
                row.properties[#row.properties + 1] = {
                    name = NameToString(prop:GetName()), type = NameToString(prop:GetType():GetName())}
            end
            for _, method in ipairs(cls:GetFunctions()) do
                row.functions[#row.functions + 1] = NameToString(method:GetFullName())
            end
            for _, method in ipairs(cls:GetStaticFunctions()) do
                row.staticFunctions[#row.staticFunctions + 1] = NameToString(method:GetFullName())
            end
        end)
        if not ok then row.error = tostring(err) end
    end
    local ok, err = pcall(function()
        for _, item in ipairs(convaiCompanions.conversationCandidates(Game.GetPlayer(), 30)) do
            local npc = item.npc
            if convaiCompanions.owns(npc) and npc:IsAttached() then
                local row = {name = item.name, entity = item.entity, components = {}}
                for _, component in ipairs(npc:GetComponents()) do
                    local name, className = NameToString(component:GetName()), NameToString(component:GetClassName())
                    local detail = {name = name, class = className}
                    if component:IsA('entAnimatedComponent') or component:IsA('entAnimationControllerComponent')
                        or className:lower():find('facial', 1, true) then
                        describe(className)
                        detail.fields = {}
                        for _, field in ipairs({'rig', 'graph', 'facialSetup', 'controlBinding', 'animParameters'}) do
                            local readOK, value = pcall(function() return component[field] end)
                            detail.fields[field] = readOK and tostring(value) or ('error: ' .. tostring(value))
                        end
                        if name == 'face_rig' then
                            local readOK, readError = pcall(function()
                                local cls = Reflection.GetClass(CName.new(className))
                                local owner = ToVariant(component)
                                local rigRef = ResourceRef.FromVariant(cls:GetProperty(CName.new('rig')):GetValue(owner))
                                local graphRef = ResourceRef.FromVariant(cls:GetProperty(CName.new('graph')):GetValue(owner))
                                detail.rigPath = ResRef.ToString(ResourceRef.GetPath(rigRef))
                                detail.graphPath = ResRef.ToString(ResourceRef.GetPath(graphRef))
                                local rig = ResourceRef.GetResource(rigRef)
                                detail.tracks = {}
                                for i, track in ipairs(rig.trackNames) do
                                    detail.tracks[#detail.tracks + 1] = {name = NameToString(track), reference = rig.referenceTracks[i]}
                                end
                                local graph = ResourceRef.GetResource(graphRef)
                                detail.variables = {}
                                for _, kind in ipairs({'boolVariables', 'intVariables', 'floatVariables'}) do
                                    for _, variable in ipairs(graph.variables[kind]) do
                                        detail.variables[#detail.variables + 1] = {name = NameToString(variable.name),
                                            kind = kind, value = variable.value, default = variable.default}
                                    end
                                end
                                detail.nodes = {}
                                for _, node in ipairs(graph.nodesToInit) do
                                    local nodeClass = NameToString(node:GetClassName())
                                    local entry = {class = nodeClass}
                                    for _, field in ipairs({'name', 'group'}) do
                                        local value = node[field]
                                        if value then entry[field] = NameToString(value) end
                                    end
                                    detail.nodes[#detail.nodes + 1] = entry
                                end
                                detail.parameters = {}
                                for _, parameter in ipairs(component.animParameters) do
                                    detail.parameters[#detail.parameters + 1] = {track = NameToString(parameter.animTrackName),
                                        parameter = NameToString(parameter.parameterName), default = parameter.defaultValue}
                                end
                            end)
                            if not readOK then detail.resourceError = tostring(readError) end
                        end
                    end
                    row.components[#row.components + 1] = detail
                end
                report.companions[#report.companions + 1] = row
            end
        end
        for _, className in ipairs({'animAnimGraph', 'animRig', 'animFacialSetup', 'entAnimTrackParameter',
            'entAnimationControlBinding', 'AnimInputSetterFloat', 'AnimationControllerComponent'}) do
            describe(className)
        end
    end)
    if not ok then report.error = tostring(err) end
    local file = io.open('runtime/party-face-reflect.json', 'wb')
    if file then file:write(json.encode(report)); file:close() end
    return
end
if request:match('^conversation%-state:') then
    local r = convaiGroupChat and convaiGroupChat.round
    local f = io.open('runtime/conversation-state.json', 'wb')
    if f then
        f:write(json.encode({group = r and {id = r.id, stage = r.stage, index = r.index,
            total = #r.participants, requestId = r.requestId} or false,
            speech = convaiSpeech and {state = convaiSpeech.state, requestId = convaiSpeech.requestId,
                position = convaiSpeech.position, error = convaiSpeech.error} or false}))
        f:close()
    end
    return
end
if request:match('^speech%-install:') or request:match('^speech%-replay:') then
    local ok, err = pcall(function()
        local speech = dofile('speech.lua')
        if request:match('^speech%-replay:') then
            local input = io.open('runtime/last-input.json', 'rb')
            local reply = io.open('runtime/reply.json', 'rb')
            local context = json.decode(input:read('*a')); input:close()
            local response = json.decode(reply:read('*a')); reply:close()
            assert(context.requestId == response.requestId, 'Reply is stale')
            return speech.start(context, response)
        end
        return 'installed'
    end)
    local f = io.open('runtime/speech-probe.txt', 'wb')
    if f then f:write(tostring(ok), ' ', tostring(err)); f:close() end
    return
end
if request:match('^composer%-input:') then
    local fix = dofile('composer-input.lua')
    fix.install()
    for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
        for _, controller in ipairs(layer:GetGameControllers()) do
            if controller:IsA('GenericMessageNotification') then
                local ok, err = pcall(fix.apply, controller)
                if not ok then fix.lastError = tostring(err) end
            end
        end
    end
    local f = io.open('runtime/composer-input.json', 'wb')
    if f then f:write(json.encode({installed = fix.installed, patched = fix.patched, seen = fix.seen,
        title = fix.lastTitle, case = fix.lastCase, placeholder = fix.lastPlaceholder,
        error = fix.lastError})); f:close() end
    return
end
if request:match('^subtitles%-enable:') then
    local ok, err = pcall(function()
        local setting = UserSettings.new():GetVar('/accessibility/subtitles', 'Cinematic')
        setting:SetValue(true)
        assert(setting:GetValue(), 'Dialogue subtitle setting did not enable')
        if convaiSubtitleController then
            convaiSubtitleController:GetSystemRequestsHandler():RequestSaveUserSettings()
        end
        local file = io.open('runtime/subtitles-enabled.txt', 'wb')
        if file then file:write('cinematic=true'); file:close() end
    end)
    if not ok then error(err) end
    return
end
if request:match('^subtitles%-probe:') then
    local out = {}
    local ok, err = pcall(function()
        local settings = UserSettings.new()
        out[#out + 1] = 'cinematic=' .. tostring(settings:GetVar('/accessibility/subtitles', 'Cinematic'):GetValue())
        for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
            for _, controller in ipairs(layer:GetGameControllers()) do
                if controller:IsA('SubtitlesGameController') then
                    local root = controller:GetRootWidget()
                    convaiSubtitleController = controller
                    out[#out + 1] = 'found=' .. tostring(layer:GetLayerName()) .. ' visible=' .. tostring(root:IsVisible())
                    out[#out + 1] = 'sameBoard=' .. tostring(controller:GetUIBlackboard() == Game.GetBlackboardSystem():Get(Game.GetAllBlackboardDefs().UIGameData))
                end
            end
        end
        if not convaiSubtitleProbeInstalled then
            Observe('BaseSubtitlesGameController', 'OnShowDialogLine', function(_, value)
                local f = io.open('runtime/subtitles-events.txt', 'ab')
                if f then f:write('show received\n'); f:close() end
            end)
            Observe('SubtitleLineLogicController', 'SetLineData', function(_, line)
                local f = io.open('runtime/subtitles-events.txt', 'ab')
                if f then f:write('line rendered: ', tostring(line.text), '\n'); f:close() end
            end)
            convaiSubtitleProbeInstalled = true
        end
        dofile('subtitles.lua').show('Alex', 'Checking the native dialogue subtitles.')
    end)
    out[#out + 1] = 'ok=' .. tostring(ok) .. ' error=' .. tostring(err)
    local f = io.open('runtime/subtitles-probe.txt', 'wb')
    if f then f:write(table.concat(out, '\n')); f:close() end
    return
end
if request:match('^subtitles%-state:') then
    local s = convaiSubtitles
    local f = io.open('runtime/subtitles-state.json', 'wb')
    if f then
        f:write(json.encode({installed = s ~= nil, serial = s and s.serial, adapter = s and s.status and s.status(),
            active = s and s.line ~= nil, page = s and s.page,
            remaining = s and s.remaining, error = s and s.lastError}))
        f:close()
    end
    return
end
if request:match('^subtitles%-install:') then
    local ok, result = pcall(function()
        local subtitles = dofile('subtitles.lua')
        subtitles.installLive()
        return 'Native subtitle adapter installed; thinking notification suppressed.'
    end)
    local f = io.open('runtime/subtitles-check.txt', 'wb')
    if f then f:write(ok and result or tostring(result)); f:close() end
    return
end
if request:match('^phone%-spacing:') then
    local layout = dofile('phone-layout.lua')
    local ok, err = pcall(function() layout.install(true); layout.refresh(true) end)
    local file = io.open('runtime/phone-spacing.json', 'wb')
    if file then
        file:write(json.encode({ok = ok, error = not ok and tostring(err) or layout.lastError,
            patched = layout.patched, seen = layout.seen, selected = layout.selected, scan = layout.scan,
            phoneOpen = Game.GetPlayer():ConvaiPhoneIsOpen(),
            keyIconGap = 16, cellWidth = 132}))
        file:close()
    end
    return
end
if request:match('^phone%-input:') then
    local ok, result = pcall(function()
        local input = dofile('phone-input.lua')
        input.install()
        return 'installed=' .. tostring(input.installed) .. '\nblocked=' .. tostring(input.blocked)
    end)
    local f = io.open('runtime/phone-input.txt', 'wb')
    if f then f:write(ok and result or tostring(result)); f:close() end
    return
end
if request:match('^phone%-all%-contacts:') then
    local ok, result = pcall(function()
        assert(Game.GetPlayer(), 'Load a save before reading the journal')
        local journal = Game.GetJournalManager()
        local context = JournalRequestContext.new({stateFilter = JournalRequestStateFilter.new({
            inactive = true, active = true, succeeded = true, failed = true,
        })})
        local first, second = journal:GetContacts(context)
        local entries = type(second) == 'table' and second or first
        assert(type(entries) == 'table', 'Journal contact array was not returned')
        local contacts = {}
        for _, entry in ipairs(entries) do
            contacts[#contacts + 1] = {id = entry:GetId(), name = GetLocalizedText(entry:GetLocalizedName(journal)), known = entry:IsKnown(journal)}
        end
        return json.encode(contacts)
    end)
    local f = io.open('runtime/phone-all-contacts.json', 'wb')
    if f then f:write(ok and result or json.encode({error = tostring(result)})); f:close() end
    return
end
if request:match('^lua%-check:') then
    local results = {}
    for _, name in ipairs({'init', 'companions', 'phone-input'}) do
        local compiled, err = loadfile('runtime/check-' .. name .. '.lua')
        results[#results + 1] = name .. '=' .. (compiled and 'syntax OK' or tostring(err))
    end
    local f = io.open('runtime/lua-check.txt', 'wb')
    if f then f:write(table.concat(results, '\n')); f:close() end
    return
end
if request:match('^phone%-catalog:') then
    local ok, result = pcall(function()
        local dump = {contacts = {}, characters = {}}
        for _, c in ipairs(Game.GetJournalManager():GetContactDataArray(false, false) or {}) do
            dump.contacts[#dump.contacts + 1] = {id = tostring(c.id), name = GetLocalizedText(c.localizedName)}
        end
        for _, record in ipairs(TweakDB:GetRecords('gamedataCharacter_Record') or {}) do
            local debugId = tostring(record:GetID())
            local id = debugId:match('%-%-%[%[ (.-) %-%-%]%]')
            if id then
                local displayOk, display = pcall(function()
                    local raw = tostring(TweakDB:GetFlat(id .. '.displayName'))
                    local number = raw:match('LocKey%((%d+)')
                    return GetLocalizedText(number and ('LocKey#' .. number) or raw)
                end)
                dump.characters[#dump.characters + 1] = {id = id, name = displayOk and display or ''}
            end
        end
        return json.encode(dump)
    end)
    local f = io.open('runtime/phone-catalog.json', 'wb')
    if f then f:write(ok and result or json.encode({error = tostring(result)})); f:close() end
    return
end
if request:match('^phone%-preview%-disable:') then
    -- Existing preview observers look up these functions at call time.
    -- Disarm them before the phone rebuilds its virtualized contact rows.
    if convaiPhonePreview then
        convaiPhonePreview.layout = function() end
        convaiPhonePreview.keys = function() end
        convaiPhonePreview.input = function() end
        convaiPhonePreview.disabled = true
    end
    local f = io.open('runtime/phone-preview-disabled.txt', 'wb')
    if f then f:write('disabled=true\n'); f:close() end
    return
end
if request:match('^phone%-tree:') then
    local ok, result = pcall(function()
        if convaiPhoneTreeObserverInstalled then return 'already installed' end
        ObserveAfter('PhoneContactItemVirtualController', 'OnSelected', function(controller)
            local worked, detail = pcall(function()
                local contact = controller:GetContactData()
                if not contact or tostring(contact.id) ~= 'judy' then return nil end
                local lines = {}
                local function describe(widget, depth)
                    if not widget then return end
                    local sizeOk, size = pcall(function() return widget:GetSize() end)
                    local marginOk, margin = pcall(function() return widget:GetMargin() end)
                    local nameOk, name = pcall(function() return widget:GetName() end)
                    local visOk, visible = pcall(function() return widget:IsVisible() end)
                    local opacityOk, opacity = pcall(function() return widget:GetOpacity() end)
                    local countOk, count = pcall(function() return widget:GetNumChildren() end)
                    lines[#lines + 1] = string.rep(' ', depth * 2) .. 'name=' .. tostring(nameOk and name)
                        .. ' size=' .. tostring(sizeOk and size and size.X) .. ',' .. tostring(sizeOk and size and size.Y)
                        .. ' margin=' .. tostring(marginOk and margin and margin.left) .. ',' .. tostring(marginOk and margin and margin.top)
                        .. ',' .. tostring(marginOk and margin and margin.right)
                        .. ' visible=' .. tostring(visOk and visible) .. ' opacity=' .. tostring(opacityOk and opacity)
                        .. ' children=' .. tostring(countOk and count)
                    if depth < 4 and countOk and count then
                        for i = 0, math.min(count - 1, 12) do
                            local childOk, child = pcall(function() return widget:GetWidgetByIndex(i) end)
                            if childOk then describe(child, depth + 1) end
                        end
                    end
                end
                describe(controller:GetRootWidget(), 0)
                return table.concat(lines, '\n')
            end)
            if detail then
                local log = io.open('runtime/phone-tree.txt', 'wb')
                if log then log:write('ok=', tostring(worked), '\n', tostring(detail), '\n'); log:close() end
            end
        end)
        convaiPhoneTreeObserverInstalled = true
        return 'observer installed'
    end)
    local file = io.open('runtime/phone-tree-install.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^phone%-selection%-preflight:') then
    local ok, result = pcall(function()
        if convaiPhoneSelectionObserverInstalled then return 'already installed' end
        local function report(controller, action)
            local worked, detail = pcall(function()
                local contact = controller:GetContactData()
                if not contact or tostring(contact.id) ~= 'judy' then return nil end
                local root = controller:GetRootWidget()
                local lines = {'action=' .. action, 'root=' .. tostring(root)}
                for _, pair in ipairs({
                    {'size', function() return root:GetSize() end},
                    {'visible', function() return root:IsVisible() end},
                    {'num-children', function() return root:GetNumChildren() end},
                    {'join', function() return root:GetWidgetByPathName('convaiJoin') end},
                    {'leave', function() return root:GetWidgetByPathName('convaiLeave') end},
                }) do
                    local success, value = pcall(pair[2])
                    lines[#lines + 1] = pair[1] .. '=' .. tostring(success) .. ':' .. tostring(value)
                end
                return table.concat(lines, '\n')
            end)
            if detail then
                local log = io.open('runtime/phone-selection-preflight.txt', 'ab')
                if log then log:write('ok=', tostring(worked), '\n', tostring(detail), '\n'); log:close() end
            end
        end
        ObserveAfter('PhoneContactItemVirtualController', 'OnSelected', function(controller) report(controller, 'selected') end)
        ObserveAfter('PhoneContactItemVirtualController', 'OnDeselected', function(controller) report(controller, 'deselected') end)
        convaiPhoneSelectionObserverInstalled = true
        return 'observer installed'
    end)
    local file = io.open('runtime/phone-selection-install.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^phone%-widget%-preflight:') then
    local ok, result = pcall(function()
        if convaiPhoneWidgetObserverInstalled then return 'already installed' end
        ObserveAfter('PhoneContactItemVirtualController', 'OnDataChanged', function(controller)
            local worked, value = pcall(function()
                local contact = controller:GetContactData()
                if not contact or tostring(contact.id) ~= 'judy' then return nil end
                local root = controller:GetRootWidget()
                local lines = {'root=' .. tostring(root)}
                for _, pair in ipairs({
                    {'root-size', function() return root:GetSize() end},
                    {'root-visible', function() return root:IsVisible() end},
                    {'root-compound', function() return root:IsA('inkCompoundWidget') end},
                    {'root-children', function() return root:GetNumChildren() end},
                    {'join-child', function() return root:GetWidgetByPathName('convaiJoin') end},
                    {'leave-child', function() return root:GetWidgetByPathName('convaiLeave') end},
                }) do
                    local success, detail = pcall(pair[2])
                    lines[#lines + 1] = pair[1] .. '=' .. tostring(success) .. ':' .. tostring(detail)
                end
                return table.concat(lines, '\n')
            end)
            if value then
                local log = io.open('runtime/phone-widget-preflight.txt', 'ab')
                if log then log:write('ok=', tostring(worked), '\n', tostring(value), '\n'); log:close() end
            end
        end)
        convaiPhoneWidgetObserverInstalled = true
        return 'observer installed'
    end)
    local file = io.open('runtime/phone-widget-install.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^phone%-preflight:') then
    local ok, result = pcall(function()
        if convaiPhoneObserverInstalled then return 'already installed' end
        ObserveAfter('PhoneContactItemVirtualController', 'OnDataChanged', function(controller)
            local succeeded, line = pcall(function()
                local contact = controller:GetContactData()
                if not contact then return 'no contact data' end
                return 'id=' .. tostring(contact.id)
                    .. ' contactId=' .. tostring(contact.contactId)
                    .. ' name=' .. tostring(contact.localizedName)
                    .. ' callable=' .. tostring(contact.isCallable)
            end)
            local log = io.open('runtime/phone-contacts.txt', 'ab')
            if log then log:write(tostring(succeeded), ' ', tostring(line), '\n'); log:close() end
        end)
        convaiPhoneObserverInstalled = true
        return 'observer installed'
    end)
    local file = io.open('runtime/phone-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-mappin%-preflight:') then
    local ok, result = pcall(function()
        local names = {
            'Mappins.DefaultStaticMappin',
            'Mappins.DefaultDynamicMappin',
            'Mappins.QuestDynamicMappinDefinition',
            'Mappins.QuestStaticMappinDefinition',
        }
        local lines = {}
        for _, name in ipairs(names) do
            lines[#lines + 1] = name .. '=' .. tostring(TweakDB:GetRecord(name) ~= nil)
        end
        for _, name in ipairs({'NPCVariant', 'ChangeToFriendlyVariant', 'DefaultVariant'}) do
            local valid, value = pcall(function() return Enum.new('gamedataMappinVariant', name) end)
            lines[#lines + 1] = name .. '=' .. tostring(valid and value or valid)
        end
        return table.concat(lines, '\n')
    end)
    local file = io.open('runtime/party-mappin-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^lookat%-preflight:') then
    local attempts = {}
    local constructors = {
        {'NewObject(LookAtAddEvent)', function() return NewObject('LookAtAddEvent') end},
        {'LookAtAddEvent.new', function() return LookAtAddEvent.new() end},
        {'LookAtAddEvent()', function() return LookAtAddEvent() end},
        {'NewObject(gameLookAtAddEvent)', function() return NewObject('gameLookAtAddEvent') end},
        {'configured glance', function()
            local event = LookAtAddEvent.new()
            event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
            event.request.transitionSpeed = 66.6
            event.bodyPart = CName.new('Head')
            return event
        end},
        {'ambient entity look', function()
            local event = LookAtAddEvent.new()
            event:SetEntityTarget(Game.GetPlayer(), CName.new('pla_default_tgt'), Vector4.new(0, 0, 0, 0))
            event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
            event.bodyPart = CName.new('Eyes')
            local head = LookAtPartRequest.new()
            head.partName = CName.new('Head')
            head.weight = 0.05
            head.suppress = 1.0
            head.mode = 0
            event:SetAdditionalPartsArray({head})
            return event
        end},
    }
    for _, candidate in ipairs(constructors) do
        local ok, value = pcall(candidate[2])
        attempts[#attempts + 1] = candidate[1] .. ' ok=' .. tostring(ok)
            .. ' value=' .. tostring(value)
    end
    local file = io.open('runtime/lookat-preflight.txt', 'wb')
    if file then file:write(table.concat(attempts, '\n')); file:close() end
    return
end
if request:match('^party%-hotpatch:') then
    local ok, result = pcall(function()
        if not convaiCompanions then return 'Companion runtime missing' end
        if #convaiCompanions.list() > 0 then return 'Dismiss the active party first' end
        local replacement = dofile('companions.lua')
        for name, value in pairs(replacement) do convaiCompanions[name] = value end
        return 'Companion runtime refreshed in place'
    end)
    local file = io.open('runtime/party-hotpatch.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-spawn:') then
    local key = request:match('^party%-spawn:([^:]+)')
    local ok, result = pcall(function()
        if not convaiCompanions then return 'Companion manager not loaded' end
        local serial, err = convaiCompanions.spawn(key)
        return serial and ('spawn_requested=' .. tostring(serial) .. ' key=' .. tostring(key)) or ('error=' .. tostring(err))
    end)
    local file = io.open('runtime/party-spawn.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-dismiss:') then
    local serial = tonumber(request:match('^party%-dismiss:(%d+)'))
    local ok, result = pcall(function()
        return convaiCompanions and convaiCompanions.dismiss(serial)
    end)
    local file = io.open('runtime/party-dismiss.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-list:') then
    local ok, result = pcall(function()
        return json.encode(convaiCompanions and convaiCompanions.list() or {})
    end)
    local file = io.open('runtime/party-list.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^party%-motion%-watch:') then
    convaiMotionWatch = {elapsed = 0, sampleAt = 0, samples = {}, previous = {}}
    if not convaiMotionOriginalUpdate then
        convaiMotionOriginalUpdate = convaiCompanions.update
        convaiCompanions.update = function(player, dt, focus)
            convaiMotionOriginalUpdate(player, dt, focus)
            local watch = convaiMotionWatch
            if not watch then return end
            watch.elapsed = watch.elapsed + dt
            if watch.elapsed < watch.sampleAt then return end
            watch.sampleAt = watch.elapsed + 0.45
            local states, rows = {}, {}
            local camera
            pcall(function()
                local _, view = Game.GetTargetingSystem():GetCrosshairData(player)
                if view then camera = {x=view.x, y=view.y, z=view.z} end
            end)
            for _, member in ipairs(convaiCompanions.list()) do states[member.entityID] = member end
            for _, item in ipairs(convaiCompanions.conversationCandidates(player, 35)) do
                local npc, state = item.npc, states[item.entity]
                if state then
                    local position, forward = npc:GetWorldPosition(), npc:GetWorldForward()
                    local old = watch.previous[item.entity]
                    state.time = watch.elapsed
                    state.focusEntity, state.cameraForward = focus, camera
                    state.position = {x = position.x, y = position.y, z = position.z}
                    state.forward = {x = forward.x, y = forward.y}
                    if old then
                        local x, y = position.x-old.position.x, position.y-old.position.y
                        local length, facingLength = math.sqrt(x*x+y*y), math.sqrt(forward.x^2+forward.y^2)
                        state.measuredSpeed = length/(state.time-old.time)
                        if length > 0.04 and facingLength > 0.1 then
                            state.movementFacingAngle = math.deg(math.acos(math.max(-1, math.min(1,
                                (x*forward.x+y*forward.y)/(length*facingLength)))))
                        end
                    end
                    state.behaviorTrace = nil
                    state.lastCommand = state.commandTrace and state.commandTrace[#state.commandTrace] or nil
                    state.commandTrace = nil
                    watch.previous[item.entity] = state
                    rows[#rows + 1] = state
                end
            end
            watch.samples[#watch.samples + 1] = rows
            local file = io.open('runtime/party-motion-watch.json', 'wb')
            if file then file:write(json.encode({elapsed = watch.elapsed, done = watch.elapsed >= 90, samples = watch.samples})); file:close() end
            if watch.elapsed >= 90 then convaiMotionWatch = nil end
        end
    end
    return
end
if request:match('^party%-pause:') then
    if not convaiPausedPartyUpdate then
        convaiPausedPartyUpdate = convaiCompanions.update
        convaiCompanions.update = function() end
    end
    local rows = {}
    for _, item in ipairs(convaiCompanions.conversationCandidates(Game.GetPlayer(), 100)) do
        local row = {entity = item.entity, name = item.name}
        local ok, err = pcall(function()
            local ai = item.npc:GetAIControllerComponent()
            row.cancelled = ai:CancelOrInterruptCommand(CName.new('AIMoveCommand'), true, false)
            local hold = NewObject('AIHoldPositionCommand')
            hold.duration = 300.0
            row.held = ai:SendCommand(hold)
        end)
        if not ok then row.error = tostring(err) end
        rows[#rows + 1] = row
    end
    local file = io.open('runtime/party-paused.json', 'wb')
    if file then file:write(json.encode(rows)); file:close() end
    return
end
if request:match('^party%-resume:') then
    for _, item in ipairs(convaiCompanions.conversationCandidates(Game.GetPlayer(), 100)) do
        item.npc:GetAIControllerComponent():CancelOrInterruptCommand(CName.new('AIHoldPositionCommand'), false, true)
    end
    if convaiPausedPartyUpdate then
        convaiCompanions.update = convaiPausedPartyUpdate
        convaiPausedPartyUpdate = nil
    end
    return
end
if request:match('^party%-mapping%-reflect:') then
    local result = {}
    local ok, err = pcall(function()
        for _, className in ipairs({'AIMoveToCommandHandler', 'AIMoveRotateToCommandHandler'}) do
            local fields = {}
            for _, prop in ipairs(Reflection.GetClass(CName.new(className)):GetProperties()) do
                fields[#fields + 1] = NameToString(prop:GetName())
            end
            result[className] = fields
        end
    end)
    if not ok then result.error = tostring(err) end
    local file = io.open('runtime/party-mapping-reflect.json', 'wb')
    if file then file:write(json.encode(result)); file:close() end
    return
end
if request:match('^party%-facing%-state:') then
    local motion = convaiLocomotion or convaiFacingFix or {}
    local file = io.open('runtime/party-facing-fix.json', 'wb')
    if file then file:write(json.encode({installed = motion.installed,
        checked = motion.checked, cleared = motion.cleared, error = motion.error})); file:close() end
    return
end
if request:match('^party%-facing%-watch:') then
    convaiFacingSamples = {}
    convaiFacingProbe = function(handler, context, command)
        if #convaiFacingSamples >= 16 then return end
        local row = {}
        local ok, err = pcall(function()
            local owner = ScriptExecutionContext.GetOwner(context)
            if not convaiCompanions.owns(owner) then return end
            row.entity = tostring(owner:GetEntityID().hash)
            row.rotate = command.rotateEntityTowardsFacingTarget
            row.requestedFacing = tostring(AIPositionSpec.GetEntity(command.facingTarget))
            row.mappings = {}
            for _, name in ipairs({'outFacingTarget', 'outRotateEntityTowardsFacingTarget', 'outMovementTarget', 'outMovementTargetPos'}) do
                local mapping = handler[name]
                local field = {name = name, mapping = tostring(mapping)}
                if mapping then
                    field.argument = NameToString(mapping:GetArgumentName())
                    field.type = tostring(mapping:GetArgumentType())
                    field.parameterization = tostring(mapping:GetParameterizationType())
                    field.value = tostring(FromVariant(ScriptExecutionContext.GetMappingValue(context, mapping)))
                    if name == 'outFacingTarget' then
                        local target = ScriptExecutionContext.GetArgumentObject(context, mapping:GetArgumentName())
                        field.entity = target and tostring(target:GetEntityID().hash) or 'nil'
                    end
                end
                row.mappings[#row.mappings + 1] = field
            end
            row.locomotion = tostring(owner:GetMovePolicesComponent():GetCurrentLocomotionAction())
        end)
        if not ok then row.error = tostring(err) end
        if not row.entity then return end
        convaiFacingSamples[#convaiFacingSamples + 1] = row
        local file = io.open('runtime/party-facing-watch.json', 'wb')
        if file then file:write(json.encode(convaiFacingSamples)); file:close() end
    end
    if not convaiFacingObserverInstalled then
        ObserveAfter('AIMoveToCommandHandler', 'UpdateCommand', function(handler, context, command)
            if convaiFacingProbe then convaiFacingProbe(handler, context, command) end
        end)
        convaiFacingObserverInstalled = true
    end
    return
end
if request:match('^party%-appearance:') then
    local rows = {}
    local function read(row, key, callback)
        local ok, value = pcall(callback)
        if ok then row[key] = value else row[key] = 'error: ' .. tostring(value) end
    end
    for _, item in ipairs(convaiCompanions.conversationCandidates(Game.GetPlayer(), 30)) do
        local npc, row = item.npc, {name = item.name, entity = item.entity}
        for _, check in ipairs({
            {'appearance', function() return npc:GetCurrentAppearanceName() end},
            {'record', function() return npc:GetRecordID() end},
        }) do
            local ok, value = pcall(check[2])
            row[check[1]] = (ok and '' or 'error: ') .. tostring(value)
        end
        row.components = {}
        for _, component in ipairs(npc:GetComponents()) do
            local name = tostring(component:GetName())
            local visual = component:IsA('entIVisualComponent')
            if visual or name:find('Phantom', 1, true) or name:find('visualOffset', 1, true) then
                local detail = {name = name, visual = visual}
                read(detail, 'enabled', function() return component:IsEnabled() end)
                read(detail, 'class', function() return tostring(component:GetClassName()) end)
                read(detail, 'position', function() return tostring(component:GetLocalPosition()) end)
                read(detail, 'world', function() return tostring(component:GetLocalToWorld()) end)
                for _, field in ipairs({'mesh', 'chunkMask', 'visibilityAnimationParam', 'visibilityAnimationParamEnabled'}) do
                    read(detail, field, function() return tostring(component[field]) end)
                end
                row.components[#row.components + 1] = detail
            end
        end
        rows[#rows + 1] = row
    end
    local records = {}
    for _, record in ipairs(TweakDB:GetRecords('gamedataCharacter_Record')) do
        local id = tostring(record:GetID())
        if id:lower():find('silverhand', 1, true) or id:lower():find('johnny', 1, true) then
            local detail = {id = id}
            read(detail, 'appearance', function() return tostring(record:AppearanceName()) end)
            read(detail, 'template', function() return tostring(record:EntityTemplatePath()) end)
            records[#records + 1] = detail
        end
    end
    local file = io.open('runtime/party-appearance.json', 'wb')
    if file then file:write(json.encode({actors = rows, records = records})); file:close() end
    return
end
if request:match('^viktor%-record%-search:') then
    local ok, result = pcall(function()
        local records = TweakDB:GetRecords('gamedataCharacter_Record')
        local matches = {}
        for _, record in ipairs(records or {}) do
            local id = tostring(record:GetID())
            if id:lower():find('viktor', 1, true) or id:lower():find('victor', 1, true)
                or id:lower():find('ripperdoc', 1, true) then
                matches[#matches + 1] = id
            end
        end
        return 'total=' .. tostring(#(records or {})) .. ' matches=' .. table.concat(matches, ', ')
    end)
    local file = io.open('runtime/viktor-record-search.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^follower%-preflight:') then
    local ok, result = pcall(function()
        local role = NewObject('AIFollowerRole')
        role.followerRef = Game.CreateEntityReference('#player', {})
        return 'role=' .. tostring(role ~= nil) .. ' ref=' .. tostring(role.followerRef)
    end)
    local file = io.open('runtime/follower-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^orientation%-preflight:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local angle = EulerAngles.new(0.0, 0.0, player:GetWorldYaw() + 180.0)
        local quat = EulerAngles.ToQuat(angle)
        return 'yaw=' .. tostring(player:GetWorldYaw()) .. ' quat=' .. tostring(quat)
    end)
    local file = io.open('runtime/orientation-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-preflight:') then
    local ok, result = pcall(function()
        local system = Game.GetDynamicEntitySystem()
        local spec = NewObject('DynamicEntitySpec')
        local record = TweakDB:GetRecord('Character.Judy')
        return 'system=' .. tostring(system ~= nil)
            .. ' ready=' .. tostring(system and system:IsReady())
            .. ' spec=' .. tostring(spec ~= nil)
            .. ' record=' .. tostring(record ~= nil)
    end)
    local file = io.open('runtime/owned-spawn-preflight.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-test:') then
    local ok, result = pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return 'Menu open' end
        local player = Game.GetPlayer()
        local system = Game.GetDynamicEntitySystem()
        if not player or not system or not system:IsReady() then return 'Player or dynamic entity system unavailable' end
        if convaiOwnedSpawnProbe then return 'Previous owned spawn probe still active' end
        local spec = NewObject('DynamicEntitySpec')
        spec.recordID = TweakDBID.new('Character.Judy')
        local position, forward = player:GetWorldPosition(), player:GetWorldForward()
        position.x = position.x + forward.x * 0.5 - forward.y * 1.5
        position.y = position.y + forward.y * 0.5 + forward.x * 1.5
        spec.position = position
        spec.orientation = EulerAngles.ToQuat(EulerAngles.new(0.0, 0.0, player:GetWorldYaw() - 90.0))
        spec.spawnInView = true
        spec.active = true
        local id = system:CreateEntity(spec)
        convaiOwnedSpawnProbe = {id = id, system = system, createdAt = os.time(), position = position}
        return 'requested Judy clone id=' .. tostring(id.hash)
    end)
    local file = io.open('runtime/owned-spawn-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-status:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        if not probe then return 'No owned spawn probe' end
        local spawned = probe.system:IsSpawned(probe.id)
        local entity = probe.system:GetEntity(probe.id)
        local role = entity and entity:GetAIControllerComponent():GetAIRole()
        local player = Game.GetPlayer()
        local moved, distance, commandState, sideDistance = 'n/a', 'n/a', 'n/a', 'n/a'
        if entity then
            local at = entity:GetWorldPosition()
            local start = probe.position
            if start then moved = math.sqrt((at.x - start.x)^2 + (at.y - start.y)^2 + (at.z - start.z)^2) end
            if player then
                local origin = player:GetWorldPosition()
                distance = math.sqrt((at.x - origin.x)^2 + (at.y - origin.y)^2 + (at.z - origin.z)^2)
            end
            if probe.command then commandState = entity:GetAIControllerComponent():GetCommandState(probe.command) end
            if probe.sideTarget then
                local side = probe.sideTarget
                sideDistance = math.sqrt((at.x - side.x)^2 + (at.y - side.y)^2 + (at.z - side.z)^2)
            end
        end
        return 'spawned=' .. tostring(spawned)
            .. ' entity=' .. tostring(entity)
            .. ' crowd=' .. tostring(entity and entity:IsCrowd())
            .. ' role=' .. tostring(role)
            .. ' companion=' .. tostring(entity and entity:IsPlayerCompanion())
            .. ' metres_moved=' .. tostring(moved)
            .. ' distance_to_v=' .. tostring(distance)
            .. ' command=' .. tostring(commandState)
            .. ' side_distance=' .. tostring(sideDistance)
            .. ' elapsed=' .. tostring(os.time() - probe.createdAt)
    end)
    local file = io.open('runtime/owned-spawn-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-follow%-test:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        local npc = probe and probe.system:GetEntity(probe.id)
        local player = Game.GetPlayer()
        if not npc or not player or npc:IsCrowd() then return 'No managed non-crowd NPC to follow' end
        local ai = npc:GetAIControllerComponent()
        local previous = ai:GetAIRole()
        if previous and not previous:IsA('AINoRole') then return 'Skipping clone with authored AI role: ' .. tostring(previous) end
        local follower = NewObject('AIFollowerRole')
        follower.followerRef = Game.CreateEntityReference('#player', {})
        ai:SetAIRole(follower)
        ai:OnAttach()
        npc.isPlayerCompanionCachedTimeStamp = 0
        probe.follower = follower
        local command = NewObject('AIFollowTargetCommand')
        command.target = player
        command.lookAtTarget = player
        command.desiredDistance = 1.0
        command.tolerance = 0.25
        command.movementType = Enum.new('moveMovementType', 'Walk')
        command.matchSpeed = true
        command.teleport = false
        command.stopWhenDestinationReached = false
        ai:SendCommand(command)
        probe.command = command
        return 'follower role applied to owned clone; command=' .. tostring(command)
    end)
    local file = io.open('runtime/owned-follow-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-side%-test:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        local npc = probe and probe.system:GetEntity(probe.id)
        local player = Game.GetPlayer()
        if not npc or not player or not probe.follower then return 'No owned follower' end
        local ai = npc:GetAIControllerComponent()
        if probe.command then ai:CancelCommand(probe.command) end
        local position, forward = player:GetWorldPosition(), player:GetWorldForward()
        position.x = position.x + forward.x * 1.0 - forward.y * 1.4
        position.y = position.y + forward.y * 1.0 + forward.x * 1.4
        local world = WorldPosition.new()
        world:SetVector4(position)
        local spec = AIPositionSpec.new()
        spec:SetWorldPosition(world)
        local command = NewObject('AIMoveToCommand')
        command.movementTarget = spec
        command.movementType = Enum.new('moveMovementType', 'Walk')
        command.desiredDistanceFromTarget = 0.3
        command.finishWhenDestinationReached = true
        command.ignoreNavigation = false
        command.useStart = true
        command.useStop = true
        ai:SendCommand(command)
        probe.command = command
        probe.sideTarget = position
        return 'side move sent; target=' .. tostring(position)
    end)
    local file = io.open('runtime/owned-side-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^owned%-spawn%-cleanup:') then
    local ok, result = pcall(function()
        local probe = convaiOwnedSpawnProbe
        if not probe then return 'No owned spawn probe' end
        local npc = probe.system:GetEntity(probe.id)
        if npc and probe.follower then
            local ai = npc:GetAIControllerComponent()
            if probe.command then ai:CancelCommand(probe.command) end
            probe.follower:OnRoleCleared(npc)
            ai:SetAIRole(NewObject('AINoRole'))
            ai:OnAttach()
        end
        local deleted = probe.system:DeleteEntity(probe.id)
        convaiOwnedSpawnProbe = nil
        return 'deleted=' .. tostring(deleted)
    end)
    local file = io.open('runtime/owned-spawn-cleanup.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^companion%-records:') then
    local names = {
        'Character.Judy', 'Character.judy', 'Character.Panam',
        'Character.panam', 'Character.Misty', 'Character.misty',
        'Character.Viktor', 'Character.viktor',
    }
    local lines = {}
    for _, name in ipairs(names) do
        local ok, record = pcall(function() return TweakDB:GetRecord(name) end)
        lines[#lines + 1] = name .. ' ok=' .. tostring(ok) .. ' exists=' .. tostring(record ~= nil)
    end
    local file = io.open('runtime/companion-records.txt', 'wb')
    if file then file:write(table.concat(lines, '\n'), '\n'); file:close() end
    return
end
if request:match('^attention%-test:') then
    local ok, result = pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return 'Menu open' end
        local player = Game.GetPlayer()
        if not player then return 'No player' end
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc or not npc:IsAttached() or npc:IsDeadNoStatPool() or not npc:IsCrowd() then
            return 'No living crowd NPC within eight metres of crosshair'
        end
        local body = tostring(npc:GetBodyType() or ''):lower()
        if body:find('child', 1, true) or body:find('kid', 1, true) then return 'Skipped child NPC' end
        local workspot = Game.GetWorkspotSystem():IsActorInWorkspot(npc)
        if workspot then return 'Skipped NPC in workspot' end
        local broadcaster = player:GetStimBroadcasterComponent()
        if not broadcaster then return 'Player stimulus broadcaster unavailable' end
        pcall(function() player:ConvaiEndFocus() end)
        convaiAttentionProbe = {npc = npc, position = npc:GetWorldPosition(), startedAt = os.time(), expires = os.time() + 8}
        local sent, sendError = pcall(function()
            broadcaster:SendDrirectStimuliToTarget(player, Enum.new('gamedataStimType', 'Attention'), npc)
        end)
        if not sent then convaiAttentionProbe = nil; return 'Attention send failed: ' .. tostring(sendError) end
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' name=' .. tostring(npc:GetTweakDBFullDisplayName(true))
            .. ' body=' .. body
            .. ' moving_before=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
            .. ' attention_sent=true'
    end)
    local file = io.open('runtime/attention-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^attention%-status:') then
    local ok, result = pcall(function()
        local probe = convaiAttentionProbe
        if not probe then return 'No live attention probe' end
        local npc = probe.npc
        if not npc or not npc:IsAttached() then return 'NPC streamed out' end
        local pos, start = npc:GetWorldPosition(), probe.position
        local moved = math.sqrt((pos.x - start.x)^2 + (pos.y - start.y)^2 + (pos.z - start.z)^2)
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' elapsed_seconds=' .. tostring(os.time() - probe.startedAt)
            .. ' metres_moved=' .. tostring(moved)
            .. ' moving=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
    end)
    local file = io.open('runtime/attention-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^role%-callability:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        if not player then return 'No player' end
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 20.0
        local npc = Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc then return 'No NPC near crosshair' end
        local ai = npc:GetAIControllerComponent()
        local role = ai and ai:GetCurrentRole()
        local created = NewObject('AIFollowerRole')
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' crowd=' .. tostring(npc:IsCrowd())
            .. ' moving=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
            .. ' role=' .. tostring(role)
            .. ' role_enum=' .. (role and tostring(role:GetRoleEnum()) or 'none')
            .. ' companion=' .. tostring(npc:IsPlayerCompanion())
            .. ' new_follower_role=' .. tostring(created)
    end)
    local file = io.open('runtime/role-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^hold%-test:') then
    local player = Game.GetPlayer()
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = 8.0
    local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
    local ok, result = pcall(function()
        if not npc or not npc:IsCrowd() then return 'No crowd target' end
        local hold = NewObject('AIHoldPositionCommand')
        hold.duration = 12.0
        AIComponent.SendCommand(npc, hold)
        convaiProbeHold = hold
        convaiProbeNpc = npc
        convaiProbePosition = npc:GetWorldPosition()
        return 'Sent 12-second hold to ' .. tostring(npc:GetEntityID().hash)
    end)
    local file = io.open('runtime/hold-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^hold%-status:') then
    local npc, hold = convaiProbeNpc, convaiProbeHold
    local ok, result = pcall(function()
        if not npc or not hold then return 'No live hold probe' end
        local ai = npc:GetAIControllerComponent()
        local state = ai:GetCommandState(hold)
        local position = npc:GetWorldPosition()
        local start = convaiProbePosition
        local moved = math.sqrt((position.x - start.x)^2 + (position.y - start.y)^2 + (position.z - start.z)^2)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' state=' .. tostring(state) .. ' metres_moved=' .. tostring(moved)
    end)
    local file = io.open('runtime/hold-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-test:') then
    local ok, result = pcall(function()
        local defs = Game.GetAllBlackboardDefs()
        if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then return 'Menu open' end
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc or not npc:IsCrowd() then return 'No crowd NPC at crosshair' end
        local crowd = npc:GetCrowdMemberComponent()
        if not crowd then return 'Crowd component unavailable' end
        local before = crowd:CheckIsMoving()
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' moving=' .. tostring(before)
    end)
    local file = io.open('runtime/traffic-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-resume%-test:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc or not npc:IsCrowd() then return 'No crowd NPC at crosshair' end
        local crowd = npc:GetCrowdMemberComponent()
        if not crowd then return 'Crowd component unavailable' end
        local before = crowd:CheckIsMoving()
        local blocked = crowd:IsBlockedInTraffic()
        convaiResumeNpc = npc
        convaiResumePosition = npc:GetWorldPosition()
        crowd:TryChangeMovementDirection()
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' moving_before=' .. tostring(before)
            .. ' blocked=' .. tostring(blocked) .. ' moving_after=' .. tostring(crowd:CheckIsMoving())
    end)
    local file = io.open('runtime/traffic-resume-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-resume%-status:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local current = npc:GetWorldPosition()
        local start = convaiResumePosition
        local moved = math.sqrt((current.x - start.x)^2 + (current.y - start.y)^2 + (current.z - start.z)^2)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' metres_moved=' .. tostring(moved)
            .. ' moving=' .. tostring(npc:GetCrowdMemberComponent():CheckIsMoving())
    end)
    local file = io.open('runtime/traffic-resume-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-join%-test:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local command = NewObject('AIJoinCrowdCommand')
        AIComponent.SendCommand(npc, command)
        convaiJoinCommand = command
        convaiResumePosition = npc:GetWorldPosition()
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' join command sent'
    end)
    local file = io.open('runtime/traffic-join-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^traffic%-join%-status:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local current = npc:GetWorldPosition()
        local start = convaiResumePosition
        local moved = math.sqrt((current.x - start.x)^2 + (current.y - start.y)^2 + (current.z - start.z)^2)
        local state = npc:GetAIControllerComponent():GetCommandState(convaiJoinCommand)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' join_state=' .. tostring(state)
            .. ' metres_moved=' .. tostring(moved)
    end)
    local file = io.open('runtime/traffic-join-status.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^time%-callability:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        npc:SetIndividualTimeDilation(CName.new('ConvaiProbe'), 0.5, 3.0, CName.new(''), CName.new(''), false, true)
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' has_probe=' .. tostring(npc:HasIndividualTimeDilation(CName.new('ConvaiProbe')))
            .. ' dilation=' .. tostring(npc:GetTimeDilationValue())
    end)
    local file = io.open('runtime/time-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^teleport%-callability:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local position = npc:GetWorldPosition()
        local rotation = EulerAngles.new(0.0, 0.0, npc:GetWorldYaw())
        Game.GetTeleportationFacility():Teleport(npc, position, rotation)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' yaw=' .. tostring(npc:GetWorldYaw())
    end)
    local file = io.open('runtime/teleport-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^movement%-params:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        local npc = player and Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
        if not npc then return 'No NPC at crosshair' end
        local ai = npc:GetAIControllerComponent()
        local walk = ai:GetMovementParams(Enum.new('moveMovementType', 'Walk'))
        local run = ai:GetMovementParams(Enum.new('moveMovementType', 'Run'))
        return 'actor=' .. tostring(npc:GetEntityID().hash)
            .. ' walk_speed=' .. tostring(walk.maxSpeed) .. ' walk_accel=' .. tostring(walk.acceleration)
            .. ' run_speed=' .. tostring(run.maxSpeed) .. ' run_accel=' .. tostring(run.acceleration)
    end)
    local file = io.open('runtime/movement-params.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^parts%-test:') then
    local ok, result = pcall(function()
        local player = Game.GetPlayer()
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = 8.0
        query.includeSecondaryTargets = true
        local targeting = Game.GetTargetingSystem()
        local found, parts = targeting:GetTargetParts(player, query)
        local position, direction = targeting:GetCrosshairData(player)
        local rows = {'found=' .. tostring(found) .. ' count=' .. tostring(parts and #parts or 0)
            .. ' crosshair_types=' .. type(position) .. ',' .. type(direction)
            .. ' direction=' .. tostring(direction and direction.x) .. ',' .. tostring(direction and direction.y)
            .. ',' .. tostring(direction and direction.z)}
        for i = 1, math.min(parts and #parts or 0, 6) do
            local component = TS_TargetPartInfo.GetComponent(parts[i])
            local entity = component and component:GetEntity()
            rows[#rows + 1] = 'actor=' .. tostring(entity and entity:GetEntityID().hash)
                .. ' name=' .. tostring(entity and entity:GetTweakDBFullDisplayName(true))
        end
        return table.concat(rows, '; ')
    end)
    local file = io.open('runtime/parts-test.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^policy%-callability:') then
    local ok, result = pcall(function()
        local npc = convaiResumeNpc
        if not npc or not npc:IsAttached() then return 'No attached NPC from resume probe' end
        local component = npc:GetMovePolicesComponent()
        if not component then return 'No move policies component' end
        local policy = NewObject('MovePolicies')
        policy:SetDestinationPosition(npc:GetWorldPosition())
        policy:SetDistancePolicy(0.0, 0.1)
        component:AddPolicies(policy)
        local top = component:GetTopPolicies()
        component:PopPolicies(policy)
        return 'actor=' .. tostring(npc:GetEntityID().hash) .. ' top_is_test=' .. tostring(top == policy)
    end)
    local file = io.open('runtime/policy-callability.txt', 'wb')
    if file then file:write('ok=', tostring(ok), '\nresult=', tostring(result), '\n'); file:close() end
    return
end
if request:match('^character%-records:') then
    local lines = {}
    for _, id in ipairs({'Character.Judy', 'Character.Panam', 'Character.Viktor', 'Character.Misty'}) do
        local ok, record = pcall(function() return TweakDB:GetRecord(id) end)
        lines[#lines + 1] = id .. ' exists=' .. tostring(ok and record ~= nil)
    end
    local file = io.open('runtime/character-records.txt', 'wb')
    if file then file:write(table.concat(lines, '\n'), '\n'); file:close() end
    return
end
if request:match('^contacts:') then
    local lines = {}
    local ok, err = pcall(function()
        local contacts = Game.GetJournalManager():GetContactDataArray(false, false)
        lines[#lines + 1] = 'count=' .. tostring(#contacts)
        for index, contact in ipairs(contacts) do
            local name = tostring(contact.localizedName or '')
            local okLocalized, localized = pcall(function() return GetLocalizedText(contact.localizedName) end)
            local display = okLocalized and tostring(localized) or name
            if index <= 10 then
                lines[#lines + 1] = 'sample id=' .. tostring(contact.id) .. ' name=' .. name .. ' display=' .. display
            end
            if display:lower():find('judy', 1, true) or display:lower():find('panam', 1, true)
                or display:lower():find('misty', 1, true) or display:lower():find('viktor', 1, true)
                or display:lower():find('vektor', 1, true) then
                lines[#lines + 1] = 'id=' .. tostring(contact.id) .. ' name=' .. display .. ' callable=' .. tostring(contact.isCallable)
            end
        end
    end)
    if not ok then lines[#lines + 1] = 'error=' .. tostring(err) end
    local file = io.open('runtime/phone-contacts.txt', 'wb')
    if file then file:write(table.concat(lines, '\n'), '\n'); file:close() end
    return
end
if request:match('^manager%-close:') then
    local player = Game.GetPlayer()
    local ok, result = pcall(function() return player and player:ConvaiCloseManager() end)
    local resultFile = io.open('runtime/manager-status.txt', 'wb')
    if resultFile then
        resultFile:write('request=', request, '\nclose_ok=', tostring(ok), '\nclosed=', tostring(result), '\n')
        resultFile:close()
    end
    return
end
if request:match('^mcm%-state:') then
    local file = io.open('runtime/mcm-state.json', 'wb')
    if file then file:write(json.encode(convaiManager and convaiManager.inspect() or {available = false})); file:close() end
    return
end
if request:match('^mcm%-entry%-reload:') then
    local result = 'Manager is not loaded.'
    if convaiManager then
        -- Patch our public module table, which the hotkey and update loop both
        -- retain. The provider, open page, party queue and drafts stay intact.
        if convaiMcmEntryProbe then convaiMcmEntryProbe.reset() end
        convaiMcmEntryProbe = dofile('mcm-entry.lua').new('Companion Manager',
            function() return convaiManager.inspect().available end,
            function(message)
                local f = io.open('runtime/mcm.log', 'a')
                if f then f:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', message, '\n'); f:close() end
            end)
        convaiMcmEntryProbe.install()
        if not convaiMcmOriginalUpdate then
            convaiMcmOriginalUpdate = convaiManager.update
            convaiManager.update = function(...)
                convaiMcmOriginalUpdate(...)
                convaiMcmEntryProbe.update()
            end
        end
        convaiManager.open = function() return convaiMcmEntryProbe.open() end
        result = 'Entry adapter reloaded.'
    end
    local file = io.open('runtime/mcm-entry-reload.txt', 'wb')
    if file then file:write(result); file:close() end
    return
end
if request:match('^mcm%-entry%-state:') then
    local file = io.open('runtime/mcm-entry-state.json', 'wb')
    if file then file:write(json.encode(convaiMcmEntryProbe and convaiMcmEntryProbe.inspect() or {})); file:close() end
    return
end
if request:match('^mcm%-native%-state:') then
    local result = {}
    for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
        for _, controller in ipairs(layer:GetGameControllers()) do
            if controller:IsA('PauseMenuGameController') or controller:IsA('SettingsMainGameController') then
                local row = {layer = tostring(layer:GetLayerName()), type = tostring(controller)}
                for _, field in ipairs({'menuListController', 'm_menuListController'}) do
                    local ok, value = pcall(function() return controller[field] end)
                    row[field] = ok and tostring(value) or ('error: ' .. tostring(value))
                end
                result[#result + 1] = row
            end
        end
    end
    local file = io.open('runtime/mcm-native-state.json', 'wb')
    if file then file:write(json.encode(result)); file:close() end
    return
end
if request:match('^manager:') then
    local player = Game.GetPlayer()
    local opened = convaiManager and convaiManager.open()
    local resultFile = io.open('runtime/manager-status.txt', 'wb')
    if resultFile then
        resultFile:write('request=', request, '\nplayer=', tostring(player ~= nil), '\nopened=', tostring(opened), '\n')
        resultFile:close()
    end
    print('[CyberpunkConvai] Companion manager request: ' .. tostring(opened))
    return
end

local out = { 'Cyberpunk Convai NPC diagnostic v1', os.date('!UTC %Y-%m-%dT%H:%M:%SZ') }
local function add(key, value)
    local s = tostring(value == nil and '<none>' or value):gsub('[\r\n]', ' ')
    out[#out + 1] = key .. ': ' .. s:sub(1, 240)
end
local function get(label, fn)
    local ok, value = pcall(fn)
    if ok then add(label, value); return value end
    add(label, '<unavailable: ' .. tostring(value):sub(1, 120) .. '>')
    return nil
end

local player = get('player', function() return Game.GetPlayer() end)
if player then
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = 50.0
    local npc = get('crosshair target', function()
        return Game.GetTargetingSystem():GetObjectClosestToCrosshair(player, query)
    end)
    if npc then
        get('display name', function() return npc:GetTweakDBFullDisplayName(true) end)
        get('entity ID hash', function() return npc:GetEntityID().hash end)
        get('record ID', function() return npc:GetRecordID() end)
        get('body type', function() return npc:GetBodyType() end)
        get('gender', function() return npc:GetGender() end)
        get('appearance', function() return npc:GetCurrentAppearanceName() end)
        get('is NPC', function() return npc:IsNPC() end)
        get('is attached', function() return npc:IsAttached() end)
        get('is dead', function() return npc:IsDeadNoStatPool() end)
        get('is civilian', function() return npc:IsCharacterCivilian() end)
        get('is crowd', function() return npc:IsCrowd() end)
        get('is in workspot', function() return Game.GetWorkspotSystem():IsActorInWorkspot(npc) end)
        get('AI controller', function() return npc:GetAIControllerComponent() end)
        get('hold constructor', function() return NewObject('AIHoldPositionCommand') end)

        local components = get('component array', function() return npc:GetComponents() end)
        if components then
            local okCount, count = pcall(function() return #components end)
            add('component count', okCount and count or '<unavailable>')
            for i = 1, okCount and math.min(count, 100) or 0 do
                local okComponent, component = pcall(function() return components[i] end)
                if okComponent and component then
                local okName, name = pcall(function() return component:GetName() end)
                local okClass, class = pcall(function() return component:GetClassName() end)
                add('component ' .. i, (okName and tostring(name) or '?') .. ' / ' .. (okClass and tostring(class) or '?'))
                end
            end
        end
        for _, name in ipairs({'face', 'facial', 'facialRig', 'facialAnimation', 'animationController', 'characterEntityAnimationSetup'}) do
            local component = get('component lookup ' .. name, function() return npc:FindComponentByName(name) end)
            if component then
                get(name .. ' class', function() return component:GetClassName() end)
            end
        end
    end
end

local path = 'runtime/npc-diagnostic-' .. os.date('!%Y%m%d-%H%M%S') .. '.txt'
local file, err = io.open(path, 'wb')
if not file then
    print('[CyberpunkConvai] Diagnostic save failed: ' .. tostring(err))
else
    file:write(table.concat(out, '\n'), '\n')
    file:close()
    print('[CyberpunkConvai] NPC diagnostic saved: ' .. path)
end
