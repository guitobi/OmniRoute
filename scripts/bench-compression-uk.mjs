import { cavemanCompress } from "../open-sse/services/compression/caveman.ts";
import { estimateCompressionTokens } from "../open-sse/services/compression/stats.ts";

function generateSample(idx) {
  // realistic distribution: 20% very long multi-turn, 50% medium, 30% short
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
    // very long multi-turn: include previous context and repeated asks
    const context = Array(3)
      .fill(0)
      .map((_, i) => `Попередній меседж ${i + 1}: ${boilerplates[i % boilerplates.length]}`)
      .join("\n");
    const ask = boilerplates[idx % boilerplates.length] + " " + randomPolite(3);
    const repeated = Array(5)
      .fill(boilerplates[idx % boilerplates.length])
      .join(" ");
    return `${context}\n\n${ask}\n\n${repeated}`;
  }

  if (rand < 0.7) {
    // medium length
    const main = boilerplates[idx % boilerplates.length];
    return `${randomPolite(Math.floor(Math.random() * 2))}${main} ${randomPolite(Math.floor(Math.random() * 2))}`.trim();
  }

  // short
  return `${randomPolite(1)} Коротке питання: ${boilerplates[idx % boilerplates.length].split(".")[0]}.`;
}

async function runBench({ samples = 1000, intensity = "full" } = {}) {
  let totalOriginalTokens = 0;
  let totalCompressedTokens = 0;
  const perSample = [];

  for (let i = 0; i < samples; i++) {
    const text = generateSample(i);
    const body = { messages: [{ role: "user", content: text }] };
    const result = cavemanCompress(body, {
      enabled: true,
      intensity,
      autoDetectLanguage: true,
      enabledLanguagePacks: ["uk", "en"],
      minMessageLength: 5,
      compressRoles: ["user"],
      language: /[\u0400-\u04FF]/.test(text) ? "uk" : "en",
    });

    const origTokens = estimateCompressionTokens(text);
    const compTokens = estimateCompressionTokens(
      (result.body.messages[0].content || "").toString()
    );
    totalOriginalTokens += origTokens;
    totalCompressedTokens += compTokens;
    perSample.push({
      origTokens,
      compTokens,
      savings: origTokens > 0 ? (origTokens - compTokens) / origTokens : 0,
    });
  }

  const avgSavings =
    totalOriginalTokens > 0
      ? (totalOriginalTokens - totalCompressedTokens) / totalOriginalTokens
      : 0;
  const sorted = perSample.map((s) => s.savings).sort((a, b) => b - a);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;

  console.log(`Samples: ${samples}`);
  console.log(`Total original tokens: ${totalOriginalTokens}`);
  console.log(`Total compressed tokens: ${totalCompressedTokens}`);
  console.log(`Avg savings: ${(avgSavings * 100).toFixed(2)}%`);
  console.log(`Median savings: ${(p50 * 100).toFixed(2)}%`);
  console.log(`P90 savings: ${(p90 * 100).toFixed(2)}%`);
}

const samples = parseInt(process.env.SAMPLES || "1000", 10) || 1000;
const intensity = process.env.INTENSITY || "full";

runBench({ samples, intensity }).catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
