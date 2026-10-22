// The 2026-10-18 cast expansion (docs/CAST_EXPANSION_RECIPE.md): keys added by the batch, in roster order. Shared by
// bridge/cast-expansion.test.mjs and the twin-map test, which requires every one of these twins to have its Convai
// language box off (languageBoxOff: true in the twin map).
export const CAST_EXPANSION_KEYS = Object.freeze([
  'bryce-mosley', 'dum-dum', 'royce', 'rosalind-myers', 'kurt-hansen', 'woodman', 'fingers', 'garry-the-prophet',
  'brendan', 'anthony-gilchrist', 'denny', 'henry', 'teddy', 'weyland', 'oda', 'chester-bennett', 'bree-whitney',
  'edgar-tool', 'jacob-long', 'angelica-whelan', 'voodoo-queen', 'anders-hellman', 'joshua-stephenson',
  'maiko-maeda', 'wilky-laguerre', 'aurore-cassel', 'dante-caruso', 'jago-szabo',
  // The 2026-10-19 second expansion (same recipe; voices built, twins' language boxes off, Convai verified), in roster order.
  'steve', 'grayson', 'aymeric-cassel', 'farida-nazeri', 'brick', 'patricia', 'lucy-thackery', 'mateo-thiago',
  'max-jones', 'tiny-mike', 'ziggy-q', 'doctor-paradox', 'leon-rinder', 'albert-murphy', 'carl-robinson'
]);

// The 2026-10-23 third expansion (same recipe): text, knowledge and Convai (original and twin) are done; the game voices are
// owed (clip extraction and the GPU steps need the game files), and the twins' language boxes wait for a signed-in dashboard
// session. When the voice rows are in the live configs and the boxes are recorded off, move these keys into CAST_EXPANSION_KEYS
// and delete this list and its test.
export const CAST_EXPANSION_3_KEYS = Object.freeze(['hasan-demir', 'pedro-aimar', 'mr-blue-eyes']);
