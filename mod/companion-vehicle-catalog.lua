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
-- Alt Cunningham is a digital ghost: she has no car of her own and never takes a wheel. She rides as a passenger in V's car
-- (or in a seat of a party car another companion drives) and never summons, drives or is chosen to drive an overflow car.
-- Model identity decides, like the preferences above, so a copy of her model keeps this under any chat profile.
M.passengerOnly = {['alt-cunningham']=true}
local function key(entry) return entry.key,modelKeys[entry.record] end
function M.drives(entry)
    local direct,model=key(entry or {})
    return not (M.passengerOnly[direct] or M.passengerOnly[model])
end
-- The car for an overflow trip and the person who drives it: only a companion who drives is ever chosen. nil person: nobody
-- in the queue can drive (a passenger-only companion waits for a seat; the caller creates no car).
function M.choose(people)
    local first
    for _,person in ipairs(people) do
        if M.drives(person.entry) then
            first=first or person
            -- Model identity owns the car preference, not an assigned chat profile.
            local choice=M.preferred[person.entry.key] or M.preferred[modelKeys[person.entry.record]]
            if choice then return choice,person end
        end
    end
    return M.fallback,first
end
return M
