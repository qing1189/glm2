import { apiHeaders, loginHeaders, proxiedFetch } from './src/headers.js';

const BASE_URL = 'https://chat.z.ai';
const MAX_CONCURRENT_PER_TOKEN = 5;
const MAX_ERROR_COUNT = 3;
const TOKEN_DEAD_THRESHOLD = 5;

function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return null; }
}

function isTokenExpired(token) {
  const decoded = decodeJWT(token);
  if (!decoded?.exp) return false; // No exp claim = does not expire
  return decoded.exp * 1000 < Date.now() + 5 * 60 * 1000;
}

const accountPool = [];

export function loadAccounts() {
  const accountsStr = process.env.GLM_ACCOUNTS?.trim();
  const tokensStr = process.env.GLM_TOKENS?.trim();

  if (accountsStr) {
    for (const entry of accountsStr.split(',')) {
      const [email, ...passParts] = entry.trim().split(':');
      const password = passParts.join(':');
      if (email && password) {
        accountPool.push({ email, password, token: null, expiresAt: 0, errorCount: 0, activeRequests: 0, dead: false, captchaBlocked: false });
      }
    }
  }

  if (tokensStr) {
    for (const token of tokensStr.split(',').map(t => t.trim()).filter(Boolean)) {
      const decoded = decodeJWT(token);
      accountPool.push({
        email: decoded?.email || decoded?.id || 'token-user',
        password: null,
        token,
        expiresAt: decoded?.exp ? decoded.exp * 1000 : null,
        errorCount: 0,
        activeRequests: 0,
        dead: false,
        captchaBlocked: false,
      });
    }
  }

  if (accountPool.length === 0) {
    console.warn('[glm-auth] No GLM_ACCOUNTS or GLM_TOKENS configured — please add via admin panel or .env file');
  }

  return accountPool;
}

async function login(email, password) {
  const res = await proxiedFetch(`${BASE_URL}/api/v1/auths/signin`, {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (json.token) return json.token;

  const entry = accountPool.find(t => t.email === email);
  if (json.detail?.includes('captcha') || json.captcha || json.enable_captcha) {
    if (entry) entry.captchaBlocked = true;
    throw new Error(`Login blocked by CAPTCHA for ${email}`);
  }
  throw new Error(`Login failed for ${email}: ${JSON.stringify(json)}`);
}

async function ensureToken(entry) {
  if (entry.token && !isTokenExpired(entry.token)) return entry.token;

  if (!entry.password) {
    entry.errorCount++;
    if (entry.errorCount >= TOKEN_DEAD_THRESHOLD) entry.dead = true;
    throw new Error(`Token expired for ${entry.email}, no password to refresh`);
  }

  try {
    entry.token = await login(entry.email, entry.password);
    const decoded = decodeJWT(entry.token);
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    entry.dead = false;
    console.log(`  Logged in: ${entry.email}, token expires ${new Date(entry.expiresAt).toISOString()}`);
    return entry.token;
  } catch (err) {
    entry.errorCount++;
    if (entry.errorCount >= TOKEN_DEAD_THRESHOLD) entry.dead = true;
    throw err;
  }
}

export async function initAccountPool() {
  console.log(`Account pool: ${accountPool.length} account(s), max ${MAX_CONCURRENT_PER_TOKEN} concurrent each`);
  for (const entry of accountPool) {
    if (entry.captchaBlocked) {
      console.warn(`  CAPTCHA blocked: ${entry.email} — login skipped, using pre-seeded token if available`);
      continue;
    }
    try {
      await ensureToken(entry);
    } catch (err) {
      console.warn(`  Failed to init ${entry.email}: ${err.message}`);
    }
  }
}

export function acquireToken() {
  let candidates = accountPool.filter(t => !t.dead && t.errorCount < MAX_ERROR_COUNT && t.activeRequests < MAX_CONCURRENT_PER_TOKEN && t.token);

  if (candidates.length === 0) {
    candidates = accountPool.filter(t => !t.dead && t.activeRequests < MAX_CONCURRENT_PER_TOKEN && t.token);
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.activeRequests - b.activeRequests);
  const chosen = candidates[0];
  chosen.activeRequests++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenError(token) {
  const entry = accountPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount++;
  if (entry.errorCount >= TOKEN_DEAD_THRESHOLD) entry.dead = true;

  if (entry.password && !entry.captchaBlocked) {
    ensureToken(entry).catch(() => {});
  }
}

export function reportTokenSuccess(token) {
  const entry = accountPool.find(t => t.token === token);
  if (entry) {
    entry.errorCount = 0;
    entry.dead = false;
  }
}

export async function refreshToken(entry) {
  return ensureToken(entry);
}

export function getPoolInfo() {
  return accountPool.map(t => ({
    email: t.email,
    hasToken: !!t.token,
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    dead: t.dead,
    captchaBlocked: t.captchaBlocked,
    maxConcurrent: MAX_CONCURRENT_PER_TOKEN,
  }));
}

export function getTotalCapacity() {
  return accountPool.filter(t => !t.dead && t.token).length * MAX_CONCURRENT_PER_TOKEN;
}
