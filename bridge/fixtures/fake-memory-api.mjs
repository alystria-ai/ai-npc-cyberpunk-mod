// Test double for player-memory-api.mjs: memory is always enabled, offline.
export class PlayerMemoryApi {
  async enableMemory() { return {enabled: true, changed: false}; }
  async inspectMemory() { return {items: []}; }
  async clearMemory() { return {cleared: true}; }
}
