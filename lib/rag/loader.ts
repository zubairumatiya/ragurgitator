// ---------------------------------------------------------------------------
// STEP 1 of ingestion: LOAD
//
// Responsibility: take a raw source (a .txt/.md/.pdf file, a pasted string,
// a URL) and turn it into one or more clean `SourceDocument` objects with
// their text extracted and basic metadata attached (filename, source, etc).
//
// This module should NOT chunk, embed, or store anything — it only produces
// clean text. Keep parsing concerns (e.g. PDF extraction) isolated here.
//
// TODO: export something like `loadDocument(input): Promise<SourceDocument[]>`
// ---------------------------------------------------------------------------
