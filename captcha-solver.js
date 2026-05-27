import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomUUID, createHmac } from 'crypto';
import { existsSync, mkdirSync } from 'fs';

puppeteerExtra.use(StealthPlugin());

function getIsServer() {
  return process.env.GLM_SERVER_MODE === '1' || (process.platform === 'linux' && !process.env.DISPLAY);
}

function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return getIsServer() ? '/usr/bin/google-chrome' : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
}

function getUserDataDir() {
  if (process.env.USER_DATA_DIR) return process.env.USER_DATA_DIR;
  return getIsServer() ? '/root/glm-2api/edge-profile' : 'C:/Users/PC-1/glm-2api/edge-profile';
}

const SIGNATURE_KEY_PREFIX = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const FE_VERSION = '1.0.91';
const BASE_URL = 'https://chat.z.ai';

let browser = null;
let page = null;
let browserLock = false;

async function killBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    page = null;
  }
}

async function ensureBrowser() {
  if (browserLock) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!browserLock && browser) return page;
    }
    return null;
  }

  if (browser) {
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        page = pages[0];
        return page;
      }
    } catch {
      browser = null;
      page = null;
    }
  }

  browserLock = true;
  try {
    const IS_SERVER = getIsServer();
    const CHROME_PATH = getChromePath();
    const USER_DATA_DIR = getUserDataDir();
    if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--window-size=1280,800',
      '--disable-dev-shm-usage',
    ];
    if (IS_SERVER) {
      launchArgs.push('--disable-software-rasterizer');
    }

    browser = await puppeteerExtra.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: launchArgs,
      userDataDir: USER_DATA_DIR,
      ignoreDefaultArgs: ['--enable-automation'],
      protocolTimeout: 60000,
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const token = process.env.GLM_TOKENS?.split(',')[0]?.trim();
    if (token) {
      await page.setCookie({
        name: 'token',
        value: token,
        domain: 'chat.z.ai',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      });
      await page.evaluateOnNewDocument((t) => {
        localStorage.setItem('token', t);
      }, token);
    }

    await page.goto('https://chat.z.ai', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[captcha-solver] Browser initialized');
    return page;
  } catch (e) {
    console.error('[captcha-solver] Browser init failed:', e.message);
    await killBrowser();
    return null;
  } finally {
    browserLock = false;
  }
}

