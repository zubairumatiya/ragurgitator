// ---------------------------------------------------------------------------
// UI: the main chat container (Client Component — will need "use client").
//
// Responsibility:
//   - hold conversation state (list of ChatMessage)
//   - render <MessageList /> + an input box
//   - on submit, POST the question to /api/chat and append the response
//
// Keep data-fetching logic thin here; this is a presentation component that
// talks to the /api/chat route, not to lib/rag directly (server-only code
// must not be imported into a client component).
//
// TODO: build the component and its local state.
// ---------------------------------------------------------------------------
