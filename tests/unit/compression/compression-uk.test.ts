import test from "node:test";
import assert from "node:assert/strict";

const { loadAllRulesForLanguage } =
  await import("../../../open-sse/services/compression/ruleLoader.ts");
const { applyRulesToText } = await import("../../../open-sse/services/compression/caveman.ts");

test("Ukrainian Caveman pack loads and applies to sample text", () => {
  const rules = loadAllRulesForLanguage("uk");
  assert.ok(Array.isArray(rules), "rules should be an array");
  assert.ok(rules.length > 0, "uk rules should be present");

  const sample = "Привіт! Не могли б ви, будь ласка, пояснити? Дякую заздалегідь.";
  const result = applyRulesToText(sample, rules);

  // Expect some rules to apply and text to change
  assert.notStrictEqual(result.text, sample, "text should be compressed/changed");
  const applied = result.appliedRules || [];
  assert.ok(
    applied.includes("greetings_uk") ||
      applied.includes("polite_framing_uk") ||
      applied.includes("pleasantries_uk"),
    `expected uk rules applied, got: ${applied.join(",")}`
  );
});
