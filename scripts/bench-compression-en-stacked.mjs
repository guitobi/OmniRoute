import { processRtkText } from "../open-sse/services/compression/engines/rtk/index.ts";
import { cavemanCompress } from "../open-sse/services/compression/caveman.ts";
import { estimateCompressionTokens } from "../open-sse/services/compression/stats.ts";

function generateSample(idx) {
  const rand = Math.random();
  const boilerplates = [
    "Hello! I'm encountering an issue in production and need step-by-step guidance, including example commands and configuration.",
    "Hi. After updating dependencies the build process fails with an error. I'm attaching the log below. Please suggest causes and fixes.",
    "We need to optimize caching to reduce latency during peak load. Outline strategies and configuration examples.",
    "Planning a Kubernetes deployment with horizontal autoscaling. What readiness/liveness, resources, and autoscaling settings should I use?",
  ];

  const politeFragments = ["please", "thanks", "could you", "I'd appreciate it", "if possible"];

  function randomPolite(repeat = 1) {
    return (
      Array(repeat)
        .fill(0)
        .map(() => politeFragments[Math.floor(Math.random() * politeFragments.length)])
        .join(", ") + (repeat ? ". " : "")
    );
  }

  if (rand < 0.2) {
    const context = Array(3)
      .fill(0)
      .map((_, i) => `Previous message ${i + 1}: ${boilerplates[i % boilerplates.length]}`)
      .join("\n");
    const ask = boilerplates[idx % boilerplates.length] + " " + randomPolite(3);
    const repeated = Array(20)
      .fill(boilerplates[idx % boilerplates.length])
      .join(" \n");
    return `${context}\n\n${ask}\n\n${repeated}`;
  }

  if (rand < 0.7) {
    const main = boilerplates[idx % boilerplates.length];
    return `${randomPolite(Math.floor(Math.random() * 2))}${main} ${randomPolite(
      Math.floor(Math.random() * 2)
    )}`.trim();
  }

  return `${randomPolite(1)} Short question: ${boilerplates[idx % boilerplates.length].split(".")[0]}.`;
}

async function runStacked({ samples = 1000 } = {}) {
  let origTotal = 0;
  let afterRtkTotal = 0;
  let afterStackTotal = 0;

  for (let i = 0; i < samples; i++) {
    const text = generateSample(i);
    const origTokens = estimateCompressionTokens(text);
    origTotal += origTokens;

    // RTK pass
    const rtk = processRtkText(text, {
      config: {
        intensity: "aggressive",
        applyToToolResults: true,
        applyToCodeBlocks: true,
        maxLinesPerResult: 200,
        maxCharsPerResult: 20000,
      },
    });
    afterRtkTotal += rtk.compressedTokens;

    // Caveman pass on RTK output
    const body = { messages: [{ role: "user", content: rtk.text }] };
    const cavRes = cavemanCompress(body, {
      enabled: true,
      intensity: "ultra",
      autoDetectLanguage: true,
      enabledLanguagePacks: ["en"],
      compressRoles: ["user"],
    });
    const finalText = cavRes.body.messages[0].content;
    const finalTokens = estimateCompressionTokens(finalText || "");
    afterStackTotal += finalTokens;
  }

  const rtkSavings = origTotal > 0 ? (origTotal - afterRtkTotal) / origTotal : 0;
  const stackedSavings = origTotal > 0 ? (origTotal - afterStackTotal) / origTotal : 0;

  console.log(`Samples: ${samples}`);
  console.log(`Original tokens: ${origTotal}`);
  console.log(`After RTK tokens: ${afterRtkTotal} (savings ${(rtkSavings * 100).toFixed(2)}%)`);
  console.log(
    `After RTK -> Caveman tokens: ${afterStackTotal} (combined savings ${(stackedSavings * 100).toFixed(2)}%)`
  );
}

const samples = parseInt(process.env.SAMPLES || "1000", 10) || 1000;
runStacked({ samples }).catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
