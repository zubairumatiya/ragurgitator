// Appraise index — no content of its own. Appraise is a section of peer pages
// (Costs / Semantic caching / Config metrics, see AppraiseNav), so bare
// /appraise bounces to the first tab rather than duplicating one of them.
//
// This is now only a fallback for hand-typed URLs and old links: the pinned
// "📊 Appraise" tab in ConfigTabs links straight at the landing leaf, because a
// redirect-only route is unprefetchable and cost an extra blocking round trip
// on every click. Both read the same constant.
import { redirect } from "next/navigation";
import { APPRAISE_LANDING_HREF } from "@/app/components/appraiseTabs";

export default function AppraisePage() {
  redirect(APPRAISE_LANDING_HREF);
}
