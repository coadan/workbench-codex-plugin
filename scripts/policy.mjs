export function validatePlan(source, complete = false) {
  for (const heading of ["Objective", "Steps", "Acceptance"]) {
    const match = source.match(
      new RegExp(
        `^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
        "m",
      ),
    );
    if (!match || !match[1].trim())
      throw new Error(`Fill the ${heading} section in the task plan.`);
    if (heading === "Objective") {
      if (/\b(TODO|TBD)\b/.test(match[1]))
        throw new Error("Write a concrete task objective.");
    } else {
      const boxes = [...match[1].matchAll(/^\s*- \[([ xX])\] (.+)$/gm)];
      if (
        !boxes.length ||
        boxes.some(([, , text]) => /\b(TODO|TBD)\b/.test(text))
      )
        throw new Error(
          `Write concrete ${heading.toLowerCase()} in the task plan.`,
        );
      if (complete && boxes.some(([, state]) => state === " "))
        throw new Error(
          `Complete the ${heading.toLowerCase()} in the task plan before landing.`,
        );
    }
  }
}

export function validateReview(source, receipt) {
  for (const [label, value] of [
    ["Tree", receipt.tree],
    ["Base", receipt.base],
    ["Result", "pass"],
  ]) {
    if (
      !source.split("\n").some((line) => line.trim() === `${label}: ${value}`)
    )
      throw new Error(
        `Record a local review of the current checked state in review.md: ${label}: ${value}`,
      );
  }
  const summary = source
    .split("\n")
    .filter((line) => !/^(Tree|Base|Result):/.test(line))
    .join("\n")
    .trim();
  if (summary.length < 20 || /\b(TODO|TBD)\b/.test(summary))
    throw new Error(
      "Record the review findings and their resolution in review.md.",
    );
}
