// The atlas of one phone chat picture (docs/PHONE_IMAGES.md). Each picture is its own texture, so each gets its own .inkatlas with one part that
// covers the whole texture; the part is named like the picture's key. The shape is the one a working mod atlas has when WolvenKit writes it
// back as JSON: three identical slots (the game picks one by screen size), the root texture empty, one full-texture part per slot.
// Used by scripts/Build-PhoneImages.ps1 (the JSON is turned into an .inkatlas by WolvenKit's `convert deserialize`).
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join, win32} from 'node:path';
import {fileURLToPath} from 'node:url';

export const KEY_PATTERN = /^[a-z0-9_]{1,48}$/;

const path = value => ({$type: 'ResourcePath', $storage: 'string', $value: value});
const emptyTexture = () => ({DepotPath: {$type: 'ResourcePath', $storage: 'uint64', $value: '0'}, Flags: 'Soft'});

// The depot path of a picture's atlas and texture, from the registry's folder and the key. The same rule is in PhoneChat.reds' caller
// (mod/phone-image-probe.lua) and in the tests.
export const atlasPath = (folder, key) => win32.join(folder, key + '.inkatlas');
export const texturePath = (folder, key) => win32.join(folder, key + '.xbm');

export function buildAtlas(folder, key) {
  if (!KEY_PATTERN.test(key)) throw new Error(`Bad picture key: ${key}`);
  const part = () => ({
    $type: 'inkTextureAtlasMapper',
    clippingRectInPixels: {$type: 'Rect', bottom: 0, left: 0, right: 0, top: 0},
    clippingRectInUVCoords: {$type: 'RectF', Bottom: 1, Left: 0, Right: 1, Top: 0},
    partName: {$type: 'CName', $storage: 'string', $value: key}
  });
  const slot = () => ({
    $type: 'inkTextureSlot', parts: [part()], slices: [],
    texture: {DepotPath: path(texturePath(folder, key)), Flags: 'Soft'}
  });
  return {
    Header: {WolvenKitVersion: '9.0.1', WKitJsonVersion: '0.0.9', GameVersion: 2310, DataType: 'CR2W'},
    Data: {
      Version: 195, BuildVersion: 0, EmbeddedFiles: [],
      RootChunk: {
        $type: 'inkTextureAtlas', activeTexture: 'StaticTexture', cookingPlatform: 'PLATFORM_PC',
        dynamicTexture: emptyTexture(),
        dynamicTextureSlot: {$type: 'inkDynamicTextureSlot', parts: [], texture: emptyTexture()},
        isSingleTextureMode: 1, parts: [], slices: [],
        slots: {Elements: [slot(), slot(), slot()]},
        texture: emptyTexture(), textureResolution: 'UltraHD_3840_2160'
      }
    }
  };
}

// node scripts/Build-PhoneImageAtlas.mjs <registry.json> <output folder>: writes <key>.inkatlas.json for every picture.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [registryFile, outDir] = process.argv.slice(2);
  if (!registryFile || !outDir) { console.error('usage: node Build-PhoneImageAtlas.mjs <registry.json> <output folder>'); process.exit(2); }
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  mkdirSync(outDir, {recursive: true});
  for (const image of registry.images) {
    writeFileSync(join(outDir, `${image.key}.inkatlas.json`), JSON.stringify(buildAtlas(registry.folder, image.key), null, 2));
    console.log('atlas', image.key);
  }
}
