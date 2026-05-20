import { estimateCompressionTokens } from "../open-sse/services/compression/stats.ts";
import { cavemanCompress } from "../open-sse/services/compression/caveman.ts";
import { loadAllRulesForLanguage } from "../open-sse/services/compression/ruleLoader.ts";
import { applyRulesToText } from "../open-sse/services/compression/caveman.ts";

const intensity = process.env.INTENSITY || "full";
const repeats = parseInt(process.env.REPEATS || "1", 10) || 1;

const samples = [
  // Demo sample with repeated polite/filler phrases to show visible savings
  `Будь ласка, будь ласка, будь ласка, будь ласка, дякую, дякую, дякую. Можливо, ви могли б, будь ласка, надати приклад? Я був би дуже вдячний, будь ласка.`,
  `Привіт! Не могли б ви, будь ласка, пояснити детально, як правильно налаштувати цей модуль? Я б дуже вдячний за приклад. Будь ласка, опишіть кроки максимально детально, можливо декілька прикладів та пояснень. Дякую заздалегідь.`,
  `Доброго дня! Я хочу отримати повну інструкцію з прикладами, поясненнями та кроками для налаштування середовища. Будь ласка, надайте детальну інструкцію з командами та прикладами конфігурації. Дякую.`,
];

for (const sample of samples) {
  const localRepeats = samples.indexOf(sample) === 0 ? Math.max(repeats, 30) : repeats;
  const longSample = Array(localRepeats).fill(sample).join("\n\n");
  const body = {
    messages: [
      { role: "system", content: "compress-demo" },
      { role: "user", content: longSample },
    ],
  };

  const options = {
    enabled: true,
    intensity,
    autoDetectLanguage: true,
    enabledLanguagePacks: ["uk", "en"],
    minMessageLength: 5,
    compressRoles: ["user"],
    preservePatterns: [],
    skipRules: [],
  };
  // If text contains Cyrillic, prefer Ukrainian language pack to ensure rules load
  if (/[\u0400-\u04FF]/.test(longSample)) {
    options.language = "uk";
  }

  const result = cavemanCompress(body, options);
  // Debug: string lengths and token estimates

  const originalStr = longSample;
  const compressedStr = (result.body.messages[1].content || "").toString();
  console.log("Original length:", originalStr.length, "Compressed length:", compressedStr.length);
  console.log(
    "Original est tokens:",
    estimateCompressionTokens(originalStr),
    "Compressed est tokens:",
    estimateCompressionTokens(compressedStr)
  );

  // Diagnostic: list loaded rules for 'uk' and check matches
  const fileRules = loadAllRulesForLanguage("uk");
  console.log(
    `Loaded ${fileRules.length} Ukrainian rules (showing first 10 names):`,
    fileRules.slice(0, 10).map((r) => r.name)
  );
  const debugApplied = applyRulesToText(longSample, fileRules);
  console.log("Diagnostic appliedRules:", debugApplied.appliedRules);
  // Per-rule match preview
  for (const rule of fileRules) {
    try {
      const re = rule.pattern;
      re.lastIndex = 0;
      const m = re.exec(longSample);
      if (m) console.log(`Rule '${rule.name}' matched:`, m[0].slice(0, 100));
      else console.log(`Rule '${rule.name}' did not match.`);
    } catch (err) {
      console.log(
        `Rule '${rule.name}' test error:`,
        err && err.message ? err.message : String(err)
      );
    }
  }

  console.log("\n=== Sample (truncated 200 chars) ===\n", longSample.slice(0, 200), "...\n");
  console.log(
    "--- Compressed (truncated 200 chars) ---\n",
    (result.body.messages[1].content || "").toString().slice(0, 200),
    "...\n"
  );
  console.log("--- Stats ---\n", JSON.stringify(result.stats, null, 2));
  if (result.stats && typeof result.stats.originalTokens === "number") {
    console.log(`Original tokens: ${result.stats.originalTokens}`);
    console.log(`Compressed tokens: ${result.stats.compressedTokens}`);
    console.log(`Savings: ${result.stats.savingsPercent}%`);
  }
}
