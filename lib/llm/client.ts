// ---------------------------------------------------------------------------
// LLM / embedding provider client setup.
//
// Single place that constructs and exports the SDK client(s) you call from
// embeddings.ts and generator.ts. Centralizing this means you can switch
// providers (Anthropic, OpenAI, a local model, ...) in one file.
//
// Notes:
//   - read the API key from process.env (see .env.example) — never commit keys
//   - this project pins Next.js 16; before adding an SDK, check the relevant
//     guide in node_modules/next/dist/docs/ (see AGENTS.md) for any route /
//     runtime constraints (e.g. node vs edge runtime for SDK calls)
//
// TODO: export a configured client (or a small wrapper) for the rest of lib/.
// ---------------------------------------------------------------------------
