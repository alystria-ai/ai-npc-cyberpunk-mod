-- World-space geometry shared by planning and tests. Camera yaw is not an input.
local M = {}
M.slots = {{-1.5,0.05},{1.5,0.05},{-2.5,-1.0},{2.5,-1.0},
    {-1.2,-2.3},{1.2,-2.3},{-2.5,-3.5},{2.5,-3.5}}
-- The party has no size limit. The eight authored places above keep their exact
-- geometry; a ninth and later member continues the formation in staggered rows
-- of two (inner and outer files alternating), 1.2 m further back each row.
-- Place N is generated and cached on first use, so M.slots[n] works for any n >= 1.
setmetatable(M.slots,{__index=function(slots,n)
    if type(n)~='number' or n<9 or n~=math.floor(n) then return nil end
    local row=math.ceil(n/2)
    local lateral=(row%2==1) and 1.5 or 2.5
    local place={(n%2==1) and -lateral or lateral,-3.5-1.2*(row-4)}
    rawset(slots,n,place)
    return place
end})

function M.copy(p) return {x=p.x,y=p.y,z=p.z or 0,w=p.w or 1} end
function M.distance(a,b) return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2+((a.z or 0)-(b.z or 0))^2) end
function M.ground(a,b) return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2) end
function M.unit(x,y)
    local length=math.sqrt(x*x+y*y)
    if length < 0.0001 then return {x=0,y=1} end
    return {x=x/length,y=y/length}
end
function M.angle(a,b)
    local aa,bb=M.unit(a.x,a.y),M.unit(b.x,b.y)
    return math.deg(math.acos(math.max(-1,math.min(1,aa.x*bb.x+aa.y*bb.y))))
end
function M.bearing(a,b) return M.unit(b.x-a.x,b.y-a.y) end
function M.offset(origin,direction,lateral,forward)
    return {x=origin.x-direction.y*lateral+direction.x*forward,
        y=origin.y+direction.x*lateral+direction.y*forward,z=origin.z,w=1}
end
function M.clear(point,player,others,id,margin,shape)
    local radius=shape and shape.radius or .35
    if M.ground(point,player) < math.max(margin or 1.0,radius+.5) then return false end
    for _,other in ipairs(others or {}) do
        local separation=math.max(.85,radius+(other.clearance and other.clearance.radius or .35)+.1)
        local vertical=point.z<other.position.z+(other.clearance and other.clearance.height or 2.1)
            and other.position.z<point.z+(shape and shape.height or 2.1)
        if other.id~=id and vertical and M.ground(point,other.position)<separation then return false end
    end
    return true
end
function M.comfortable(point,frame,slot,others,id,shape)
    local spec=M.slots[slot]
    local delta={x=point.x-frame.position.x,y=point.y-frame.position.y}
    local side=-frame.direction.y*delta.x+frame.direction.x*delta.y
    local along=frame.direction.x*delta.x+frame.direction.y*delta.y
    return math.abs(point.z-frame.position.z)<1.0
        and side*spec[1]>0 and math.abs(side)>0.65
        and math.abs(side)<math.abs(spec[1])+1.35
        and along>spec[2]-1.4 and along<spec[2]+1.6
        and M.clear(point,frame.position,others,id,nil,shape)
end
-- How far from V still counts as the group. The authored places keep their
-- radii; later rows reach as far back as their place does.
function M.nearGroupReach(slot)
    if slot<=2 then return 3.5 end
    if slot<=8 then return 5.5 end
    local spec=M.slots[slot]
    return math.sqrt(spec[1]^2+spec[2]^2)+1.2
end
function M.nearGroup(point,frame,slot,others,id,shape)
    -- The end of a stop animation may overshoot the preferred side region.
    -- A safe actual stance is better than a backwards correction of one metre.
    return math.abs(point.z-frame.position.z)<1.0
        and M.ground(point,frame.position)<M.nearGroupReach(slot)
        and M.clear(point,frame.position,others,id,nil,shape)
end
function M.candidates(frame,slot,origin)
    local spec=M.slots[slot]
    local anchor=origin or frame.stopAnchor or frame.position
    local result={}
    local sign=spec[1]<0 and -1 or 1
    for _,offset in ipairs({{spec[1],spec[2]}, {spec[1]+sign*0.45,spec[2]+0.35},
        {sign*math.max(1.05,math.abs(spec[1])-0.45),spec[2]-0.55},
        {sign*1.15,spec[2]-1.25}}) do
        result[#result+1]=M.offset(anchor,frame.direction,offset[1],offset[2])
    end
    return result
end
function M.segmentDistance(point,a,b)
    local x,y=b.x-a.x,b.y-a.y
    local length=x*x+y*y
    local t=length>0 and math.max(0,math.min(1,((point.x-a.x)*x+(point.y-a.y)*y)/length)) or 0
    return M.ground(point,{x=a.x+x*t,y=a.y+y*t})
end
return M
