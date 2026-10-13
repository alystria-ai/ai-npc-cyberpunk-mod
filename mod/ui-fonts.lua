-- Font selection for mod-owned ink text. Native access belongs in top-level
-- presentation updates. Scopes retain plain values, never widget handles.
if type(convaiUiFonts)=='table' and convaiUiFonts.version==2 then return convaiUiFonts end
local M={version=2}
local base='base\\gameplay\\gui\\fonts\\foreign\\'
local families={
    ['zh-cn']={path=base..'chinese\\jing_xi_heig\\jing_xi_heig.inkfontfamily',styles={'Regular','Semi-Bold'}},
    ['zh-tw']={path=base..'chinese_traditional\\jing_xi_heig_b5\\jing_xi_heig_b5.inkfontfamily',styles={'Medium','Bold','Extra Bold','Semi-Bold'}},
    ja={path=base..'japanese\\mgenplus\\mgenplus.inkfontfamily',styles={'Regular','Light','Medium','Bold','Heavy','Semi-Bold'}},
    ko={path=base..'korean\\nanum_square\\nanum_square.inkfontfamily',styles={'Regular','Light','Bold','Extra Bold','Semi-Bold'}},
    ru={path=base..'russian\\raj_rus.inkfontfamily',styles={'Medium','Semi-Bold'}},
    -- Ukrainian ships with the game as ua-ua and uses the same Cyrillic family.
    uk={path=base..'russian\\raj_rus.inkfontfamily',styles={'Medium','Semi-Bold'}},
}
-- Italian, Polish, Czech, Hungarian and Turkish need only Latin / Latin
-- Extended-A. The game ships those languages with its ordinary Latin family,
-- so they deliberately have no entry: owned text keeps its original font.
local autonyms={['English']='en',['简体中文']='zh-cn',['繁體中文']='zh-tw',
    ['Español']='es',['Português (Brasil)']='pt-br',['Français']='fr',
    ['Deutsch']='de',['Italiano']='it',['Polski']='pl',['Čeština']='cs',['Magyar']='hu',
    ['Türkçe']='tr',['Русский']='ru',['Українська']='uk',['日本語']='ja',['한국어']='ko'}
