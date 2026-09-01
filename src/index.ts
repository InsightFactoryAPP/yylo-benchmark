// Public v2 CLI and contracts. Restrictive v1 execution/planning modules remain
// source-internal only for bounded historical tests and read projection; they
// are not exported as a second writable package API.
export * from './cli/program.js';
export * from './cli/registry.js';
export * from './contracts/canonical.js';
export * from './contracts/schemas.js';
export * from './doctor/index.js';
export * from './identity.js';
export * from './release-readiness/index.js';
export * from './registry/index.js';
export * from './reporting/index.js';
export * from './snapshot/index.js';
export * from './v2/contracts.js';
export * from './v2/workspace.js';
export * from './v2/harness.js';
export * from './v2/adapters.js';
export * from './v2/evaluators.js';
export * from './v2/cli.js';
