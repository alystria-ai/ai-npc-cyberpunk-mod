// Test double for player-memory-api.mjs: memory is always enabled, offline.
export class PlayerMemoryApi {
  use() {}   // the key in use changed (a player's own key): nothing to switch offline
  async enableMemory() { return {enabled: true, changed: false}; }
  async inspectMemory() { return {items: []}; }
  async clearMemory() { return {cleared: true}; }
}
