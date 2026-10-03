# Initial companion appearances

Appearance selection belongs to the mod's newly created managed copy. The
spawn specification carries the selected template appearance before attachment,
so the native facial graph is initialized for that outfit. Changing appearance
after attachment can rebuild the facial components outside the original spawn
ownership boundary.

`companion-records.lua` routes by the selected model record. A conversation
profile assigned to a different model does not replace that model's appearance.
Fast-travel recreation uses the same routing.

## Kerry's clothed appearance

The installed 2.31 entity template
`base\quest\tertiary_characters\kerry.ent` defaults to
`kerry_eurodyne__q203__shower`. A dynamic spawn using `Character.Kerry` without
an explicit appearance therefore selects his shower outfit.

The template explicitly maps
`kerry_eurodyne_kerry_eurodyne_old_no_sunglasses` to the
`kerry_eurodyne_old_no_sunglasses` definition in
`base\characters\appearances\main_npc\kerry_eurodyne.app`. That definition
contains enabled native pants and shirt components. The mod supplies the
template mapping name in Kerry's initial `DynamicEntitySpec.appearanceName`;
it does not rewrite the story record, template, clothing meshes or shared
equipment data. Existing copies need to be dismissed and invited again to
receive this initial selection.

On October 3, 2026, both resources were freshly extracted and serialized with
WolvenKit 9.0.1. A directory scan of all 63 installed archives found one Kerry
entity-template entry and two appearance-resource entries, in the base and
Phantom Liberty archives. Both decoded appearance resources contain an
identical selected definition. All three extracted payload SHA-1s match their
archive entries.

| Resource | SHA-256 |
| --- | --- |
| Kerry entity template | `bb7853d6331abf1bfc1e3d048cadcde737ffe98bf53daa2892152ecfe5aa8f6f` |
| Base appearance resource | `b9de6248284601001f875f51881acd627697c315cfcb3b3eafdbf74f17bd5f2e` |
| Phantom Liberty appearance resource | `c663c772d8cccfdfaaf5c8d26a1df6fe1e0087c7f1d4fec066a6d20f62091173` |

The executable Lua regression reproduces the missing initial appearance in
three old-code cases: ordinary invitation, model-browser copies and
fast-travel recreation. All three pass with the correction. The focused
records/behavior suite passes 34 checks, including Johnny's private combat
record and physical visibility handling. These checks cover selection and
lifecycle; Kerry's rendered outfit still requires a fresh in-game invitation.

## Johnny's physical copy

Johnny uses his native `silverhand_riot__not_blendable` appearance at creation.
His private companion record supplies the tested combat equipment and abilities;
the attachment preparation disables the phantom controller on that managed
copy. Story apparitions and their native appearance data remain separate.
