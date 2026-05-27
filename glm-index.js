import { config } from 'dotenv';
config();

import express from 'express';
import { loadAccounts, initAccountPool, getPoolInfo, getTotalCapacity, acquireToken } from './glm-auth.js';
import { handleOpenAICompletion, convertAnthropicToOpenAI } from './glm-openai.js';
import { getModels, handleOpenAIModels } from './glm-models.js';
import { getQueueInfo } from './src/queue.js';

// Prevent unhandled promise rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));

// API Key auth middleware
app.use((req, res, next) => {
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

  loadAccounts();
  await initAccountPool();
});
