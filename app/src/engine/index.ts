/** The signal engine as the app sees it. See client.ts (interface) and frames.ts (contract). */
export { createEngineClient, WorkerEngineClient } from './worker-client';
export type { EngineStats } from './worker-client';
export type { EngineClient } from './client';
export type * from './frames';
export { SCHEMA_VERSION } from './frames';
