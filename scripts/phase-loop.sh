#!/usr/bin/env bash
# One plan phase per `claude -p` invocation. Fresh process == context clear.
# Exits the whole loop on block, error, or usage limit.
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS=.loop-logs
PROG="$LOGS/progress.log"
MAX_PHASES=${MAX_PHASES:-12}
# how the child runs; override to acceptEdits if you'd rather approve bash yourself
PERM=${PERM:-bypassPermissions}
mkdir -p "$LOGS"
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$PROG"; }

read -r -d '' PROMPT <<'P'
You are running one phase of a plan, unattended. Nobody can answer you.

Plan file: docs/demo-real-flow-plan.working.md  (the ONLY plan file you edit)

Do exactly this, in order:
1. Read section 8 PHASING and the VERIFICATION LOG. Find the LOWEST-numbered phase
   not marked DONE. If every phase is DONE, print exactly ALL_PHASES_COMPLETE and
   stop without changing anything. Otherwise print exactly PHASE_START <n> before
   you begin building.
2. Build that phase, and only that phase.
3. Print exactly PHASE_VERIFY <n>, then verify in a browser with the
   firefox-devtools MCP tools against http://localhost:3002. Guest recipe:
   POST /api/demo/start from the page, then /c/<configId>/eval. Fix and re-verify
   on failure.
4. Append a VERIFICATION LOG entry and mark the phase DONE in section 8 with
   today's date, in the plan file above.
5. Commit everything. Message under 30 words, no Co-Authored-By trailer, no
   Claude-Session trailer, no emoji.
6. Print exactly PHASE_DONE <n> as your last line.

Rules:
- Never ask a question. If ambiguous, pick the most reasonable option, proceed, and
  record the decision and reasoning in the plan's DECISIONS section.
- If you cannot finish or verify, do NOT commit a half-phase. Print BLOCKED <reason>
  and stop.
- Do not start the next phase.
P

for i in $(seq 1 "$MAX_PHASES"); do
  LOG="$LOGS/lap-$(date +%Y%m%d-%H%M%S).jsonl"
  say "LAP $i start -> $LOG"

  # medium thinking budget for the child; opus explicitly, not inherited
  MAX_THINKING_TOKENS=10000 claude -p "$PROMPT" \
    --model opus \
    --output-format stream-json --verbose \
    --permission-mode "$PERM" > "$LOG" 2>&1
  RC=$?

  # surface the agent's own markers, in the order it wrote them
  grep -o 'PHASE_START [0-9]*\|PHASE_VERIFY [0-9]*\|PHASE_DONE [0-9]*\|ALL_PHASES_COMPLETE\|BLOCKED[^"]\{0,120\}' "$LOG" \
    | awk '!seen[$0]++' | while read -r m; do say "  $m"; done

  if grep -qi 'usage limit\|rate_limit_error' "$LOG"; then
    say "STOP: usage limit ($LOG)"; exit 2
  fi
  if [ $RC -ne 0 ]; then say "STOP: claude exited $RC ($LOG)"; exit $RC; fi
  if grep -q 'BLOCKED' "$LOG"; then say "STOP: agent blocked ($LOG)"; exit 3; fi
  if grep -q 'ALL_PHASES_COMPLETE' "$LOG"; then say "ALL PHASES COMPLETE"; exit 0; fi
  if ! git diff --quiet HEAD; then say "STOP: uncommitted changes left ($LOG)"; exit 4; fi

  say "LAP $i committed: $(git log -1 --format=%s)"
done
say "STOP: hit MAX_PHASES=$MAX_PHASES"
