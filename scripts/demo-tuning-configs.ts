// THE DEMO'S TUNING SIBLINGS — phase 0 of docs/demo-voyage-tuning-plan.md.
//
// WHY THESE EXIST. The guest's ⚙ Auto tune installs the master's per-chunk winner
// off a bank, and the master's winners were chosen against the PAIR of questions
// on each chunk, over every provider the master has a key for, inside a
// 99-override environment no guest ever has (plan §0). So the bank is re-sourced:
// one fresh config per difficulty SET the guest can hold, each a position-for-
// position copy of the demo config's corpus, labeled with only that set's board
// questions, scoped to the board, and restricted to the demo's own provider. The
// master tunes each one in the ordinary UI; the publish packs each one's winners
// under its own bank key (§3.3); the guest picks the bank by the difficulties on
// its board (§3.4).
//
// SIBLINGS, NOT ONE CONFIG RUN THREE TIMES: overrides are per (config, chunk),
// so three states cannot coexist on one config, and a capture-then-reset dance
// would move the bank's source from live rows the publish can re-read into a
// one-shot snapshot (§1).
//
// WHAT A SIBLING STARTS AS — exactly the guest's own starting point. A guest's
// config carries ZERO overrides (lib/demo/clone step 5), and the board was chosen
// from retrieval_state = 'baseline' scores, so a fresh config on the same corpus,
// chunking and base model has the guest's baseline to the rank. `check` proves
// that before a run starts: 60 ranks, 0 mismatches, or the run does not begin.
//
//   npm run demo:tuning -- create --from <demoConfigId>   mint the siblings
//   npm run demo:tuning -- check                          census + baseline diff,
//                                                         and post-run ranks
//   npm run demo:tuning -- reset <siblingId>              clear a sibling's
//                                                         overrides and trials
//                                                         (the plan's §2 timing
//                                                         run starts from here)
//
// Through privilegedSql like every other publish-time script: a script has no
// request scope, so the request-scoped `sql` would throw before it read.
// Env: DEMO_MASTER_USER_ID (the account the demo config and the siblings live in).
import { autotuneModelLadder } from "../lib/config";
import { privilegedSql } from "../lib/db";
import { BOARD_KEY, type ReplayBoard } from "../lib/demo/replayCore";
import { modelSpec } from "../lib/rag/embeddingModels";
import { chunksTable, modelDimension } from "../lib/rag/vectorStore";

const args = process.argv.slice(2);
const command = args[0];
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// One sibling per difficulty SET a guest's board can hold: each difficulty alone,
// and all of them together. Derived from the difficulties actually present on
// the board rather than hard-coded, so a board with three difficulties gets four
// siblings and the key each one publishes under is the one lib/demo/replayCore's
// tuningKey will derive for a guest holding that set.
export function difficultySets(difficulties: string[]): string[][] {
  const all = [...new Set(difficulties)].sort();
  const sets = all.map((d) => [d]);
  if (all.length > 1) sets.push(all);
  return sets;
}

export function siblingName(set: string[]): string {
  return `Demo tuning · ${set.join("+")}`;
}

// The provider rule lib/demo/captureTuning applies at the bank (servableBy),
// applied at the SOURCE instead: a sibling never searches a model the guest's one
// key cannot embed under, so nothing it wins is foreign to the demo. The base
// model is left out because the engine's usableModelLadder drops it anyway.
export function servableLadder(baseModel: string): string[] {
  const provider = modelSpec(baseModel).provider;
  return autotuneModelLadder.filter((id) => {
    if (id === baseModel) return false;
    try {
      return modelSpec(id).provider === provider;
    } catch {
      return false;
    }
  });
}

type DemoConfig = {
  id: string;
  name: string | null;
  base_model: string;
  top_k: number;
  user_id: string;
};

async function loadDemoConfig(id: string, master: string): Promise<DemoConfig> {
  const [cfg] = await privilegedSql<DemoConfig[]>`
    select id, name, base_model, top_k, user_id from configs where id = ${id}
  `;
  if (!cfg) die(`no config ${id}`);
  if (cfg.user_id !== master) die(`config ${id} is not owned by DEMO_MASTER_USER_ID`);
  return cfg;
}

// The board, in the demo config's id space: the row the last publish wrote on the
// master (scripts/demo-snapshot writeBoard) before cloning it to the snapshot.
async function loadBoard(master: string): Promise<string[]> {
  const [row] = await privilegedSql<{ payload: ReplayBoard }[]>`
    select payload from demo_replay
     where user_id = ${master} and kind = 'board' and key = ${BOARD_KEY}
  `;
  if (!row) die("the master holds no published board — run npm run demo:snapshot first.");
  return row.payload.chunks;
}

