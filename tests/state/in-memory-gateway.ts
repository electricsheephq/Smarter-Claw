/**
 * Test-shim re-export. The implementation moved to
 * `src/state/in-memory-gateway.ts` at P-4 so the plugin entry can use
 * the same class. P-6 will replace it with a real SDK-backed gateway.
 */
export { InMemoryGateway } from "../../src/state/in-memory-gateway.js";
