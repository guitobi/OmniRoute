import { processRtkText } from "../open-sse/services/compression/engines/rtk/index.ts";
import { cavemanCompress } from "../open-sse/services/compression/caveman.ts";
import { estimateCompressionTokens } from "../open-sse/services/compression/stats.ts";

function generateSample(idx) {
  const rand = Math.random();
  const boilerplates = [
    "Доброго дня! Я стикаюся з проблемою в продакшн-середовищі і потребую покрокової інструкції. Якщо можна — з прикладами команд і конфігурації.",
    "Привіт. Після оновлення залежностей процес збірки падає з помилкою. Лог додаю нижче. Прошу підказати причину і можливі рішення.",
    "Потрібно оптимізувати кешування, зменшити затримку при пикових навантаженнях. Поясніть стратегії і приклади конфігурації.",
    "Планую розгортання на Kubernetes з горизонтальним масштабуванням. Які налаштування readiness/liveness, resources, autoscaling варто використати?",
  ];

  const politeFragments = [
    "будь ласка",
    "дякую",
    "не могли б ви",
    "я дуже вдячний",
    "якщо не складно",
  ];

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
      .map((_, i) => `Попередній меседж ${i + 1}: ${boilerplates[i % boilerplates.length]}`)
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

  return `${randomPolite(1)} Коротке питання: ${boilerplates[idx % boilerplates.length].split(".")[0]}.`;
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
      enabledLanguagePacks: ["uk", "en"],
      compressRoles: ["user"],
    });
    // Second Caveman pass (lossy) to squeeze further savings for experiments
    const cavRes2 = cavemanCompress(
      { messages: [{ role: "user", content: cavRes.body.messages[0].content }] },
      {
        enabled: true,
        intensity: "ultra",
        autoDetectLanguage: true,
        enabledLanguagePacks: ["uk", "en"],
        compressRoles: ["user"],
        preservePatterns: [],
      }
    );
    const finalText = cavRes2.body.messages[0].content;
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
