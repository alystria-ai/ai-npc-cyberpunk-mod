-- Bounded journal inventory. All retained queues contain hashes/strings only.
-- These are V's revealed journal entries, never inferred choices or memories.
local M = {}; local Collector = {}; Collector.__index = Collector
local STATES = {Active='active', Succeeded='succeeded', Failed='failed'}
local function integer(v,lo,hi) return type(v)=='number' and v==v and v%1==0 and v>=lo and v<=hi end
local function plain(v) return type(v)=='table' and getmetatable(v)==nil end
local function hash(v)
    local n=tonumber(v); if not integer(n,-2147483648,4294967295) then return nil end
    return string.format('%.0f',n<0 and n+4294967296 or n)
end
local function token(v) return type(v)=='string' and #v>0 and #v<=160 and v:match('^[A-Za-z0-9_:%-][A-Za-z0-9_.:/@+#%-]*$')~=nil end
local function text(v,limit)
    if type(v)~='string' then return nil end
    v=v:gsub('<[^>]*>',''):gsub('%c',' '):gsub('%s+',' '):match('^%s*(.-)%s*$')
    return #v>0 and #v<=limit and not v:match('^LocKey#') and v or nil
end
local function copy(v)
    if type(v)~='table' then return v end
    local out={}; for k,item in pairs(v) do out[k]=copy(item) end; return out
end
-- gameJournalEntryState by integer value, built once: one EnumInt per read instead of up to three Enum.new.
local stateByInt
local function state(journal,entry)
    local value=journal:GetEntryState(entry)
    if stateByInt==nil then
        stateByInt={}
        for key,label in pairs(STATES) do
            local ok,number=pcall(function() return tonumber(EnumInt(Enum.new('gameJournalEntryState',key))) end)
            if ok and number then stateByInt[number]=label end
        end
        if next(stateByInt)==nil then stateByInt=false end
    end
    if stateByInt then
        local ok,number=pcall(function() return tonumber(EnumInt(value)) end)
        if ok and number then return stateByInt[number] end
    end
    for key,label in pairs(STATES) do if value==Enum.new('gameJournalEntryState',key) then return label end end
end
local function filter(lane)
    return JournalRequestStateFilter.new({inactive=false,active=lane~='history',succeeded=lane~='active',failed=lane~='active'})
end
local function array(first,second)
    local values=type(second)=='table' and second or first
    assert(type(values)=='table','Native journal array unavailable'); return values
end
local function localized(value,limit) return text(GetLocalizedText(value),limit) end
-- The game's own quest category (gameJournalQuestType). A quest's type is
-- cooked data, so each hash is resolved once per session; the enum lookup table
-- is built once. Unknown names simply do not resolve.
local QUEST_TYPES={'MainQuest','SideQuest','MinorQuest','StreetStory','Contract','VehicleQuest',
    'CyberPsycho','CourierQuest','CourierSideQuest','ApartmentQuest'}
local questTypeNames,questTypeCache=nil,{}
local function questType(journal,entry,id)
    local cached=questTypeCache[id]; if cached~=nil then return cached or nil end
    if not questTypeNames then
        questTypeNames={}
        for _,name in ipairs(QUEST_TYPES) do
            local ok,value=pcall(function() return tonumber(EnumInt(Enum.new('gameJournalQuestType',name))) end)
            if ok and value then questTypeNames[value]=name end
        end
    end
    local ok,value=pcall(function() return tonumber(EnumInt(journal:GetQuestType(entry))) end)
    local name=ok and value and questTypeNames[value] or nil
    questTypeCache[id]=name or false; return name
end
-- Game seconds of the entry's last state change; nil unless both readings agree.
local function gameSeconds(journal,entry)
    local ok,stamp=pcall(function() return journal:GetEntryTimestamp(entry) end)
    if not ok or stamp==nil then return nil end
    local function valid(v) v=tonumber(v); return integer(v,0,4294967295) and v or nil end
    local okField,field=pcall(function() return valid(stamp.seconds) end)
    local okTotal,total=pcall(function() return valid(GameTime.GetSeconds(stamp)) end)
    field,total=okField and field or nil,okTotal and total or nil
    if field and total and field~=total then return nil end
    return field or total
