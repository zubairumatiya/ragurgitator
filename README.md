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
   Set `DATABASE_URL`, the Supabase Auth vars, and the Azure Key Vault vars.
   **No provider API keys go here** — under strict BYOK each user adds their own
   Anthropic / Voyage / OpenAI / Cohere keys on the `/account` page after signing
   up, and they are stored encrypted. See `.env.example` for the details.
3. Apply the database schema — run the SQL files in `migrations/` against your
   database **in numerical order** (`0001…`, `0002…`, and so on).
4. Create the restricted database role and set `RAG_APP_DATABASE_URL`. Migration
   `0051_rls.sql` creates the role `rag_app` but deliberately gives it **no
   password** — a migration file is committed and a password should not be. Set
   one out of band, as `postgres`:
   ```sql
   alter role rag_app password 'a-strong-password';
   ```
   Then put the matching connection string in `.env.local`. It is the same host,
   port and database as `DATABASE_URL`; only the username and password change,
   and through Supabase's pooler the username takes the form
   `rag_app.<project-ref>`:
   ```
   RAG_APP_DATABASE_URL=postgresql://rag_app.<project-ref>:<password>@<same-host>:6543/postgres
   ```

   ### Why there are two connection strings

   `RAG_APP_DATABASE_URL` is what the whole store layer runs as. `rag_app` holds
   `NOBYPASSRLS`, so the row-level security policies in `0051_rls.sql` actually
   apply to it and a store query that forgot its `where user_id = …` returns
   nothing instead of returning every tenant's rows.

   `DATABASE_URL` connects as `postgres`, which bypasses RLS, and is kept for
   exactly three jobs: running migrations, deleting an `auth.users` row on
   account deletion, and `scripts/backfill-embedding-cache.ts`, which is
   deliberately cross-tenant. It should not gain a fourth.

   There is **no fallback** if `RAG_APP_DATABASE_URL` is missing — the app
   refuses to start. Falling back to `DATABASE_URL` would run the entire store
   layer as a role that bypasses RLS while appearing to work perfectly, which is
   the one failure mode worth refusing outright.
5. Start the dev server:
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

## Rotating the key-encryption key

Provider keys are sealed with envelope encryption: a per-secret DEK encrypts the
key, and the DEK is wrapped by a KEK that never leaves Azure Key Vault. Rotating
the KEK means adding a new **version** of the vault key `provider-key-kek`.

Existing rows keep working throughout, and that is by design.
`user_provider_keys.kek_id` stores the key **version** each row was sealed with,
and `unwrap` uses the row's own version rather than the current one
(`lib/crypto/azureKeyVault.ts`), so rotation orphans nothing and re-wrapping can
happen later or never.

1. **Grant yourself Crypto Officer, temporarily.** Day to day the developer
   identity holds only **Key Vault Crypto User** — enough for `getKey`, wrap and
   unwrap, which is everything the app does. Creating a key version is not in
   that role. Grant **Crypto Officer** on the vault, rotate, then remove it.
2. **Create the new version** of `provider-key-kek` in vault `rag-app-zube`
   (Azure portal → the key → *New Version*, or `az keyvault key rotate`).
3. **Restart the app.** `currentKeyId()` resolves the current version **once per
   process and caches it forever** — the right call for a hot path that would
   otherwise hit the vault on every save, but it means a running server keeps
   sealing new keys under the *old* version until it restarts. On Vercel a
   redeploy does this; locally, restart `npm run dev`.
4. **Verify** with `npm run vault:check`, which round-trips wrap/unwrap against
   the live vault.
5. **Re-wrap when convenient**, or let rotation happen lazily — every user who
   re-saves a key gets the new version automatically. To confirm where things
   stand:
   ```sql
   select kek_id, count(*) from user_provider_keys group by 1;
   ```
6. **Do not disable or delete an old key version while any row still names it.**
   Step 5's query is the only thing standing between a cleanup and every affected
   user having to re-enter their provider keys — destroying a KEK version makes
   the DEKs wrapped under it permanently unrecoverable.

There is deliberately no re-wrap script. A pass would have to hold every user's
plaintext key in memory to re-seal it, and the AAD binds each row to its
`userId:provider` pair (`lib/crypto/envelope.ts`), so a re-seal that got the pair
wrong would make the row permanently unopenable. Lazy rotation via step 5 avoids
writing that code at all; if a forced pass is ever needed, those two constraints
are what it has to respect.

## Adding a migration

Read this before writing a migration that **creates a table**. Since RLS became
load-bearing (`0051_rls.sql`), a new table is deny-all by default and the app
cannot read it.

An event trigger, `ensure_rls`, enables row-level security on every new table in
`public` automatically. The app connects as `rag_app`, which holds `NOBYPASSRLS`,
so a table with RLS enabled and **no policy** returns zero rows to every query —
in production, with no error anywhere. Reads come back empty, writes are rejected
by `WITH CHECK`, and the page that uses the table looks like it has no data yet.

Grants are handled for you: `0051` set `alter default privileges in schema
public`, so a new table inherits `select, insert, update, delete` for `rag_app`.
**Policies are not** — Postgres has no equivalent mechanism, so every new table
needs its own.

So, for each new table:

1. Give it a path to an owner — a `user_id uuid not null references
   user_profiles(id) on delete cascade`, or a `config_id` / `document_id` that
   already reaches one.
2. Ship a policy `to rag_app` **in the same migration**, matching the shape its
   neighbours use in `0051_rls.sql`: a direct
   `using (user_id = app.current_user_id())` for an owner-rooted table, or an
   `exists (select 1 from configs …)` for a `config_id`-bearing one.
3. Run both checks before and after applying it:
   ```bash
   npm run rls:check      # every table is reachable to its owner and nobody else
   npm run cascade:check  # every table is destroyed by account deletion
   ```
   Each asserts an allowlist rather than printing a report, so a table that
   forgot step 1 or step 2 fails by name without either script knowing about it
   in advance.

## Scripts

```bash
npm run dev            # start the dev server (port 3002)
npm run build          # production build
npm run start          # run the production build
npm run lint           # eslint
npm test               # run the test suite
npm run guard          # multi-tenancy invariants: key handling, scopes, auth gates

npm run vault:check    # Azure Key Vault wrap/unwrap round-trip
npm run rls:check      # tenant isolation: owner sees all, stranger sees none
npm run cascade:check  # deletion contract: keys delete alone, accounts delete all
```

`guard` is pure static analysis — no database, no network, no env — so it is safe
to run anywhere. The last three talk to live services and read `.env.local`:
`rls:check` needs both connection strings, `cascade:check` needs `DATABASE_URL`
only, and `vault:check` needs an `az login` session.

What `guard` enforces, and why none of it can be a type: `.expose()` (the only
way to unwrap a decrypted provider key) appears solely at the two provider-client
construction sites and is never parked in a local; every `app/` entry point that
touches the store enters a request scope, which since `0051` is also the database
transaction carrying the user identity; and every exported API handler is behind
the authentication boundary — checked **per method**, because a file-level sweep
passes while a `DELETE` sharing a file with a gated `GET` stays open, which is
exactly how ten handlers were missed once already.
