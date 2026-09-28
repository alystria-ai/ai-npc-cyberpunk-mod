import {readFileSync} from 'node:fs';

const behavior = readFileSync(new URL('../mod/companion-behavior.lua', import.meta.url), 'utf8');
const placement = readFileSync(new URL('../mod/companion-placement.lua', import.meta.url), 'utf8');
const appearance = readFileSync(new URL('../mod/companion-appearance.lua', import.meta.url), 'utf8');
export const companionModules = `
  dofile=function(file)
    if file=='companion-behavior.lua' then return (function() ${behavior} end)() end
    if file=='companion-placement.lua' then return (function() ${placement} end)() end
    if file=='companion-appearance.lua' then return (function() ${appearance} end)() end
    error('Unexpected module '..file)
  end
`;

// An open, flat navmesh. Individual placement cases override the native adapter.
export const flatNavigation = `
  Game.GetAINavigationSystem=function() return {
    FindPointInSphereForCharacter=function(_,position) return {status='OK',point=position} end,
    CalculatePathForCharacter=function(_,origin,destination)
      return {path={origin,destination}, CalculateLength=function()
        return math.sqrt((destination.x-origin.x)^2+(destination.y-origin.y)^2+(destination.z-origin.z)^2)
      end}
    end
  } end
`;
