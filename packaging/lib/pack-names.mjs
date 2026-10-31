// The file names of the optional packs (packaging/release.config.json, "packFiles"; docs/PACKAGING.md, "Pack file names").
// Every model pack carries the model's name and parameter count in its file name: <Type>-<Tier>-<Model>-<Params>.zip. One source for the
// builder, the uploader (packaging/upload-packs.py reads the same block), the install test and the Pocket model builder.
// A pack is found by the markers and folders inside it, never by the name of its zip, so a pack installed under an old name keeps working.

/** The `packFiles` block of the release config. */
export const packFiles = config => {
  const block = config?.packFiles;
  if (!block?.packs) throw Error('packaging/release.config.json has no packFiles block');
  return block;
};

/** The title (the name without version and extension) of a pack id, e.g. 'localai-lite' -> 'LocalAI-Lite-Bonsai-2-4B'. */
export function packTitle(config, id) {
  const entry = packFiles(config).packs[id];
  if (!entry) throw Error(`unknown pack ${id}`);
  return entry.title;
}

/** The old title of a pack id (before 0.3.4), e.g. 'LocalAI-Lite'. */
export const legacyPackTitle = (config, id) => packFiles(config).packs[id]?.legacyTitle ?? null;

/** Where a pack lives on Hugging Face: '<folder>/<title>.zip'. */
export const hfPath = (config, id) => `${packFiles(config).packs[id].folder}/${packTitle(config, id)}.zip`;

/** Every place a pack is published to: its folder, then `alsoIn` (the Gemma 4 E4B vision file is in local-ai/vision and in mature/vision, one zip at two paths). */
export const hfPaths = (config, id) => {
  const entry = packFiles(config).packs[id];
  return [entry.folder, ...(entry.alsoIn ?? [])].map(folder => `${folder}/${entry.title}.zip`);
};

/** The same, under the name before 0.3.4. */
export const legacyHfPath = (config, id) => `${packFiles(config).packs[id].folder}/${legacyPackTitle(config, id)}.zip`;

/** Both titles of a pack, new first, so a lookup by name can accept either: ['LocalAI-Lite-Bonsai-2-4B', 'LocalAI-Lite']. */
export const packTitles = (config, id) => [packTitle(config, id), legacyPackTitle(config, id)].filter(Boolean);

/** The title of a PocketTTS model zip for a language title ('French'), and the one before 0.3.4 (none for a language that came later: the Russian model has 90M parameters, the others 100M). */
export const pocketModelTitle = (config, language) => `${packFiles(config).pocketModels.languagePrefixes?.[language] ?? packFiles(config).pocketModels.prefix}${language}`;
export const legacyPocketModelTitle = (config, language) => packFiles(config).pocketModels.languagePrefixes?.[language] ? null : `${packFiles(config).pocketModels.legacyPrefix}${language}`;

/** The pack id a zip name belongs to, whatever its version and whether it carries the new or the old title (null when it is none of them). */
export function packIdOfName(config, name) {
  const base = String(name).replace(/\.zip$/i, '');
  for (const [id, entry] of Object.entries(packFiles(config).packs)) {
    for (const title of [entry.title, entry.legacyTitle]) {
      if (base === title || (base.startsWith(`${title}-`) && /^\d/.test(base.slice(title.length + 1)))) return id;
    }
  }
  return null;
}
