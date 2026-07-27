// Appraise index — no content of its own. Appraise is a section of peer pages
// (Costs / Semantic caching / Config metrics, see AppraiseNav), so bare
// /appraise bounces to the first tab rather than duplicating one of them. The
// pinned "📊 Appraise" tab in ConfigTabs still points here, so the landing tab
// is changed in one place.
import { redirect } from "next/navigation";

export default function AppraisePage() {
  redirect("/appraise/costs");
}
