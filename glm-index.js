import { config } from 'dotenv';
config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadAccounts, initAccountPool, getPoolInfo, getTotalCapacity, acquireToken } from './glm-auth.js';
import { handleOpenAICompletion, convertAnthropicToOpenAI } from './glm-openai.js';
import { getModels, handleOpenAIModels } from './glm-models.js';
import { getQueueInfo } from './src/queue.js';
import { adminAuth, registerAdminRoutes, loadPersistedConfig } from './admin-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Prevent unhandled promise rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  const { method, url } = req;
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    // 跳过静态资源和健康检查的详细日志
    if (url.startsWith('/admin/') && !url.startsWith('/admin/api')) return;
    console.log(`[${new Date().toISOString()}] ${method} ${url} ${status} ${duration}ms`);
  });
  next();
});

// 管理面板静态文件
app.use('/admin', express.static(join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(join(__dirname, 'public', 'admin.html')));

// 管理面板 API（密码保护）
app.use('/admin/api', adminAuth);
registerAdminRoutes(app);

// API Key auth middleware（不影响管理面板路由）
app.use((req, res, next) => {
  // 管理面板路由跳过 API Key 验证
  if (req.path.startsWith('/admin')) return next();
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${apiKey}`) return next();
  res.status(401).json({ error: { message: 'Invalid API key' } });
});

app.post('/v1/chat/completions', handleOpenAICompletion);

// Anthropic Messages API compatibility
app.post('/v1/messages', (req, res) => {
  const openaiReq = convertAnthropicToOpenAI(req);
  handleOpenAICompletion(openaiReq, res);
});

app.get('/v1/models', async (req, res) => {
  const slot = acquireToken();
  if (!slot) return res.status(503).json({ error: { message: 'No available token' } });
  try {
    const modelList = await getModels(slot.token);
    res.json(handleOpenAIModels(modelList));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  } finally {
    slot.release();
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    service: 'glm-2api',
    provider: 'chat.z.ai',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

app.listen(PORT, async () => {
  console.log(`GLM 2API running on http://localhost:${PORT}`);
  console.log(`OpenAI format:  POST /v1/chat/completions`);
  console.log(`Models:         GET  /v1/models`);
  console.log(`Admin panel:    http://localhost:${PORT}/admin`);
  console.log(`Admin password: ${process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.slice(0, 2) + '***' : '(default: admin123)'}`);

  try {
    loadPersistedConfig();
    loadAccounts();
    await initAccountPool();
  } catch (err) {
    console.warn(`[startup] Token pool init warning: ${err.message}`);
    console.warn('[startup] Service is running — configure tokens via admin panel: /admin');
  }
});