end
local function path(journal,entry)
    local ids,seen={},{}
    for _=1,16 do
        if not entry then return table.concat(ids,'/') end
        local id=hash(journal:GetEntryHash(entry)); if not id or seen[id] then return nil end; seen[id]=true
        local part=entry:GetId()
        if type(part)~='string' or #part>160 or part:find('[%c]') then return nil end
        if part~='' then table.insert(ids,1,part) end
        entry=journal:GetParentEntry(entry)
    end
    return nil
end
local function descriptor(journal,entry)
    local status=state(journal,entry); if not status then return nil end
    local id,nativeId=hash(journal:GetEntryHash(entry)),text(entry:GetId(),160)
    if not id or not nativeId then return nil end
    local out={id=id,nativeId=nativeId,state=status}
    if entry:IsA('gameJournalQuest') then
        out.kind='quest'; out.title=localized(entry:GetTitle(journal),320)
        out.nativePath=path(journal,entry)
        if not out.title then return nil end
        -- One quest root per page row: two extra native reads per quest per scan.
        out.questType=questType(journal,entry,id); out.gameTimeSeconds=gameSeconds(journal,entry)
    elseif entry:IsA('gameJournalQuestObjectiveBase') then
        out.kind='objective'; out.text=localized(entry:GetDescription(),1200)
        if not out.text then return nil end
        local ok,optional=pcall(function() return journal:GetIsObjectiveOptional(entry) end)
        if ok and type(optional)=='boolean' then out.optional=optional end
    elseif entry:IsA('gameJournalQuestPhase') then out.kind='phase'
    else return nil end
    return out
end
local function ready()
    local player=Game.GetPlayer()
    return player and player:IsAttached() and not player:IsDeadNoStatPool()
        and not Game.GetSystemRequestsHandler():IsPreGame() and not Game.GetJournalManager():HasAnyDelayedStateChanges() or false
