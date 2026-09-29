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
local function state(journal,entry)
    local value=journal:GetEntryState(entry)
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
        activeAge=option(options.activeMaxAge,5,1,15),historyAge=option(options.historyMaxAge,180,15,300),
        activeInterval=option(options.activeRefresh,2,1,10),historyInterval=option(options.historyRefresh,30,5,120)},Collector)
    self:reset(); return self
end
function Collector:reset()
    self.lanes={active={},history={}}; self.generation=nil; self.worldToken=nil; self.tick=0; self.lastNow=nil
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
local function newJob(now)
    return {started=now,cursor=1,total=nil,rootsDone=false,quests={},queue={},head=1,seen={},rootCount=0,
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
    if not job then job=newJob(now); target.job=job end
    local readingRoots=not job.rootsDone
    local task=not readingRoots and job.queue[job.head] or nil
    if not readingRoots and not task then
        target.cache=job; target.cache.finished=now; target.job=nil
        target.next=now+(lane=='active' and self.activeInterval or self.historyInterval); return
    end
    local ok,page
    if readingRoots then ok,page=pcall(self.adapter.roots,lane,job.cursor,self.pageSize)
    else ok,page=pcall(self.adapter.children,copy(task),self.pageSize) end
    local quest=task and job.quests[task.quest] or nil
    if not ok or not plain(page) or not plain(page.rows) or #page.rows>self.pageSize then
        mark(job,quest)
        if readingRoots then job.rootsDone=true else job.head=job.head+1 end
        return
    end
    if page.unavailable then mark(job,quest) end
    if integer(page.omitted,1,self.pageSize) then for _=1,page.omitted do mark(job,quest) end end
    if integer(page.total,0,100000) then
        local previous
        if readingRoots then previous=job.total else previous=task.total end
        if previous and previous~=page.total then job.unstable=true; mark(job,quest) end
        if readingRoots then job.total=page.total else task.total=page.total end
    else mark(job,quest) end
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
                    if text(row.nativePath,1024) then q.nativePath=row.nativePath end
                    job.quests[row.id]=q; job.rootCount=job.rootCount+1; job.bytes=job.bytes+cost
                    job.queue[#job.queue+1]={id=row.id,quest=row.id,cursor=1,depth=0,path={row.nativeId}}
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
function Collector:update(context)
    local now=self:check(context)
    if not now then self:reset(); return {status='unavailable'} end
    if self.generation~=context.generation or self.worldToken~=context.worldToken then
        self:reset(); self.generation=context.generation; self.worldToken=context.worldToken; self.lastNow=now
    end
    self.tick=self.tick+1
    local function due(lane) local value=self.lanes[lane]; return value.job or not value.next or now>=value.next end
    local lane=(self.tick%4==0 and due('history')) and 'history' or (due('active') and 'active' or (due('history') and 'history' or nil))
    if lane then self:step(lane,now) end
    if not self:check(context) then self:reset(); return {status='unavailable'} end
    return {status='collecting',lane=lane}
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
M.nativeAdapter={isReady=ready,roots=roots,children=children,tracked=tracked}
return M
