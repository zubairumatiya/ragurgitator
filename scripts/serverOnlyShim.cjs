// `server-only` throws on require to stop a server module reaching a client
// bundle. A script that drives the RAG pipeline in-process imports that graph
// outside Next entirely, which trips the guard on a false positive — there is no
// client here to leak into. Stubbing both markers is the whole shim.
//
// Preloaded via --import ahead of tsx, so it is installed before any app module
// resolves. Nothing but scripts/* should reference it.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a .cjs preload has no other way in
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  return load.call(this, request, parent, isMain);
};
