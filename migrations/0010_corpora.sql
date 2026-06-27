-- ============================================================================
-- 0010_corpora.sql
--
-- Reusable, named document sets (corpora) + raw source text storage.
--
-- Today a `documents` row holds only file_name + content_hash; the text lives
-- only inside the per-config chunk rows, already split. To let a corpus be
-- re-chunked / re-embedded under new settings WITHOUT re-upload (the
-- multi-config epic, see docs/multi-config-plan.md), we persist the raw text
-- here, and group documents into corpora via a membership join.
--
--   - corpora           a named set of source documents, reusable across configs
--   - documents.content the raw extracted text (was never stored before)
--   - corpus_documents  many-to-many membership (a doc can be in several corpora)
--
-- This migration is additive only; 0011 introduces configs and re-scopes the
-- derived (embedding / eval / cluster) data to them.
-- ============================================================================

create table corpora (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Raw source text, so a corpus can be re-chunked/re-embedded without re-upload.
-- Nullable: rows that predate this migration have no stored text (they were
-- ingested before we kept it); new ingests always populate it.
alter table documents add column content text;

create table corpus_documents (
  corpus_id   uuid        not null references corpora(id)   on delete cascade,
  document_id uuid        not null references documents(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (corpus_id, document_id)
);

create index corpus_documents_document_idx on corpus_documents (document_id);
