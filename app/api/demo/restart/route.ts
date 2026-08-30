// API route: POST /api/demo/restart — put a guest's Eval board back to empty.
//
// The one destructive button the demo offers, and it destroys only what the
// visitor themselves put there: lib/demo/restart.ts spells out what goes and
// what stays. Guest-only — a real account pressing this (there is no UI for it)
// would be asking to delete their own eval board, and the answer is no.
//
// It SPENDS NOTHING, so it is deliberately not in DEMO_ACTIONS: the demo gate is
// about the operator's provider keys, and this route calls no provider. What
// stands in for it is restartGuestBoard's own isGuest() check, which is why the
// route can answer 403 from a null rather than catching a throw.
import { withRequestConfig } from "@/lib/http/configScope";
import { restartGuestBoard } from "@/lib/demo/restart";

export async function POST(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const report = await restartGuestBoard();
      if (report === null) {
        return Response.json(
          { error: "Start over is part of the demo, and this is not a demo workspace." },
          { status: 403 },
        );
      }
      return Response.json(report);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to reset the board.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
