#!/usr/bin/env bash
# One plan phase per `claude -p` invocation. Fresh process == context clear.
# Exits the whole loop on block, error, or usage limit.
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS=.loop-logs
PROG="$LOGS/progress.log"
MAX_PHASES=${MAX_PHASES:-12}
# which plan is being walked; every lap edits this file and nothing else
PLAN=${PLAN:-docs/demo-add-flow-plan.md}
# how the child runs; override to acceptEdits if you'd rather approve bash yourself
PERM=${PERM:-bypassPermissions}
mkdir -p "$LOGS"
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$PROG"; }

read -r -d '' PROMPT <<'P'
You are running one phase of a plan, unattended. Nobody can answer you.

Plan file: __PLAN__  (the ONLY plan file you edit)

Do exactly this, in order:
1. Read section 5 PHASING and the VERIFICATION LOG. Find the LOWEST-numbered phase
   not marked DONE. If every phase is DONE, print exactly ALL_PHASES_COMPLETE and
   stop without changing anything. Otherwise print exactly PHASE_START <n> before
   you begin building.
2. Build that phase, and only that phase.
3. Print exactly PHASE_VERIFY <n>, then verify BY WHATEVER METHOD THE PHASE ITSELF
   SPECIFIES — tests, a measuring script, a browser walk. Read the phase; do not
   assume. Fix and re-verify on failure.
   If the phase calls for a browser, use the firefox-devtools MCP tools against
   http://localhost:3002 (start `npm run dev` in the background first if nothing is
   listening there). The guest recipe is: POST /api/demo/start from the page, then
   /c/<configId>/eval. A phase that says to verify on a REAL account means a
   logged-in non-guest workspace, not a guest.
4. Append a VERIFICATION LOG entry and mark the phase DONE in section 5 with
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

PROMPT=${PROMPT//__PLAN__/$PLAN}
[ -f "$PLAN" ] || { say "STOP: no plan file at $PLAN"; exit 5; }

for i in $(seq 1 "$MAX_PHASES"); do
  LOG="$LOGS/lap-$(date +%Y%m%d-%H%M%S).jsonl"
  say "LAP $i start -> $LOG"

  # medium thinking budget for the child; opus explicitly, not inherited
  MAX_THINKING_TOKENS=10000 claude -p "$PROMPT" \
    --model opus \
    --output-format stream-json --verbose \
    --permission-mode "$PERM" > "$LOG" 2>&1
  RC=$?

  # Verdict comes from the FINAL result message only. Scanning the whole transcript
  # false-trips: the prompt echo and the agent's own code comments contain these words.
  FINAL=$(python3 - "$LOG" <<'PY'
import json, sys
res = None
for line in open(sys.argv[1], errors="replace"):
    line = line.strip()
    if not line.startswith("{"): continue
    try: d = json.loads(line)
    except Exception: continue
    if d.get("type") == "result": res = d
print((res or {}).get("result", "") if res else "")
PY
)
  # markers the agent declared in its answer
  grep -oE 'PHASE_START [0-9]+|PHASE_VERIFY [0-9]+|PHASE_DONE [0-9]+|ALL_PHASES_COMPLETE' <<<"$FINAL" \
    | awk '!seen[$0]++' | while read -r m; do say "  $m"; done

  # structured field, so safe to scan the whole transcript
  if grep -q '"status":"rejected"\|"status":"blocked"' "$LOG" \
     || grep -qi 'usage limit reached\|rate_limit_error' <<<"$FINAL"; then
    say "STOP: usage limit ($LOG)"; exit 2
  fi
  if [ $RC -ne 0 ]; then say "STOP: claude exited $RC ($LOG)"; exit $RC; fi
  if grep -qE '(^|[[:space:]])BLOCKED([[:space:]]|$)' <<<"$FINAL"; then
    say "STOP: agent blocked ($LOG)"; exit 3
  fi
  if grep -q 'ALL_PHASES_COMPLETE' <<<"$FINAL"; then say "ALL PHASES COMPLETE"; exit 0; fi
  if ! git diff --quiet HEAD; then say "STOP: uncommitted changes left ($LOG)"; exit 4; fi

  say "LAP $i committed: $(git log -1 --format=%s)"

  # graceful pause: `touch .loop-logs/PAUSE` any time; the current phase finishes
  # and commits, then the loop stops instead of starting the next one.
  if [ -e "$LOGS/PAUSE" ]; then
    rm -f "$LOGS/PAUSE"; say "STOP: paused by request after lap $i"; exit 0
  fi
done
say "STOP: hit MAX_PHASES=$MAX_PHASES"
