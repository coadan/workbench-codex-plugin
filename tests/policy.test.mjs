import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan, validateReview } from "../scripts/policy.mjs";

test("plans and reviews require concrete evidence for the current state", () => {
  const plan =
    "## Objective\nDeliver the change.\n## Steps\n- [x] Implement the behavior.\n## Acceptance\n- [ ] Prove the outcome.\n";
  validatePlan(plan);
  assert.throws(() => validatePlan(plan, true), /Complete/);
  assert.throws(
    () => validatePlan(plan.replace("Implement", "TODO")),
    /concrete/,
  );
  const receipt = { tree: "checked-tree", base: "checked-base" };
  const review =
    "Tree: checked-tree\nBase: checked-base\nResult: pass\nReviewed retry handling and confirmed scoped data is preserved.";
  validateReview(review, receipt);
  assert.throws(
    () => validateReview(review, { ...receipt, base: "new-main" }),
    /Base/,
  );
});