end
local function roots(lane,cursor,limit)
    local journal=Game.GetJournalManager()
    local context=JournalRequestContext.new({stateFilter=filter(lane)})
    local entries=array(journal:GetQuests(context))
    local rows,finish,omitted={},math.min(#entries,cursor+limit-1),0
    for i=cursor,finish do
        local row=descriptor(journal,entries[i])
        if row and row.kind=='quest' and ((lane=='active' and row.state=='active') or (lane=='history' and row.state~='active')) then rows[#rows+1]=row
        elseif not row and state(journal,entries[i]) and entries[i]:IsA('gameJournalQuest') then omitted=omitted+1 end
    end
    return {rows=rows,total=#entries,next=finish+1,done=finish>=#entries,omitted=omitted,examined=math.max(0,finish-cursor+1)}
end
local function children(task,limit)
    local journal=Game.GetJournalManager(); local entry=journal:GetEntry(tonumber(task.id))
    if not entry or hash(journal:GetEntryHash(entry))~=task.id then return {rows={},done=true,unavailable=true} end
    local cursor,seen=entry,{}; local questState
    for depth=1,16 do
        local id=hash(journal:GetEntryHash(cursor)); if not id or seen[id] or not state(journal,cursor) then return {rows={},done=true,unavailable=true} end
        seen[id]=true
        if cursor:IsA('gameJournalQuest') then
            if id~=task.quest then return {rows={},done=true,unavailable=true} end
            questState=state(journal,cursor); break
        end
        cursor=journal:GetParentEntry(cursor); if not cursor or depth==16 then return {rows={},done=true,unavailable=true} end
    end
    local entries=array(journal:GetChildren(entry,filter('all')))
    local rows,finish,omitted={},math.min(#entries,task.cursor+limit-1),0
    for i=task.cursor,finish do
        local child=entries[i]; local parent=journal:GetParentEntry(child)
        if parent and hash(journal:GetEntryHash(parent))==task.id then
            local row=descriptor(journal,child)
            if row and row.kind~='quest' then rows[#rows+1]=row
            elseif not row and state(journal,child) and child:IsA('gameJournalQuestObjectiveBase') then omitted=omitted+1 end
        end
    end
    return {rows=rows,total=#entries,next=finish+1,done=finish>=#entries,questState=questState,omitted=omitted,
        examined=math.max(0,finish-task.cursor+1)}
end
local function tracked()
    local journal=Game.GetJournalManager(); local entry=journal:GetTrackedEntry()
    if not entry then return {status='untracked'} end
    local objective=entry:IsA('gameJournalQuestObjectiveBase') and hash(journal:GetEntryHash(entry)) or nil
    local seen={}
    for _=1,16 do
        local id=hash(journal:GetEntryHash(entry)); if not id or seen[id] or state(journal,entry)~='active' then return {status='unknown'} end
        seen[id]=true
        if entry:IsA('gameJournalQuest') then return {status='known',questId=id,objectiveId=objective} end
        entry=journal:GetParentEntry(entry); if not entry then break end
    end
    return {status='unknown'}
end
local function option(v,default,lo,hi) return integer(v,lo,hi) and v or default end
function M.new(options)
    options=options or {}; local adapter=options.adapter or {}
    local self=setmetatable({adapter={isReady=adapter.isReady or ready,roots=adapter.roots or roots,
        children=adapter.children or children,tracked=adapter.tracked or tracked},
        currentGeneration=options.currentGeneration,currentWorldToken=options.currentWorldToken,
        now=options.now or os.time,pageSize=option(options.pageSize,8,1,32),
        maxQuests=option(options.maxQuests,1024,1,2048),maxNodes=option(options.maxNodes,8192,1,16384),
        maxObjectives=option(options.maxObjectives,4096,1,8192),maxPerQuest=option(options.maxPerQuest,128,1,256),
        maxDepth=option(options.maxDepth,12,1,16),maxBytes=option(options.maxBytes,1500000,1000,1500000),
        -- Lanes rest between scans and rescan at once on demand (a journal change, the composer, phone chat or
        -- talk key; see init.lua). The bridge's limits (bridge/journal-history.mjs freshQuest) are 15 s for
        -- active quests and 600 s for history, above these ages plus one scan.
        activeAge=option(options.activeMaxAge,15,1,15),historyAge=option(options.historyMaxAge,600,15,600),
        activeInterval=option(options.activeRefresh,10,1,60),historyInterval=option(options.historyRefresh,300,5,900),
        -- Background pacing: a lane scan that nobody asked for (no turn, no journal change) takes one page, then rests
        -- restGap seconds or restFactor times what the page cost, so it spreads over seconds instead of every frame.
        -- A demand (see demand) lifts the pacing until its scan ends.
        pace=options.pace==true,cpuNow=options.cpuNow or os.clock,restGap=type(options.restGap)=='number' and options.restGap or 0.05,
        restFactor=type(options.restFactor)=='number' and options.restFactor or 30,
        -- With journal-change events wired (eventDriven, set by init.lua once the hook is registered) a resting lane
        -- whose cache saw no change event is re-stamped instead of rescanned, and fully rescanned only every
        -- activeVerify / historyVerify seconds. History also skips a rescan whose first page shows the same quest count.
        eventDriven=false,changeSeq=0,activeVerify=option(options.activeVerify,120,15,3600),
        historyVerify=option(options.historyVerify,3600,60,86400),newEncoder=options.newEncoder,
        encodeRow=options.encodeRow},Collector)
    self:reset(); return self
end
function Collector:reset()
    self.lanes={active={},history={}}; self.generation=nil; self.worldToken=nil; self.tick=0; self.lastNow=nil
    self.restUntil=nil; self.encoding=nil
end
function Collector:check(context)
    if not plain(context) or not integer(context.generation,0,9007199254740991)
        or (context.worldToken~=nil and not token(context.worldToken)) then return nil end
    if self.currentGeneration then local ok,value=pcall(self.currentGeneration); if not ok or value~=context.generation then return nil end end
    if self.currentWorldToken then local ok,value=pcall(self.currentWorldToken); if not ok or not token(value) or value~=context.worldToken then return nil end end
    local ok,value=pcall(self.adapter.isReady); if not ok or value~=true then return nil end
    ok,value=pcall(self.now)
    if not ok or type(value)~='number' or value~=value or value<0 or value>1e12 or (self.lastNow and value<self.lastNow) then return nil end
    self.lastNow=value; return value
end
local function newJob(now,seq)
    return {started=now,seq=seq,cursor=1,total=nil,rootsDone=false,quests={},queue={},head=1,seen={},rootCount=0,
        nodeCount=0,objectiveCount=0,bytes=0,omitted=0,complete=true,unstable=false}
end
local function mark(job,quest)
    job.complete=false; job.omitted=job.omitted+1; if quest then quest.objectivesComplete=false end
end
local function validRow(row)
    return plain(row) and hash(row.id)==row.id and text(row.nativeId,160)==row.nativeId
        and (row.state=='active' or row.state=='succeeded' or row.state=='failed')
end
function Collector:step(lane,now)
    local target=self.lanes[lane]; local job=target.job
    if not job then job=newJob(now,self.changeSeq); target.job=job end
    local readingRoots=not job.rootsDone
    local task=not readingRoots and job.queue[job.head] or nil
    if not readingRoots and not task then
        -- The scan's work list and visited set (one task per journal node: about 1 MB of Lua tables for 200 quests and
        -- 2,600 objectives) are never read again once it is done; the finished job stays as the lane's cache until the next.
        job.queue,job.seen=nil,nil
        -- Each finished scan is a revision (docs/PERFORMANCE_NATIVE_PLAN.md item 1b): the bridge keeps its rows
        -- from knowledge-<lane>.json, and a turn names the revision and the row ids it uses.
        self.revision=(self.revision or 0)+1; job.revision=self.revision
        -- Jobs this history scan finds finished that the previous one did not (Johnny speaks up, init.lua; nil leaves it as before).
        -- The first scan of a world is only a baseline, and a burst of more than four is a rebuilt list, not news.
        if lane=='history' and type(self.onFinished)=='function' and target.cache then
            local before,done=target.cache.quests,{}
            for id,quest in pairs(job.quests) do
                local old=before[id]
                if (quest.state=='succeeded' or quest.state=='failed') and (not old or old.state~=quest.state) then done[#done+1]=quest end
            end
            if #done>0 and #done<=4 then pcall(self.onFinished,done) end
        end
        target.cache=job; target.cache.finished=now; target.job=nil; target.rush=nil
        job.scanned=job.started; job.rowText,job.rowState,job.rowCount,job.partial=nil,nil,nil,nil -- see capturePart
        target.next=now+(lane=='active' and self.activeInterval or self.historyInterval)
        -- The finished history rows are encoded a few per frame from here on, so the first turn that needs this revision
        -- writes a ready string (mod/knowledge-parts.lua). The active lane is small and changes often: not worth it.
        if lane=='history' and self.newEncoder then
            local okEncoder,encoder=pcall(self.newEncoder,job.quests)
            if okEncoder and encoder then self.encoding={cache=job,encoder=encoder} end
        end
        return
    end
    local ok,page
    job.pages=(job.pages or 0)+1
    if readingRoots then ok,page=pcall(self.adapter.roots,lane,job.cursor,self.pageSize)
    else ok,page=pcall(self.adapter.children,copy(task),self.pageSize) end
    local quest=task and job.quests[task.quest] or nil
    -- History, first page: the same quest count as the last scan means nothing finished or failed since (a quest
    -- reaches this lane only by changing state), so the scan ends here and the cache is re-stamped as current.
    if readingRoots and lane=='history' and job.cursor==1 and ok and plain(page) and integer(page.total,0,100000) then
        local cache=target.cache
        if cache and cache.total==page.total and not cache.unstable and not cache.failed
            and now-(cache.scanned or cache.started)<self.historyVerify then
            cache.started,cache.finished,cache.seq=now,now,job.seq
            target.job,target.rush=nil,nil; target.next=now+self.historyInterval
            self.skipped=(self.skipped or 0)+1
            return
        end
    end
    if not ok or not plain(page) or not plain(page.rows) or #page.rows>self.pageSize then
        job.failed=true; mark(job,quest)
        if readingRoots then job.rootsDone=true else job.head=job.head+1 end
        return
    end
    if page.unavailable then job.failed=true; mark(job,quest) end
    if integer(page.omitted,1,self.pageSize) then for _=1,page.omitted do mark(job,quest) end end
    if integer(page.total,0,100000) then
        local previous
        if readingRoots then previous=job.total else previous=task.total end
        if previous and previous~=page.total then job.unstable=true; mark(job,quest) end
        if readingRoots then job.total=page.total else task.total=page.total end
    else job.failed=true; mark(job,quest) end
    if quest and (page.questState=='active' or page.questState=='succeeded' or page.questState=='failed') then quest.state=page.questState end
    for _,row in ipairs(page.rows) do
        if not validRow(row) then mark(job,quest)
        elseif readingRoots then
            if row.kind~='quest' or not text(row.title,320) then mark(job)
            elseif not job.quests[row.id] then
                local cost=#row.title+#row.nativeId+256+(type(row.nativePath)=='string' and #row.nativePath or 0)
                if job.rootCount>=self.maxQuests or job.bytes+cost>self.maxBytes then mark(job)
                else
                    local q={id=row.id,nativeId=row.nativeId,title=row.title,state=row.state,
                        observedAtMs=now*1000,objectives={},objectivesComplete=true,lane=lane}
                    if type(row.questType)=='string' and #row.questType<=32 and row.questType:match('^%a+$') then q.questType=row.questType end
                    if integer(row.gameTimeSeconds,0,4294967295) then q.gameTimeSeconds=row.gameTimeSeconds end
                    if text(row.nativePath,1024) then q.nativePath=row.nativePath end
                    job.quests[row.id]=q; job.rootCount=job.rootCount+1; job.bytes=job.bytes+cost
                    job.queue[#job.queue+1]={id=row.id,quest=row.id,cursor=1,depth=0,path={row.nativeId}}
                    job.objectiveTail=#job.queue -- a quest or phase task can still add objectives (see settled)
                    job.seen[row.id]=true; job.nodeCount=job.nodeCount+1
                end
            else job.unstable=true; mark(job) end
        elseif not job.seen[row.id] then
            job.seen[row.id]=true
            local relative=copy(task.path); relative[#relative+1]=row.nativeId
            local pathSize=0; for _,part in ipairs(relative) do pathSize=pathSize+#part+3 end
            if pathSize>1024 then mark(job,quest)
            else
                if row.kind=='objective' then
                    local label=text(row.text,1200); local cost=(label and #label or 0)+pathSize+256
                    if not label or #quest.objectives>=self.maxPerQuest or job.objectiveCount>=self.maxObjectives or job.bytes+cost>self.maxBytes then mark(job,quest)
                    else
                        local item={id=row.id,nativeId=row.nativeId,questRelativePath=relative,text=label,state=row.state,observedAtMs=now*1000}
                        if type(row.optional)=='boolean' then item.optional=row.optional end
                        quest.objectives[#quest.objectives+1]=item; job.objectiveCount=job.objectiveCount+1; job.bytes=job.bytes+cost
                    end
                elseif row.kind~='phase' then mark(job,quest) end
                if row.kind=='phase' or row.kind=='objective' then
                    if task.depth+1>=self.maxDepth or job.nodeCount>=self.maxNodes then mark(job,quest)
                    else
                        job.queue[#job.queue+1]={id=row.id,quest=task.quest,cursor=1,depth=task.depth+1,path=relative}
                        if row.kind=='phase' then job.objectiveTail=#job.queue end
                        job.nodeCount=job.nodeCount+1
                    end
                end
            end
        else mark(job,quest) end
    end
    local cursor=readingRoots and job.cursor or task.cursor
    local cap=readingRoots and self.maxQuests*2 or self.maxNodes
    if page.done==true then
        if readingRoots then job.rootsDone=true else job.head=job.head+1 end
    elseif not integer(page.next,cursor+1,100001) or page.next>cap then
        mark(job,quest); if readingRoots then job.rootsDone=true else job.head=job.head+1 end
    elseif readingRoots then job.cursor=page.next else task.cursor=page.next end
end
local function isDue(self,lane,now)
    local value=self.lanes[lane]; return value.job or not value.next or now>=value.next
end
-- The history lane gets every fourth frame when both are due, as before; the active lane otherwise.
local function pick(self,now,tick)
    if tick%4==0 and isDue(self,'history',now) then return 'history' end
    if isDue(self,'active',now) then return 'active' end
    if isDue(self,'history',now) then return 'history' end
    return nil
end
-- Event-driven: a lane whose rest is over, whose cache saw no change event since its scan began and whose last real
-- scan is younger than its verify age is re-stamped as current (no native call). Active rows carry their own
-- observation time, which the bridge ages at 15 s, so they are re-stamped too and the lane takes a new revision.
local function revalidate(self,lane,now)
    local target=self.lanes[lane]; local cache=target.cache
    if target.job or not target.next or now<target.next or target.rush or not cache then return end
    if not self.eventDriven or cache.seq~=self.changeSeq or cache.failed then return end
    if now-(cache.scanned or cache.started)>=(lane=='active' and self.activeVerify or self.historyVerify) then return end
    cache.started,cache.finished=now,now
    if lane=='active' then
        local stamp=now*1000
        for _,row in pairs(cache.quests) do
            row.observedAtMs=stamp
            for _,objective in ipairs(row.objectives) do objective.observedAtMs=stamp end
        end
        self.revision=(self.revision or 0)+1; cache.revision=self.revision
    end
    target.next=now+(lane=='active' and self.activeInterval or self.historyInterval)
end
-- The journal changed (JournalNotificationQueue.OnJournalUpdate): resting caches can no longer be re-stamped.
function Collector:markChanged() self.changeSeq=self.changeSeq+1 end
function Collector:scanning(lane) local value=self.lanes[lane]; return value~=nil and value.job~=nil end
-- A history scan still under way with no usable cache (the first after a load takes minutes when paced) is named by
-- a provisional revision of the history part (capturePart) instead of copied inline: a turn soon after a load used to
-- copy and JSON-encode every row on its own frame (630 KB for 208 quests, a 30-80 ms hitch). Its rows are encoded as
-- capture() copies them (objectivesComplete false), one per resting frame once no quest or phase task is left to add
-- objectives (pumpPartial), so a turn finds them ready. encodeRow is set by init.lua; without it rows stay inline.
local function rowFresh(job,id,quest)
    return job.rowText[id]~=nil and job.rowState[id]==quest.state and job.rowCount[id]==#quest.objectives
end
local function encodeRow(self,job,id,quest)
    local value={}; for k,v in pairs(quest) do value[k]=v end; value.objectivesComplete=false
    local ok,text=pcall(self.encodeRow,value)
    if not ok or type(text)~='string' then job.partialFailed=true; return false end
    job.rowText[id],job.rowState[id],job.rowCount[id]='"'..id..'":'..text,quest.state,#quest.objectives
    job.encodeSerial=(job.encodeSerial or 0)+1
    return true
end
local function rowTables(job) job.rowText=job.rowText or {}; job.rowState=job.rowState or {}; job.rowCount=job.rowCount or {} end
function Collector:pumpPartial()
    local target=self.lanes.history; local job=target.job
    if not job or type(self.encodeRow)~='function' or job.partialFailed or not job.rootsDone
        or job.head<=(job.objectiveTail or 0) or job.cleanAt==job.pages then return end
    local cache=target.cache
    if cache and self.lastNow and self.lastNow-cache.started<=self.historyAge then return end -- the cache travels instead
    rowTables(job)
    local id=job.rowCursor
    for _=1,8 do
        local quest; id,quest=next(job.quests,id)
        if id==nil then
            if job.passClean then job.cleanAt=job.pages end -- nothing stale until the next page
            job.rowCursor,job.passClean=nil,true; return
        end
        if not rowFresh(job,id,quest) then job.rowCursor,job.passClean=id,false; encodeRow(self,job,id,quest); return end
    end
    job.rowCursor=id
end
-- The provisional part for a scanning history job: stale rows are encoded now, and the revision is kept while no row changed.
local function partialPart(self,job)
    if job.partialFailed then return nil end
    rowTables(job)
    for id,quest in pairs(job.quests) do
        if not rowFresh(job,id,quest) and not encodeRow(self,job,id,quest) then return nil end
    end
    local held=job.partial
    if held and held.serial==job.encodeSerial then return held end
    local pieces={}; for _,text in pairs(job.rowText) do pieces[#pieces+1]=text end
    self.revision=(self.revision or 0)+1
    held={revision=self.revision,serial=job.encodeSerial,encoded='{"quests":{'..table.concat(pieces,',')..'}}'}
    job.partial=held
    return held
end
-- Encodes the finished history rows a few per frame (see step).
function Collector:pump()
    local job=self.encoding; if not job then self:pumpPartial(); return end
    if self.lanes.history.cache~=job.cache then self.encoding=nil; return end
    local ok=pcall(job.encoder.step,job.encoder,2)
    if not ok or job.encoder.failed then self.encoding=nil; return end
    if job.encoder.done then job.cache.encoded='{"quests":'..job.encoder.text..'}'; self.encoding=nil end
end
function Collector:paced(lane)
    if not self.pace or self.lanes[lane].rush or not self.restUntil then return false end
    local ok,clock=pcall(self.cpuNow)
    return ok and type(clock)=='number' and clock<self.restUntil
end
function Collector:update(context)
    -- Resting, or paced between background pages: no native call at all (capture() re-checks the world itself).
    if plain(context) and self.generation~=nil and self.generation==context.generation and self.worldToken==context.worldToken then
        local ok,now=pcall(self.now)
        if ok and type(now)=='number' and self.lastNow and now>=self.lastNow then
            revalidate(self,'active',now); revalidate(self,'history',now)
            local lane=pick(self,now,self.tick+1)
            if not lane or self:paced(lane) then self.tick=self.tick+1; self:pump(); return {status='collecting'} end
        end
    end
    local now=self:check(context)
    if not now then self:reset(); return {status='unavailable'} end
    if self.generation~=context.generation or self.worldToken~=context.worldToken then
        self:reset(); self.generation=context.generation; self.worldToken=context.worldToken; self.lastNow=now
    end
    self.tick=self.tick+1
    local lane=pick(self,now,self.tick)
    if lane then
        local paced=self.pace and not self.lanes[lane].rush
        local okStart,start=false,nil
        if paced then okStart,start=pcall(self.cpuNow) end
        self:step(lane,now)
        if paced and okStart and type(start)=='number' then
            local okEnd,finish=pcall(self.cpuNow)
            if okEnd and type(finish)=='number' then self.restUntil=finish+math.max(self.restGap,(finish-start)*self.restFactor) end
        end
    else self:pump() end
    if not self:check(context) then self:reset(); return {status='unavailable'} end
    return {status='collecting',lane=lane}
end
-- A turn is coming (or the journal just changed): each named lane ('active', 'history') scans on the next update
-- unless it is scanning already or its cache began less than minAge seconds ago.
function Collector:demand(lanes,minAge)
    local ok,now=pcall(self.now)
    for _,lane in ipairs(lanes or {'active'}) do
        local target=self.lanes[lane]
        if target and target.job then target.rush=true -- already scanning: finish at full speed
        elseif target and (not target.cache or not ok or type(now)~='number'
            or now-target.cache.started>=(minAge or 2)) then target.next=nil; target.rush=true end
    end
end
function Collector:capture(context)
    local now=self:check(context)
    if not now or self.generation~=context.generation or self.worldToken~=context.worldToken then self:reset(); return {version=1,status='unavailable'} end
    local output={version=1,status='ready',generation=self.generation,worldToken=self.worldToken,
        capturedAtMs=now*1000,coverage={},quests={}}
    local merged={}
    for _,lane in ipairs({'history','active'}) do
        local target=self.lanes[lane]; local cache=target.cache; local maxAge=lane=='active' and self.activeAge or self.historyAge
        local scanning=false
        if target.job and (not cache or now-cache.started>maxAge) then cache=target.job; scanning=true end
        local coverage={status='pending'}; output.coverage[lane]=coverage
        if cache then
            local age=now-cache.started
            coverage.ageSeconds=age; coverage.windowSeconds=(cache.finished or now)-cache.started; coverage.scanning=scanning
            coverage.observed=cache.rootCount; coverage.total=cache.total; coverage.omitted=cache.omitted; coverage.unstable=cache.unstable
            if age>maxAge then coverage.status='expired'
            else
                coverage.status=cache.complete and not scanning and 'complete' or 'partial'
                for id,row in pairs(cache.quests) do
                    if row.state=='active' and now-row.observedAtMs/1000>self.activeAge then
                        coverage.status='partial'; coverage.omitted=coverage.omitted+1
                    elseif not merged[id] or row.observedAtMs>=merged[id].observedAtMs then
                        merged[id]=copy(row); if scanning then merged[id].objectivesComplete=false end
                    end
                end
            end
        end
    end
    local ids={}; for id in pairs(merged) do ids[#ids+1]=id end; table.sort(ids)
    for _,id in ipairs(ids) do output.quests[#output.quests+1]=merged[id] end
    local ok,value=pcall(self.adapter.tracked)
    if ok and plain(value) and (value.status=='untracked' or (value.status=='known' and hash(value.questId)==value.questId
        and (value.objectiveId==nil or hash(value.objectiveId)==value.objectiveId))) then output.tracked=copy(value)
    else output.tracked={status='unknown'} end
    if not self:check(context) then self:reset(); return {version=1,status='unavailable'} end
    return output
end
-- capture() without copying finished scans: their rows stay in the collector and the result names them,
-- lanes[lane]={revision=n,ids={...}}, with one part per such lane ({name=lane,revision,data={quests=rows}}, rows keyed by
-- id; the caller only encodes them). A lane still in its first scan (or past its age) is copied into quests as before,
-- except history rows when encodeRow is set: those are named by a provisional history part (see pumpPartial).
-- The bridge (bridge/knowledge-parts.mjs) rebuilds exactly the snapshot capture() returns.
function Collector:capturePart(context)
    local now=self:check(context)
    if not now or self.generation~=context.generation or self.worldToken~=context.worldToken then self:reset(); return {version=1,status='unavailable'} end
    local output={version=1,status='ready',generation=self.generation,worldToken=self.worldToken,
        capturedAtMs=now*1000,coverage={},quests={}}
    local merged,from,parts={},{},{}
    for _,lane in ipairs({'history','active'}) do
        local target=self.lanes[lane]; local cache=target.cache; local maxAge=lane=='active' and self.activeAge or self.historyAge
        local scanning=false
        if target.job and (not cache or now-cache.started>maxAge) then cache=target.job; scanning=true end
        local coverage={status='pending'}; output.coverage[lane]=coverage
        if cache then
            local age=now-cache.started
            coverage.ageSeconds=age; coverage.windowSeconds=(cache.finished or now)-cache.started; coverage.scanning=scanning
            coverage.observed=cache.rootCount; coverage.total=cache.total; coverage.omitted=cache.omitted; coverage.unstable=cache.unstable
            if age>maxAge then coverage.status='expired'
            else
                coverage.status=cache.complete and not scanning and 'complete' or 'partial'
                for id,row in pairs(cache.quests) do
                    if row.state=='active' and now-row.observedAtMs/1000>self.activeAge then
                        coverage.status='partial'; coverage.omitted=coverage.omitted+1
                    elseif not merged[id] or row.observedAtMs>=merged[id].observedAtMs then
                        merged[id]=row; from[id]={lane=lane,cache=cache,scanning=scanning}
                    end
                end
            end
        end
    end
    local ids={}; for id in pairs(merged) do ids[#ids+1]=id end; table.sort(ids)
    local lanes={}
    -- History rows of a scan under way travel as a provisional part when encodeRow is set (see pumpPartial).
    local job,partial=self.lanes.history.job,nil
    if job and type(self.encodeRow)=='function' then
        for _,source in pairs(from) do
            if source.cache==job then partial=partialPart(self,job); break end
        end
    end
    for _,id in ipairs(ids) do
        local source=from[id]
        if partial and source.cache==job then
            local lane=lanes.history
            if not lane then
                lane={revision=partial.revision,ids={}}; lanes.history=lane
                -- strict: the encoded rows or nothing (the job's own rows may still say objectivesComplete true).
                parts[#parts+1]={name='history',revision=partial.revision,generation=self.generation,
                    worldToken=self.worldToken,data={},encoded=partial.encoded,strict=true}
            end
            lane.ids[#lane.ids+1]=id
        elseif source.scanning or not source.cache.revision then
            local row=copy(merged[id]); if source.scanning then row.objectivesComplete=false end
            output.quests[#output.quests+1]=row
        else
            local lane=lanes[source.lane]
            if not lane then
                lane={revision=source.cache.revision,ids={}}; lanes[source.lane]=lane
                parts[#parts+1]={name=source.lane,revision=source.cache.revision,generation=self.generation,
                    worldToken=self.worldToken,data={quests=source.cache.quests},encoded=source.cache.encoded}
            end
            lane.ids[#lane.ids+1]=id
        end
    end
    if next(lanes) then output.lanes=lanes end
    local ok,value=pcall(self.adapter.tracked)
    if ok and plain(value) and (value.status=='untracked' or (value.status=='known' and hash(value.questId)==value.questId
        and (value.objectiveId==nil or hash(value.objectiveId)==value.objectiveId))) then output.tracked=copy(value)
    else output.tracked={status='unknown'} end
    if not self:check(context) then self:reset(); return {version=1,status='unavailable'} end
    return output,parts
end
M.nativeAdapter={isReady=ready,roots=roots,children=children,tracked=tracked}
return M
