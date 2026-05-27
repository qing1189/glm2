import { createHmac, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getPoolInfo, getTotalCapacity, loadAccounts, initAccountPool } from './glm-auth.js';
import { getQueueInfo } from './src/queue.js';

// ============================================
// 管理面板后端 API
// 密码保护 + Token/API Key 管理 + 热加载
// Token/Account 数据持久化到 JSON 文件（存在 volume 中）
// ============================================

const SESSION_SECRET = randomBytes(32).toString('hex');
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map();

// 数据持久化路径（存在 USER_DATA_DIR 对应的 volume 中）
const DATA_DIR = process.env.USER_DATA_DIR || './edge-profile';
const CONFIG_FILE = join(DATA_DIR, 'glm-config.json');

// 获取管理员密码
function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || 'admin123';
}

// 生成 session token
function createSession() {
  const token = randomBytes(32).toString('hex');
  const hmac = createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
  sessions.set(hmac, { createdAt: Date.now() });
  return hmac;
}

// 验证 session
function validateSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// 认证中间件
export function adminAuth(req, res, next) {
  const path = req.path;

  // 登录接口不需要认证
  if (path === '/login' || path === '/admin/api/login') return next();
  // 静态页面不需要认证
  if (path === '/admin' || path === '/admin/') return next();

  const token = req.headers['x-admin-token'];
  if (!validateSession(token)) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  next();
}

// ============================================
// 持久化配置文件（JSON）
// 存储 Token/Account 数据到 volume 中
// ============================================

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readConfig() {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) {
    return { tokens: '', accounts: '', apiKey: '' };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return { tokens: '', accounts: '', apiKey: '' };
  }
}

function saveConfig(config) {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 启动时从持久化文件加载 Token/Account/API_KEY 到环境变量
export function loadPersistedConfig() {
  const config = readConfig();
  if (config.tokens) {
    process.env.GLM_TOKENS = config.tokens;
    console.log('[admin] Loaded persisted GLM_TOKENS from config file');
  }
  if (config.accounts) {
    process.env.GLM_ACCOUNTS = config.accounts;
    console.log('[admin] Loaded persisted GLM_ACCOUNTS from config file');
  }
  if (config.apiKey) {
    process.env.API_KEY = config.apiKey;
    console.log('[admin] Loaded persisted API_KEY from config file');
  }
}

// 热加载配置到进程环境
function hotReloadConfig(vars) {
  const reloadableKeys = ['GLM_TOKENS', 'GLM_ACCOUNTS', 'PORT', 'API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'DEBUG_SSE', 'ADMIN_PASSWORD'];
  for (const key of reloadableKeys) {
    if (vars[key] !== undefined) {
      process.env[key] = vars[key];
    }
  }
}

// 注册管理面板路由
export function registerAdminRoutes(app) {

  // 登录
  app.post('/admin/api/login', (req, res) => {
    const { password } = req.body;
    if (password === getAdminPassword()) {
      const token = createSession();
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: '密码错误' });
    }
  });

  // 登出
  app.post('/admin/api/logout', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token) sessions.delete(token);
    res.json({ success: true });
  });

  // 验证会话
  app.get('/admin/api/session', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (validateSession(token)) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false });
    }
  });

  // 获取服务状态
  app.get('/admin/api/status', (req, res) => {
    res.json({
      service: 'glm-2api',
      version: '1.0.0',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pool: getPoolInfo(),
      totalCapacity: getTotalCapacity(),
      queue: getQueueInfo(),
      env: {
        port: process.env.PORT || '3001',
        hasApiKey: !!process.env.API_KEY,
        serverMode: process.env.GLM_SERVER_MODE,
        debugSSE: process.env.DEBUG_SSE,
        hasProxy: !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
      }
    });
  });

  // 获取当前配置
  app.get('/admin/api/config', (req, res) => {
    res.json({
      GLM_TOKENS: process.env.GLM_TOKENS || '',
      GLM_ACCOUNTS: process.env.GLM_ACCOUNTS || '',
      API_KEY: process.env.API_KEY || '',
      PORT: process.env.PORT || '3003',
      HTTPS_PROXY: process.env.HTTPS_PROXY || '',
      HTTP_PROXY: process.env.HTTP_PROXY || '',
      DEBUG_SSE: process.env.DEBUG_SSE || '0',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
    });
  });

  // 更新配置（热加载）
  app.post('/admin/api/config', async (req, res) => {
    try {
      const newConfig = req.body;
      
      // 更新进程环境变量（热加载）
      hotReloadConfig(newConfig);

      // 持久化 Token/Account/API_KEY 到 JSON 文件（存在 volume 中，重启不丢失）
      const config = readConfig();
      if (newConfig.GLM_TOKENS !== undefined) config.tokens = newConfig.GLM_TOKENS;
      if (newConfig.GLM_ACCOUNTS !== undefined) config.accounts = newConfig.GLM_ACCOUNTS;
      if (newConfig.API_KEY !== undefined) config.apiKey = newConfig.API_KEY;
      saveConfig(config);

      // 如果 Token 或 Account 变化了，重新初始化连接池
      if (newConfig.GLM_TOKENS !== undefined || newConfig.GLM_ACCOUNTS !== undefined) {
        try {
          loadAccounts();
          await initAccountPool();
          res.json({ success: true, message: '配置已更新并重新加载 Token 池' });
        } catch (err) {
          res.json({ success: true, message: `配置已保存，但 Token 池重载失败: ${err.message}` });
        }
      } else {
        res.json({ success: true, message: '配置已更新' });
      }
    } catch (err) {
      res.status(500).json({ error: `保存失败: ${err.message}` });
    }
  });

  // 单独添加 Token
  app.post('/admin/api/tokens/add', (req, res) => {
    const { token } = req.body;
    if (!token?.trim()) return res.status(400).json({ error: 'Token 不能为空' });

    const current = process.env.GLM_TOKENS || '';
    const tokens = current.split(',').map(t => t.trim()).filter(Boolean);
    if (tokens.includes(token.trim())) {
      return res.status(400).json({ error: 'Token 已存在' });
    }
    tokens.push(token.trim());
    process.env.GLM_TOKENS = tokens.join(',');

    // 持久化到 JSON
    const config = readConfig();
    config.tokens = process.env.GLM_TOKENS;
    saveConfig(config);

    res.json({ success: true, message: 'Token 已添加，请点击重载 Token 池生效' });
  });

  // 删除 Token
  app.post('/admin/api/tokens/remove', (req, res) => {
    const { token } = req.body;
    if (!token?.trim()) return res.status(400).json({ error: 'Token 不能为空' });

    const current = process.env.GLM_TOKENS || '';
    const tokens = current.split(',').map(t => t.trim()).filter(Boolean);
    const filtered = tokens.filter(t => t !== token.trim());
    
    if (filtered.length === tokens.length) {
      return res.status(400).json({ error: 'Token 不存在' });
    }
    
    process.env.GLM_TOKENS = filtered.join(',');

    // 持久化到 JSON
    const config = readConfig();
    config.tokens = process.env.GLM_TOKENS;
    saveConfig(config);

    res.json({ success: true, message: 'Token 已删除，请点击重载 Token 池生效' });
  });

  // 重载 Token 池
  app.post('/admin/api/reload', async (req, res) => {
    try {
      loadAccounts();
      await initAccountPool();
      res.json({ success: true, message: 'Token 池已重新加载' });
    } catch (err) {
      res.status(500).json({ error: `重载失败: ${err.message}` });
    }
  });
}
