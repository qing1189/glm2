import { apiHeaders, proxiedFetch } from './src/headers.js';

const BASE_URL = 'https://chat.z.ai';
let cachedModels = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000;

const SUFFIX_MAP = {
  'think': '-thinking',
  'vision': '-vision',
  'web_search': '-search',
  'free_think': '-free-think',
  'mcp': '-mcp',
  'agent_mode': '-agent',
  'file_qa': '-file-qa',
};

async function fetchModels(token) {
  const res = await proxiedFetch(`${BASE_URL}/api/models`, {
    headers: apiHeaders(token),
  });
  const json = await res.json();
  return json.data || [];
}

export async function getModels(token) {
  if (cachedModels && Date.now() - cacheTime < CACHE_TTL) return cachedModels;
  cachedModels = await fetchModels(token);
  cacheTime = Date.now();
  return cachedModels;
}

export function clearModelCache() {
  cachedModels = null;
  cacheTime = 0;
}

export function handleOpenAIModels(modelList) {
  const variants = [];

  for (const m of modelList) {
    const caps = m.info?.meta?.capabilities || {};
    const base = { object: 'model', created: 1700000000, owned_by: 'zhipu' };

    variants.push({ id: m.id, ...base });

    for (const [capKey, suffix] of Object.entries(SUFFIX_MAP)) {
      if (caps[capKey]) {
        variants.push({ id: m.id + suffix, ...base });
      }
    }
  }

  return { object: 'list', data: variants };
}
