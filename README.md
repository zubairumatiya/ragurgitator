# RAG Document Q&A + Retrieval Evaluation

A small app for asking questions about your own documents using **Retrieval-Augmented
Generation (RAG)** — and, more interestingly, for **measuring how good the retrieval
actually is** instead of just trusting it.

You upload documents, the app splits them into chunks and embeds them into a vector
database, and when you ask a question it finds the most relevant chunks and has an
LLM answer using only those. On top of that, it has a full evaluation suite that
scores retrieval quality with real information-retrieval metrics.

> Status: personal project / work in progress. It runs locally; it's not a hosted
> product. Built mainly to explore retrieval quality and embedding-model trade-offs.

## What it does

- **Ingest documents** — paste text or upload `.txt`, `.md`, `.pdf`, or `.docx` files.
- **Chunk + embed** — splits text into token-based chunks (using the embedding
  model's own tokenizer) and stores vectors in Postgres via pgvector.
- **Ask questions** — retrieves the top-k most relevant chunks and has Claude answer
  grounded in them.
- **Evaluate retrieval** — auto-generates synthetic questions from your documents and
  scores retrieval with **Recall@k**, **MRR**, and **graded nDCG@k**. The nDCG
  "ideal ranking" is built from a cross-model embedding consensus, with optional
  LLM re-rankers, so it's a real graded metric rather than a yes/no hit.
- **Explore the corpus** — k-means clustering with silhouette/cohesion diagnostics
  and automatic cluster labels.
- **Experiment** — compare different embedding models, and try different chunk
  sizes/overlaps, against the live corpus without changing your index.

## Tech stack

- **Next.js** + **React** + **TypeScript**
- **PostgreSQL** + **pgvector** for vector storage and search
- **Voyage AI** for embeddings
- **Anthropic Claude** for answer generation and LLM-as-judge ranking

## Getting started

**Prerequisites**

- Node.js (18+)
- A PostgreSQL database with the **pgvector** extension enabled (a free
  [Supabase](https://supabase.com) project works well)
- API keys for [Anthropic](https://console.anthropic.com) and
  [Voyage AI](https://www.voyageai.com)

**Setup**

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your env file and fill in the values:
   ```bash
   cp .env.example .env.local
   ```
   Set `DATABASE_URL`, `ANTHROPIC_API_KEY`, and `VOYAGE_API_KEY`.
3. Apply the database schema — run the SQL files in `migrations/` against your
   database **in numerical order** (`0001…`, `0002…`, and so on).
4. Start the dev server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3002](http://localhost:3002).

## Project layout

- `app/` — pages and API routes (the main Q&A page, `/eval`, and `/clusters`)
- `lib/rag/` — the core logic: ingestion, chunking, embeddings, retrieval,
  evaluation, clustering, and the ranking builder
- `lib/config.ts` — model names and retrieval knobs (chunk size, overlap, top-k)
- `migrations/` — the database schema, one SQL file per change

## Scripts

```bash
npm run dev     # start the dev server (port 3002)
npm run build   # production build
npm run start   # run the production build
npm run lint    # eslint
npm test        # run the test suite
```
