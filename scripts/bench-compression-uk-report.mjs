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
    const repeated = Array(5)
      .fill(boilerplates[idx % boilerplates.length])
      .join(" ");
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

async function runReport({ samples = 1000, intensity = "full" } = {}) {
  const rows = [];
  let totalOrig = 0;
  let totalComp = 0;

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
    const compText = (result.body.messages[0].content || "").toString();
    const compTokens = estimateCompressionTokens(compText);
    totalOrig += origTokens;
    totalComp += compTokens;
    rows.push({
      i,
      text,
      compText,
      origTokens,
      compTokens,
      savings: origTokens > 0 ? (origTokens - compTokens) / origTokens : 0,
    });
  }

  const avg = totalOrig > 0 ? (totalOrig - totalComp) / totalOrig : 0;
  rows.sort((a, b) => b.savings - a.savings);
  const top = rows.slice(0, 10);

  console.log(`Samples: ${samples}`);
  console.log(`Total original tokens: ${totalOrig}`);
  console.log(`Total compressed tokens: ${totalComp}`);
  console.log(`Avg savings: ${(avg * 100).toFixed(2)}%`);

  console.log("\nTop 10 samples by savings:");
  top.forEach((r, idx) => {
    console.log(
      `\n#${idx + 1} - Savings ${(r.savings * 100).toFixed(2)}% (orig ${r.origTokens} -> comp ${r.compTokens})`
    );
    console.log("Original:\n" + r.text.replace(/\n/g, "\n"));
    console.log("\nCompressed:\n" + r.compText.replace(/\n/g, "\n"));
  });
}

const samples = parseInt(process.env.SAMPLES || "1000", 10) || 1000;
const intensity = process.env.INTENSITY || "full";

runReport({ samples, intensity }).catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
