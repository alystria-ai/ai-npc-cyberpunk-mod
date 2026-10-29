-- Source-backed model/appearance pairs; these are NEW nonpersistent copies.
-- Evidence and exclusions: docs/COMPANION_VEHICLES_DESIGN.md.
local M = {}
M.preferred = {
    ['panam-palmer'] = {record='Vehicle.v_standard3_thorton_mackinaw_ncu_player',
        appearance='thorton_mackinaw_nomad_panams_truck', name="Panam's truck"},
    ['claire-russell'] = {record='Vehicle.v_standard3_thorton_mackinaw_ncu_player',
        appearance='thorton_mackinaw_nomad_deathrace_01', name="Claire's truck"},
    ['judy-alvarez'] = {record='Vehicle.v_standard25_villefort_columbus_player',
        appearance='villefort_columbus__basic_judys_van', name="Judy's van"},
    ['kerry-eurodyne'] = {record='Vehicle.v_sport1_rayfield_aerondight_player',
        appearance='rayfield_aerondight__basic_kerry', name="Kerry's Guinevere"},
    ['johnny-silverhand'] = {record='Vehicle.v_sport2_porsche_911turbo_player',
        appearance='porsche_911turbo__basic_johnny', name="Johnny's Porsche"},
    ['rogue-amendiares'] = {record='Vehicle.v_sport2_quadra_type66_player',
        appearance='quadra_type66__basic_rogue_01', name="Rogue's Type-66"},
}
-- The Mackinaw seat exception is enforced by the native adapter for both
-- appearances. River's quest-template truck is not a generic car fallback.
local modelKeys={['Character.Panam']='panam-palmer',['Character.Claire']='claire-russell',
    ['Character.Judy']='judy-alvarez',['Character.Kerry']='kerry-eurodyne',
    ['Character.Silverhand']='johnny-silverhand',['Character.Rogue']='rogue-amendiares',
    ['Character.Alt']='alt-cunningham'}
M.fallback = {record='Vehicle.v_standard2_archer_hella_player',name='Hella'}
-- Alt Cunningham has a real body (our copy is an ordinary spawned character): she drives like anyone else. She has no car record of
-- her own, so she gets the fallback car, as anyone without a personal car does.
-- The car for an overflow trip and the person who drives it: the first in the queue, or the first with a personal car.
-- isBlocked(profileKey) is optional (a story pack can take a character's own car away for a while, mod/bonds.lua vehicleBlocked): a blocked person's
-- personal car is not chosen, the next person with one is, or the fallback car with the first in the queue. Asked only for a person who has a personal car.
function M.choose(people,isBlocked)
    local first
    for _,person in ipairs(people) do
        first=first or person
        -- Model identity owns the car preference, not an assigned chat profile.
        local owner=M.preferred[person.entry.key] and person.entry.key or modelKeys[person.entry.record]
        local choice=M.preferred[owner]
        -- The block follows whose car it is (the profile key of the catalogue entry), not the profile the copy talks as.
        if choice and isBlocked then
            local ok,blocked=pcall(isBlocked,owner)
            if ok and blocked==true then choice=nil end
        end
        if choice then return choice,person end
    end
    return M.fallback,first
end
return M
