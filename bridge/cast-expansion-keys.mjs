// The 2026-10-18 cast expansion (docs/CAST_EXPANSION_RECIPE.md): keys added by the batch, in roster order. Shared by
// bridge/cast-expansion.test.mjs and the twin-map test, which requires every one of these twins to have its Convai
// language box off (languageBoxOff: true in the twin map).
export const CAST_EXPANSION_KEYS = Object.freeze([
  'bryce-mosley', 'dum-dum', 'royce', 'rosalind-myers', 'kurt-hansen', 'woodman', 'fingers', 'garry-the-prophet',
  'brendan', 'anthony-gilchrist', 'denny', 'henry', 'teddy', 'weyland', 'oda', 'chester-bennett', 'bree-whitney',
  'edgar-tool', 'jacob-long', 'angelica-whelan', 'voodoo-queen', 'anders-hellman', 'joshua-stephenson',
  'maiko-maeda', 'wilky-laguerre', 'aurore-cassel', 'dante-caruso', 'jago-szabo'
]);

// The 2026-10-19 second expansion (same recipe), in roster order. Their Convai twins still await the dashboard language box
// (see docs/CAST_EXPANSION_RECIPE.md "Second batch"), so they are not in CAST_EXPANSION_KEYS and the twin-map test does not
// require languageBoxOff for them yet. Move them into CAST_EXPANSION_KEYS once the box is off and their voices are built.
export const CAST_EXPANSION_2_KEYS = Object.freeze([
  'steve', 'grayson', 'aymeric-cassel', 'farida-nazeri', 'brick', 'patricia', 'lucy-thackery', 'mateo-thiago',
  'max-jones', 'tiny-mike', 'ziggy-q', 'doctor-paradox', 'leon-rinder', 'albert-murphy', 'carl-robinson'
]);
