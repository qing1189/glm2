const UA_VERSION = '120.0.0.0';
const UA_MAJOR = '120';

const BROWSER_HEADERS = {
  'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${UA_VERSION} Safari/537.36`,
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'origin': 'https://chat.z.ai',
  'referer': 'https://chat.z.ai/',
  'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${UA_MAJOR}", "Google Chrome";v="${UA_MAJOR}"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

let proxyDispatcher = null;

async function getDispatcher() {
  if (proxyDispatcher !== null) return proxyDispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) {
    proxyDispatcher = false;
    return false;
  }
  try {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(proxyUrl);
    console.log(`Proxy enabled: ${proxyUrl}`);
    return proxyDispatcher;
  } catch (e) {
    console.warn(`Failed to init proxy (${proxyUrl}): ${e.message}`);
    proxyDispatcher = false;
    return false;
  }
}

export function requestHeaders(extra = {}) {
  return { ...BROWSER_HEADERS, ...extra };
}

export function apiHeaders(token, extra = {}) {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'accept': '*/*',
    'cookie': `token=${token}`,
    ...BROWSER_HEADERS,
    ...extra,
  };
}

export function streamHeaders(token, extra = {}) {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'cookie': `token=${token}`,
    ...BROWSER_HEADERS,
    ...extra,
  };
}

export function loginHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'accept': '*/*',
    ...BROWSER_HEADERS,
    ...extra,
  };
}

export async function proxiedFetch(url, options = {}) {
  const dispatcher = await getDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  return fetch(url, options);
}
