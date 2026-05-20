// Simple in-memory model registry + TTL cache for Kiro models
// Provides getModelInfo(modelId) and refresh() to populate cache from upstream.

type ModelInfo = {
  id: string;
  description?: string;
  raw?: any;
};

const CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes
let cache: Map<string, ModelInfo> | null = null;
let lastFetch = 0;

async function fetchModelsFromUpstream(fetchFn: typeof fetch = globalThis.fetch) {
  // Best-effort: try common Kiro/Bedrock style endpoints; falling back to empty
  // This function is intentionally tolerant to avoid hard failures in environments
  // where upstream discovery is unavailable.
  const candidates = [
    "/models",
    "https://api.kiro.example.com/models",
    "https://bedrock.amazonaws.com/models",
  ];
  for (const url of candidates) {
    try {
      const res = await fetchFn(url, { method: "GET" });
      if (!res.ok) continue;
      const json = await res.json();
      const m = new Map<string, ModelInfo>();
      if (Array.isArray(json)) {
        for (const item of json) {
          const id = (item && (item.id || item.modelId || item.name)) || String(item);
          m.set(id, { id, description: item.description || item.summary || undefined, raw: item });
        }
      } else if (json && typeof json === "object") {
        // support { models: [...] }
        const list = Array.isArray((json as any).models) ? (json as any).models : [];
        for (const item of list) {
          const id = (item && (item.id || item.modelId || item.name)) || String(item);
          m.set(id, { id, description: item.description || item.summary || undefined, raw: item });
        }
      }
      if (m.size > 0) return m;
    } catch (_err) {
      // ignore and try next
    }
  }
  return new Map<string, ModelInfo>();
}

export async function refreshModelCache() {
  try {
    const models = await fetchModelsFromUpstream();
    cache = models;
    lastFetch = Date.now();
    return cache;
  } catch (_err) {
    return cache || new Map<string, ModelInfo>();
  }
}

export async function getModelInfo(id: string) {
  if (!cache || Date.now() - lastFetch > CACHE_TTL_MS) {
    await refreshModelCache();
  }
  if (!cache) return { id };
  return cache.get(id) || { id };
}

export function clearModelCache() {
  cache = null;
  lastFetch = 0;
}

export default { getModelInfo, refreshModelCache, clearModelCache };