function M.family(code) return families[code] and families[code].path or nil end
-- The script of a piece of text, from its own letters (the same test as bridge/reply-language.mjs, in UTF-8 bytes because the game's Lua
-- has no utf8 library): kana is Japanese, Hangul is Korean, Han without kana is Chinese, Cyrillic is Russian (Ukrainian shares its family);
-- anything else (Latin, Greek, ...) is nil, the game's own font. One pass over at most 4000 bytes; call it once per reply, not per frame.
function M.scriptCode(text)
    if type(text)~='string' then return nil end
    local kana,hangul,han,cyrillic=false,false,false,false
    local i,n=1,math.min(#text,4000)
    while i<=n do
        local b=text:byte(i)
        if b<0xC2 then i=i+1
        elseif b<0xE0 then
            local b2=text:byte(i+1) or 0
            -- U+0400..U+04FF is D0..D3, U+0500..U+052F is D4 80..AF.
            if (b>=0xD0 and b<=0xD3) or (b==0xD4 and b2<0xB0) then cyrillic=true end
            i=i+2
        elseif b<0xF0 then
            local cp=((b%16)*64+((text:byte(i+1) or 0)%64))*64+((text:byte(i+2) or 0)%64)
            if (cp>=0x3040 and cp<=0x30FF) or (cp>=0x31F0 and cp<=0x31FF) or (cp>=0xFF66 and cp<=0xFF9F) then kana=true
            elseif (cp>=0xAC00 and cp<=0xD7FF) or (cp>=0x1100 and cp<=0x11FF) or (cp>=0x3130 and cp<=0x318F) or (cp>=0xA960 and cp<=0xA97F) then hangul=true
            elseif (cp>=0x3400 and cp<=0x4DBF) or (cp>=0x4E00 and cp<=0x9FFF) or (cp>=0xF900 and cp<=0xFAFF) then han=true end
            i=i+3
        else
            if b==0xF0 and (text:byte(i+1) or 0)>=0xA0 then han=true end   -- CJK extensions, U+20000 and up
            i=i+4
        end
    end
    if kana then return 'ja' elseif hangul then return 'ko' elseif han then return 'zh-cn' elseif cyrillic then return 'ru' end
    return nil
end
-- The family code for a reply (or message) text, or false when the game's own font is right. Decided once per text (a small memo), so
-- a text that is drawn again, or a widget walked again, costs a table lookup. Traditional Chinese follows an interface set to it.
local memo,memoCount={},0
function M.replyCode(text)
    if type(text)~='string' then return false end
    local code=memo[text]
    if code==nil then
        code=M.scriptCode(text) or false
        if memoCount>=64 then memo,memoCount={},0 end
        memo[text],memoCount=code,memoCount+1
    end
    if code=='zh-cn' and convaiUiLocale and convaiUiLocale.current()=='zh-tw' then return 'zh-tw' end
    return code
end
function M.codeForText(text,code)
    if code==false then return false end
    -- 'reply': each widget gets the family of its own text (Latin widgets next to it, a speaker name for one, keep their font).
    if code=='reply' then return M.replyCode(text) end
    return autonyms[text] or code or (convaiUiLocale and convaiUiLocale.current()) or 'en'
end
function M.key(widget)
    if not widget then return nil end
    local ok,value=pcall(CalcSeed,widget)
    return ok and value~=nil and tostring(value) or nil
end
local function textWidget(widget)
    return widget and (widget:IsA('inkTextWidget') or widget:IsA('inkText'))
end
local function identity(widget)
    -- CET's ResourceAsyncReference wrapper exposes hash and converts directly
    -- to ResRef. Codeware.GetPath(script_ref<ResourceAsyncRef>) cannot accept it.
    return tostring(widget.fontFamily.hash)
end
local function snapshot(widget)
    local path=ResRef.ToString(widget.fontFamily)
    if type(path)~='string' or not path:match('%.inkfontfamily$') or path:find('%z') then return nil end
    return {path=path,style=NameToString(widget:GetFontStyle()),lock=widget:GetLockFontInGame()}
end
local function targetStyle(spec,original)
    for _,style in ipairs(spec.styles)do if style==original then return style end end
    -- Avoid the absent Regular in Russian/Traditional Chinese and absent
    -- Medium in Simplified Chinese/Korean; all installed families have this.
    return 'Semi-Bold'
end
function M.new()
    local S={}
    local records,generation,count={},0,0
    local function discard(key)
        if records[key] then records[key]=nil;count=count-1 end
    end
    function S.begin() generation=generation+1 end
    function S.touch(widget)
        local key=M.key(widget)
        if key and records[key] then records[key].seen=generation;return true end
        return false
    end
    function S.contains(widget) return records[M.key(widget)]~=nil end
    function S.canApply(widget,code,explicitText)
        if not textWidget(widget) or not M.key(widget) then return false end
        local content=explicitText
        if content==nil then content=widget:GetText() end
        if not families[M.codeForText(content,code)] then return true end
        return snapshot(widget)~=nil
    end
    function S.restore(widget)
        local key=M.key(widget)
        local record=key and records[key]
        if not record then return false end
        if identity(widget)~=record.appliedHash then discard(key);return false end
        -- Use ink's setter for its resource invalidation, not a raw property
        -- assignment. Respect later independent style/lock edits.
        local style=NameToString(widget:GetFontStyle())
        if style==record.appliedStyle then style=record.style end
        widget:SetFontFamily(record.path,CName.new(style))
        if widget:GetLockFontInGame()==true then widget:SetLockFontInGame(record.lock) end
        discard(key)
        return true
    end
    function S.apply(widget,code,explicitText)
        if not textWidget(widget) then return false end
        local key=M.key(widget)
        if not key then return false end
        local record=records[key]
        if record then
            record.seen=generation
            if identity(widget)~=record.appliedHash then discard(key);record=nil end
        end
        local content=explicitText
        if content==nil then content=widget:GetText() end
        local spec=families[M.codeForText(content,code)]
        if not spec then return S.restore(widget) end
        if not record then
            if count>=2048 then return false end
            record=snapshot(widget)
            if not record then return false end
            records[key]=record;count=count+1
        end
        record.seen=generation
        local style=targetStyle(spec,record.style)
        if record.appliedPath==spec.path and NameToString(widget:GetFontStyle())==style
            and widget:GetLockFontInGame()==true then return false end
        widget:SetFontFamily(spec.path,CName.new(style))
        record.appliedHash=identity(widget)
        record.appliedPath,record.appliedStyle=spec.path,style
        widget:SetLockFontInGame(true)
        return true
    end
    function S.walk(root,code,budget)
        budget=budget or {left=2048}
        local changed=0
        local function visit(widget,depth)
            if not widget or depth>20 or budget.left<=0 then return end
            budget.left=budget.left-1
            if S.apply(widget,code) then changed=changed+1 end
            local compound,size=pcall(function()return widget:GetNumChildren()end)
            if compound then
                for index=0,math.min(size,1200)-1 do
                    if budget.left<=0 then break end
                    visit(widget:GetWidgetByIndex(index),depth+1)
                end
            end
        end
        visit(root,0)
        return changed
    end
    function S.finish()
        for key,record in pairs(records)do if record.seen~=generation then discard(key)end end
    end
    function S.clear() records,generation,count={},0,0 end
    function S.count() return count end
    return S
end
convaiUiFonts=M
return M