// The board's labeled questions on the demo config, with the difficulty each set
// is cut by. Set membership is eval_questions.difficulty (plan §3.1); a label on a
// board chunk whose question carries no difficulty belongs to no set and is
// reported rather than silently dropped.
type BoardLabel = { label_id: string; question_id: string; chunk: string; difficulty: string | null };

async function loadBoardLabels(demo: DemoConfig, board: string[]): Promise<BoardLabel[]> {
  return privilegedSql<BoardLabel[]>`
    select l.id as label_id, q.id as question_id, l.source_chunk_id as chunk, q.difficulty
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      join eval_questions q on q.id = l.eval_question_id
     where de.config_id = ${demo.id}
       and l.source_chunk_id = any(${board}::uuid[])
     order by l.source_chunk_id, q.difficulty
  `;
}

async function siblings(master: string): Promise<{ id: string; name: string; base_model: string }[]> {
  return privilegedSql<{ id: string; name: string; base_model: string }[]>`
    select id, name, base_model from configs
     where user_id = ${master} and name like 'Demo tuning · %'
     order by tab_order, created_at
  `;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function create(): Promise<void> {
  const master = process.env.DEMO_MASTER_USER_ID?.trim();
  if (!master) die("DEMO_MASTER_USER_ID is not set.");
  const from = valueOf("--from");
  if (!from) die("usage: create --from <demoConfigId>");

  const demo = await loadDemoConfig(from, master);
  const board = await loadBoard(master);
  const labels = await loadBoardLabels(demo, board);
  const unset = labels.filter((l) => l.difficulty === null);
  if (unset.length > 0) {
    die(`${unset.length} board label(s) carry no difficulty; every board question must belong to a set.`);
  }
  const sets = difficultySets(labels.map((l) => l.difficulty as string));
  const scope = servableLadder(demo.base_model);
  const table = chunksTable(demo.base_model, modelDimension(demo.base_model));

  const existing = await siblings(master);
  const clash = existing.filter((c) => sets.some((s) => siblingName(s) === c.name));
  if (clash.length > 0) {
    die(
      `sibling(s) already exist: ${clash.map((c) => `"${c.name}" (${c.id})`).join(", ")}. ` +
        `Close and delete them in the UI before re-creating.`,
    );
  }

  console.log(`\nmaster  ${master}`);
  console.log(`source  "${demo.name}" (${demo.id}, ${demo.base_model})`);
  console.log(`board   ${board.length} chunks, ${labels.length} labeled questions`);
  console.log(`scope   ${scope.join(", ")}\n`);

  for (const set of sets) {
    const name = siblingName(set);
    const setLabels = labels.filter((l) => set.includes(l.difficulty as string));
    const id = await privilegedSql.begin(async (tx) => {
      // The row. duplicateConfig (lib/rag/configStore) copies only corpus, base
      // model, chunking, top_k and llm_model; the rest is named here so the
      // sibling tunes under the demo config's exact dials — every autotune_*
      // column, the three criteria, the metric toggles, the fusion pool — and
      // differs from it in exactly the three columns set below it: name, chunk
      // scope, model scope. eval_difficulties is the set's own, so the tab
      // reads as a guest with that set loaded.
      const [{ next: tabOrder }] = await tx<{ next: number }[]>`
        select coalesce(max(tab_order), -1) + 1 as next from configs where user_id = ${master}
      `;
      const [created] = await tx<{ id: string }[]>`
        insert into configs
          (user_id, corpus_id, corpus_sync, name, base_model, chunk_size, chunk_overlap,
           top_k, llm_model, is_open, tab_order,
           recall_enabled, recall_k, recall_min_rate,
           mrr_enabled, mrr_k, mrr_min_rate,
           ndcg_enabled, ndcg_k, ndcg_min_rate, ndcg_aggregate_models,
           eval_difficulties,
           autotune_size_ladder, autotune_overlap_pct, autotune_apply, autotune_search,
           autotune_stop_early, autotune_keep_best, autotune_fusion_pool,
           autotune_holdout_enabled, autotune_holdout_mode, autotune_holdout_size,
           autotune_holdout_seed,
           retrieval_fusion_pool, batch_savings, cascade_enabled,
           autotune_chunk_scope, autotune_model_scope)
        select
           user_id, corpus_id, corpus_sync, ${name}, base_model, chunk_size, chunk_overlap,
           top_k, llm_model, true, ${tabOrder},
           recall_enabled, recall_k, recall_min_rate,
           mrr_enabled, mrr_k, mrr_min_rate,
           ndcg_enabled, ndcg_k, ndcg_min_rate, ndcg_aggregate_models,
           ${set}::text[],
           autotune_size_ladder, autotune_overlap_pct, autotune_apply, autotune_search,
           autotune_stop_early, autotune_keep_best, autotune_fusion_pool,
           autotune_holdout_enabled, autotune_holdout_mode, autotune_holdout_size,
           autotune_holdout_seed,
           retrieval_fusion_pool, batch_savings, cascade_enabled,
           null, ${scope}::text[]
          from configs where id = ${demo.id}
        returning id
      `;

      // The corpus, position-for-position: the same two statements duplicateConfig
      // runs. Within a config a document has exactly one run, so document_id keys
      // the run and (document_id, position) keys the chunk — which is what every
      // id map below and in lib/demo/captureTuning leans on.
      await tx`
        insert into document_embeddings
          (config_id, document_id, model, dimension, chunk_size, chunk_overlap, chunk_count)
        select ${created.id}, document_id, model, dimension, chunk_size, chunk_overlap, chunk_count
          from document_embeddings where config_id = ${demo.id}
      `;
      await tx`
        insert into ${tx(table)}
          (config_id, document_id, document_embedding_id, position, text, embedding)
        select ${created.id}, ch.document_id, nde.id, ch.position, ch.text, ch.embedding
          from ${tx(table)} ch
          join document_embeddings nde
            on nde.config_id = ${created.id} and nde.document_id = ch.document_id
         where ch.config_id = ${demo.id}
      `;

      // The set's labels. A label is keyed by document_embedding_id, not config,
      // so each demo label maps twice: its run to the sibling's run by document,
      // its chunk to the sibling's chunk by (document, position). Both exact
      // because the copy above is.
      const setLabelIds = setLabels.map((l) => l.label_id);
      await tx`
        insert into eval_labels (eval_question_id, document_embedding_id, source_chunk_id)
        select l.eval_question_id, nde.id, nch.id
          from eval_labels l
          join document_embeddings de on de.id = l.document_embedding_id
          join ${tx(table)} ch on ch.id = l.source_chunk_id
          join document_embeddings nde
            on nde.config_id = ${created.id} and nde.document_id = de.document_id
          join ${tx(table)} nch
            on nch.config_id = ${created.id}
           and nch.document_id = ch.document_id and nch.position = ch.position
         where l.id = any(${setLabelIds}::uuid[])
      `;

      // The chunk scope: the board's 30 in the sibling's id space, same map.
      await tx`
        update configs set autotune_chunk_scope = (
          select array_agg(nch.id order by nch.document_id, nch.position)
            from ${tx(table)} ch
            join ${tx(table)} nch
              on nch.config_id = ${created.id}
             and nch.document_id = ch.document_id and nch.position = ch.position
           where ch.id = any(${board}::uuid[])
        ) where id = ${created.id}
      `;
      return created.id;
    });
    console.log(`created "${name}"  ${id}  (${setLabels.length} labels)`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

type SiblingCensus = {
  id: string;
  name: string;
  chunks: number;
  labels: number;
  scope: number | null;
  model_scope: string[] | null;
  overrides: number;
  override_models: string[];
  runs: number;
  last_run: string | null;
};

type RankRow = { question_id: string; chunk: string; difficulty: string | null; rank: number | null };

// The demo config's PRE-override rank per board question: the latest result at
// the config's top_k scored while it had no overrides, excluding the 0057 baseline
// pass (`not is_baseline`) — the rows lib/demo/publishedBank and
// scripts/demo-snapshot already read. A sibling's ranks come off the same query;
// with no overrides ever, every result it has is `retrieval_state = 'baseline'`.
async function baselineRanks(configId: string, topK: number, board: string[]): Promise<RankRow[]> {
  return privilegedSql<RankRow[]>`
    select distinct on (r.eval_label_id)
           r.eval_question_id as question_id, l.source_chunk_id as chunk, q.difficulty,
           r.found_rank as rank
      from eval_results r
      join eval_labels l on l.id = r.eval_label_id
      join document_embeddings de on de.id = l.document_embedding_id
      join eval_questions q on q.id = r.eval_question_id
     where de.config_id = ${configId}
       and r.retrieval_state = 'baseline' and not r.is_baseline
       and r.k = ${topK}
       and l.source_chunk_id = any(${board}::uuid[])
     order by r.eval_label_id, r.scored_at desc
  `;
}

// The sibling's CURRENT rank per board question after a run: the latest real
// result at the config's top_k under whatever override state it was scored in.
// What phase 4's acceptance test compares a guest's after-ranks against.
async function latestRanks(configId: string, topK: number, board: string[]): Promise<RankRow[]> {
  return privilegedSql<RankRow[]>`
    select distinct on (r.eval_label_id)
           r.eval_question_id as question_id, l.source_chunk_id as chunk, q.difficulty,
           r.found_rank as rank
      from eval_results r
      join eval_labels l on l.id = r.eval_label_id
      join document_embeddings de on de.id = l.document_embedding_id
      join eval_questions q on q.id = r.eval_question_id
     where de.config_id = ${configId}
       and not r.is_baseline
       and r.k = ${topK}
       and l.source_chunk_id = any(${board}::uuid[])
     order by r.eval_label_id, r.scored_at desc
  `;
}

async function check(): Promise<void> {
  const master = process.env.DEMO_MASTER_USER_ID?.trim();
  if (!master) die("DEMO_MASTER_USER_ID is not set.");
  const rows = await siblings(master);
  if (rows.length === 0) die("no siblings yet — run create --from <demoConfigId>.");

  // The demo config is the one the siblings were cut from: the master config
  // whose base chunk table holds the board's ids. Found by the board rather than
  // taken on the command line so the two cannot disagree; the siblings share its
  // base model, so the first one names the table.
  const board = await loadBoard(master);
  const table = chunksTable(rows[0].base_model, modelDimension(rows[0].base_model));
  const [demo] = await privilegedSql<DemoConfig[]>`
    select distinct c.id, c.name, c.base_model, c.top_k, c.user_id
      from configs c
      join ${privilegedSql(table)} ch on ch.config_id = c.id
     where c.user_id = ${master} and ch.id = any(${board}::uuid[])
  `;
  if (!demo) die("the board names no chunk of any master config; republish first.");
  const demoRanks = await baselineRanks(demo.id, demo.top_k, board);
  const provider = modelSpec(demo.base_model).provider;

  console.log(`\ndemo    "${demo.name}" (${demo.id}) — ${demoRanks.length} pre-override ranks on the board\n`);

  for (const s of rows) {
    const [c] = await privilegedSql<SiblingCensus[]>`
      select c.id, c.name,
             (select coalesce(sum(chunk_count), 0) from document_embeddings de where de.config_id = c.id)::int as chunks,
             (select count(*) from eval_labels l
               join document_embeddings de on de.id = l.document_embedding_id
              where de.config_id = c.id)::int as labels,
             cardinality(c.autotune_chunk_scope) as scope,
             c.autotune_model_scope as model_scope,
             (select count(*) from config_chunk_overrides o where o.config_id = c.id)::int as overrides,
             (select coalesce(array_agg(distinct model), '{}') from config_chunk_overrides o
               where o.config_id = c.id) as override_models,
             (select count(*) from autotune_runs a where a.config_id = c.id)::int as runs,
             (select max(a.created_at)::text from autotune_runs a where a.config_id = c.id) as last_run
        from configs c where c.id = ${s.id}
    `;
    const foreign = c.override_models.filter((m) => {
      try {
        return modelSpec(m).provider !== provider;
      } catch {
        return true;
      }
    });
    const scopeOk =
      c.model_scope !== null && c.model_scope.every((m) => modelSpec(m).provider === provider);
    console.log(`"${c.name}"  ${c.id}`);
    console.log(
      `  ${c.chunks} chunks, ${c.labels} labels, chunk scope ${c.scope ?? "unset"}, ` +
        `model scope ${c.model_scope === null ? "UNSET" : `${c.model_scope.length} (${scopeOk ? `${provider}-only` : "MIXED"})`}`,
    );
    console.log(
      `  ${c.overrides} override(s)` +
        (c.overrides > 0 ? ` under ${c.override_models.join(", ")}` : "") +
        (foreign.length > 0 ? `  ⚠ foreign: ${foreign.join(", ")}` : "") +
        `; ${c.runs} autotune run(s)${c.last_run ? `, last ${c.last_run}` : ""}`,
    );

    // The sibling's board in ITS id space is its chunk scope; the ranks compare by
    // question id, which is shared (eval_questions is document-scoped).
    const [{ scope: siblingBoard }] = await privilegedSql<{ scope: string[] | null }[]>`
      select autotune_chunk_scope as scope from configs where id = ${s.id}
    `;
    const ranks = await baselineRanks(s.id, demo.top_k, siblingBoard ?? []);
    if (ranks.length === 0) {
      console.log(`  unscored — press Score pending, then check again\n`);
      continue;
    }
    const demoByQuestion = new Map(demoRanks.map((r) => [r.question_id, r.rank]));
    let mismatches = 0;
    let missing = 0;
    for (const r of ranks) {
      if (!demoByQuestion.has(r.question_id)) {
        missing++;
        continue;
      }
      const want = demoByQuestion.get(r.question_id) ?? null;
      if (want !== r.rank) {
        mismatches++;
        console.log(
          `    ✗ ${r.chunk.slice(0, 6)} ${r.difficulty ?? "?"}: sibling ${r.rank ?? "miss"}, demo ${want ?? "miss"}`,
        );
      }
    }
    console.log(
      `  ${ranks.length} of ${c.labels} labels scored at k=${demo.top_k}: ` +
        `${mismatches} baseline mismatch(es)` +
        (missing > 0 ? `, ${missing} with no demo baseline to compare` : "") +
        (mismatches === 0 && missing === 0 && c.overrides === 0 ? "  ✓ ready to tune" : ""),
    );
    // After a run: every board question's baseline → current rank, so the
    // sibling's post-run state is written down where phase 4 can read it back.
    if (c.overrides > 0) {
      const now = await latestRanks(s.id, demo.top_k, siblingBoard ?? []);
      const base = new Map(ranks.map((r) => [r.question_id, r.rank]));
      let moved = 0;
      let hits = 0;
      const lines: string[] = [];
      for (const r of now) {
        const b = base.get(r.question_id) ?? null;
        if (r.rank !== null) hits++;
        if (b !== r.rank) moved++;
        lines.push(
          `    ${r.chunk.slice(0, 6)} ${(r.difficulty ?? "?").padEnd(6)} ${String(b ?? "miss").padStart(4)} → ${String(r.rank ?? "miss").padStart(4)}` +
            (b !== r.rank ? "  *" : ""),
        );
      }
      console.log(
        `  post-run: ${hits}/${now.length} hits at k=${demo.top_k}, ${moved} question(s) moved from baseline`,
      );
      for (const line of lines) console.log(line);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

// Back to the guest's starting point: no overrides, no trials, retrieval stamped
// as changed so every result goes stale and the next score re-reads baseline
// (0022 is revert-aware, so the pre-run baseline rows are valid again the
// moment the rows are gone). The plan's §2 timing run starts from here. Refuses
// anything that is not a sibling by name — the demo config's 99 overrides are
// the one thing this must never touch.
async function reset(): Promise<void> {
  const master = process.env.DEMO_MASTER_USER_ID?.trim();
  if (!master) die("DEMO_MASTER_USER_ID is not set.");
  const id = args[1];
  if (!id) die("usage: reset <siblingId>");
  const [cfg] = await privilegedSql<{ name: string | null; user_id: string }[]>`
    select name, user_id from configs where id = ${id}
  `;
  if (!cfg) die(`no config ${id}`);
  if (cfg.user_id !== master) die(`config ${id} is not the master's`);
  if (!cfg.name?.startsWith("Demo tuning · ")) die(`"${cfg.name}" is not a tuning sibling; refusing.`);
  const [overrides, trials] = await privilegedSql.begin(async (tx) => {
    const o = await tx`delete from config_chunk_overrides where config_id = ${id} returning 1`;
    const t = await tx`
      delete from eval_model_trials t
       using document_embeddings de
       where de.id = t.document_embedding_id and de.config_id = ${id}
      returning 1`;
    await tx`update configs set retrieval_changed_at = now() where id = ${id}`;
    return [o.length, t.length];
  });
  console.log(`\nreset "${cfg.name}": ${overrides} override row(s) and ${trials} trial(s) removed\n`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (command === "create") await create();
  else if (command === "check") await check();
  else if (command === "reset") await reset();
  else die("usage: demo-tuning-configs <create --from <demoConfigId> | check | reset <siblingId>>");
}

main()
  .then(() => privilegedSql.end())
  .catch(async (err) => {
    await privilegedSql.end().catch(() => {});
    console.error(err);
    process.exit(1);
  });