async function solveCaptchaFull(userMessage) {
  const p = await ensureBrowser();
  if (!p) return null;

  try {
    if (!p.url().includes('chat.z.ai')) {
      await p.goto('https://chat.z.ai', { waitUntil: 'networkidle2', timeout: 30000 });
    }
  } catch (e) {
    console.warn('[captcha-solver] Navigation failed:', e.message);
    await killBrowser();
    return null;
  }

  let interceptedReq = null;
  let handlerError = null;

  try {
    await p.setRequestInterception(true);
  } catch (e) {
    console.warn('[captcha-solver] Cannot set request interception:', e.message);
    await killBrowser();
    return null;
  }

  const handler = async (req) => {
    if (req.url().includes('v2/chat/completions') && req.postData()) {
      try {
        const body = JSON.parse(req.postData());
        if (body.captcha_verify_param && !interceptedReq) {
          interceptedReq = {
            url: req.url(),
            headers: { ...req.headers() },
            body,
          };
          console.log('[captcha-solver] Intercepted browser completion request with captcha param');
          try { await req.abort(); } catch {}
          return;
        }
      } catch {}
    }
    req.continue();
  };
  p.on('request', handler);

  const probeMessage = userMessage || ('probe ' + randomUUID().slice(0, 6));
  const msgToType = probeMessage.length > 500 ? probeMessage.slice(0, 500) : probeMessage;

  // Navigate to a fresh chat page
  try {
    await p.goto('https://chat.z.ai', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.warn('[captcha-solver] Navigation failed:', e.message);
  }

  try {
    const textarea = await p.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
    await textarea.click();
    await p.keyboard.down('Control');
    await p.keyboard.press('a');
    await p.keyboard.up('Control');
    await p.keyboard.press('Backspace');
    await p.keyboard.type(msgToType, { delay: 20 });
    await p.keyboard.press('Enter');
  } catch (e) {
    console.warn('[captcha-solver] Cannot find textarea:', e.message);
    p.off('request', handler);
    try { await p.setRequestInterception(false); } catch {}
    // Reset browser state for next attempt
    await killBrowser();
    return null;
  }

  // Poll for intercepted request
  for (let i = 0; i < 60; i++) {
    if (interceptedReq) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  p.off('request', handler);
  try { await p.setRequestInterception(false); } catch {}

  if (interceptedReq) {
    console.log('[captcha-solver] Got intercepted request with captcha param');
    return interceptedReq;
  }

  console.warn('[captcha-solver] Captcha solve timeout');
  return null;
}

async function getFreshToken(envToken) {
  const res = await fetch(BASE_URL + '/api/v1/auths/', {
    headers: {
      'authorization': `Bearer ${envToken}`,
      'cookie': `token=${envToken}`,
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.token || null;
}

async function solveCaptcha() {
  const result = await solveCaptchaFull();
  if (!result) return null;
  return {
    captchaParam: result.body.captcha_verify_param,
    freshToken: result.headers['authorization']?.replace('Bearer ', '') || null,
    cookieToken: (result.headers['cookie'] || '').match(/token=([^;]+)/)?.[1] || null,
  };
}

function generateSignature(sortedPayload, messageContent, timestamp) {
  const i = Number(timestamp);
  const encoder = new TextEncoder();
  const encoded = encoder.encode(messageContent);
  const CHUNK = 32768;
  let d = '';
  for (let k = 0; k < encoded.length; k += CHUNK) {
    const chunk = encoded.slice(k, k + CHUNK);
    d += String.fromCharCode.apply(null, Array.from(chunk));
  }
  const p = Buffer.from(d, 'binary').toString('base64');
  const h = sortedPayload + '|' + p + '|' + timestamp;
  const v = Math.floor(i / (5 * 60 * 1000));
  const m = createHmac('sha256', SIGNATURE_KEY_PREFIX + v).digest();
  const signature = createHmac('sha256', m).update(h).digest('hex');
  return { signature, timestamp };
}

function buildSignaturePayload(token, userId, messageContent) {
  const timestamp = String(Date.now());
  const requestId = randomUUID();

  const payload = {
    timestamp, requestId, user_id: userId || '',
    version: FE_VERSION, platform: 'web', token,
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    language: 'en-US', languages: 'en-US,en', timezone: 'Asia/Shanghai',
    cookie_enabled: 'true', screen_width: '1920', screen_height: '1080',
    screen_resolution: '1920x1080', viewport_height: '800', viewport_width: '1280',
    viewport_size: '1280x800', color_depth: '32', pixel_ratio: '1',
    current_url: 'https://chat.z.ai/', pathname: '/', search: '', hash: '',
    host: 'chat.z.ai', hostname: 'chat.z.ai', protocol: 'https:',
    referrer: '', title: 'Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5',
    timezone_offset: '-480', local_time: new Date().toString(), utc_time: new Date().toUTCString(),
    is_mobile: 'false', is_touch: 'false', max_touch_points: '10',
    browser_name: 'Chrome', os_name: 'Windows',
  };

  const sortedPayload = Object.entries(payload)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => k + ':' + v)
    .join(',');

  const urlParams = new URLSearchParams();
  Object.entries(payload).forEach(([k, v]) => urlParams.append(k, String(v)));

  const { signature } = generateSignature(sortedPayload, messageContent, timestamp);

  return { signature, urlParams: urlParams.toString(), signatureTimestamp: timestamp };
}

export { solveCaptcha, solveCaptchaFull, getFreshToken, buildSignaturePayload, FE_VERSION, BASE_URL };
