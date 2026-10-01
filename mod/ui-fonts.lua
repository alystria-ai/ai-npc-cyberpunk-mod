-- Font selection for mod-owned ink text. Native access belongs in top-level
-- presentation updates. Scopes retain plain values, never widget handles.
if type(convaiUiFonts)=='table' and convaiUiFonts.version==1 then return convaiUiFonts end
local M={version=1}
local base='base\\gameplay\\gui\\fonts\\foreign\\'
local families={
    ['zh-cn']={path=base..'chinese\\jing_xi_heig\\jing_xi_heig.inkfontfamily',styles={'Regular','Semi-Bold'}},
    ['zh-tw']={path=base..'chinese_traditional\\jing_xi_heig_b5\\jing_xi_heig_b5.inkfontfamily',styles={'Medium','Bold','Extra Bold','Semi-Bold'}},
    ja={path=base..'japanese\\mgenplus\\mgenplus.inkfontfamily',styles={'Regular','Light','Medium','Bold','Heavy','Semi-Bold'}},
    ko={path=base..'korean\\nanum_square\\nanum_square.inkfontfamily',styles={'Regular','Light','Bold','Extra Bold','Semi-Bold'}},
    ru={path=base..'russian\\raj_rus.inkfontfamily',styles={'Medium','Semi-Bold'}},
}
local autonyms={['English']='en',['简体中文']='zh-cn',['繁體中文']='zh-tw',
    ['Español']='es',['Português (Brasil)']='pt-br',['Français']='fr',
    ['Deutsch']='de',['Русский']='ru',['日本語']='ja',['한국어']='ko'}
function M.family(code) return families[code] and families[code].path or nil end
function M.codeForText(text,code)
    if code==false then return false end
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
