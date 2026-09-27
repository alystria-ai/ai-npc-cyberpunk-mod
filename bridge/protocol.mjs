// Managed identity is authoritative. Never silently route an unsupported named
// companion into a resident profile just because its body type is recognized.
export function profileFor(input, roster) {
  return roster.find(profile => profile.key === input.profileKey);
}

export function parseInput(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const {requestId, generation, entity, name, bodyType, profileKey, text} = value;
  if (typeof requestId !== 'string' || !/^[0-9]+-[0-9]+-[0-9]+ULL$/.test(requestId)
      || !Number.isSafeInteger(generation) || generation < 0 || typeof entity !== 'string' || !/^\d+ULL$/.test(entity)
      || !requestId.endsWith(`-${generation}-${entity}`)
      || typeof text !== 'string' || !text.trim() || text.length > 1200
      || typeof name !== 'string' || typeof bodyType !== 'string'
      || typeof profileKey !== 'string' || !/^[a-z0-9-]+$/.test(profileKey)) return null;
  return {requestId, generation, entity, name: name.slice(0, 120), bodyType: bodyType.slice(0, 80), profileKey, text: text.trim()};
}
