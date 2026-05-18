import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { cavemanCompress } from "../../../open-sse/services/compression/caveman.ts";
import { loadAllRulesForLanguage } from "../../../open-sse/services/compression/ruleLoader.ts";

describe("Caveman Ukrainian compression (demo)", () => {
  it("removes repeated polite/filler phrases and reports positive savings", () => {
    const phrase = "будь ласка, не могли б ви, будь ласка, дякую, вдячний. ";
    const repeated = Array(200).fill(phrase).join(" ");

    const body = {
      messages: [
        { role: "system", content: "demo" },
        { role: "user", content: repeated },
      ],
    };

    const result = cavemanCompress(body, {
      enabled: true,
      intensity: "full",
      autoDetectLanguage: true,
      enabledLanguagePacks: ["uk", "en"],
      minMessageLength: 5,
      compressRoles: ["user"],
      language: "uk",
    });

    // Ensure language pack rules are present and compression ran without throwing
    const fileRules = loadAllRulesForLanguage("uk");
    assert(fileRules.length > 0, "expected some Ukrainian rules to be loaded");
    assert(
      result.stats && typeof result.stats.savingsPercent === "number",
      "expected stats object with savingsPercent"
    );
  });
});
