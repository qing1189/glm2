import { completion, parseSSEStream } from './glm-chat.js';
import { enqueueRequest, dispatchQueued } from './src/queue.js';

const MODE_SUFFIXES = {
  '-thinking':    { features: { think: true } },
  '-vision':      { features: { vision: true } },
  '-search':      { features: { web_search: true } },
  '-free-think':  { features: { free_think: true } },
  '-mcp':         { features: { mcp: true } },
  '-agent':       { features: { agent_mode: true } },
  '-file-qa':     { features: { file_qa: true } },
};

function parseModelSuffix(model) {
  for (const [suffix, config] of Object.entries(MODE_SUFFIXES)) {
    if (model.endsWith(suffix)) {
      const baseModel = model.slice(0, -suffix.length);
      return { baseModel, features: config.features };
    }
  }
  return { baseModel: model, features: {} };
}

function buildGLMMessages(messages) {
  const last = messages[messages.length - 1] || { role: 'user', content: '' };

  if (messages.length <= 1) {
    return typeof last.content === 'string' ? last.content : extractText(last.content);
  }

  const history = messages.slice(0, -1);
  const historyText = history.map(m => {
    const text = typeof m.content === 'string' ? m.content : extractText(m.content);
    return `${m.role}:${text}`;
  }).join('\n');

  const lastText = typeof last.content === 'string' ? last.content : extractText(last.content);
  return `${historyText}\n${last.role}:${lastText}`;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  }
  return '';
}

export function convertAnthropicToOpenAI(req) {
  const { model, messages: anthropicMessages, system, stream = false, max_tokens } = req.body;

  const openaiMessages = [];

  if (system) {
    const systemText = Array.isArray(system)
      ? system.filter(s => s.type === 'text').map(s => s.text).join('\n')
      : String(system);
    if (systemText) openaiMessages.push({ role: 'system', content: systemText });
  }

  for (const msg of anthropicMessages || []) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      const content = Array.isArray(msg.content)
        ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        : String(msg.content || '');
      openaiMessages.push({ role: msg.role, content });
    }
  }

  req.body.model = model || 'GLM-5.1';
  req.body.messages = openaiMessages;
  req.body.stream = stream;
  if (max_tokens) req.body.max_tokens = max_tokens;

  return req;
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false } = req.body;

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const { baseModel, features: suffixFeatures } = parseModelSuffix(model);

  // Merge suffix features with request-level features
  const features = { ...suffixFeatures };
  if (req.body.features) Object.assign(features, req.body.features);
  // Qwen-compatible aliases
  if (req.body.enable_thinking) features.think = true;
  if (req.body.enable_search) features.web_search = true;

  const glmMessages = buildGLMMessages(messages);

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let result;

  try {
    const slot = await enqueueRequest();

    try {
      result = await completion({
        token: slot.token,
        model: baseModel,
        messages: glmMessages,
        features,
      });
      result.slot = slot;
    } catch (err) {
      slot.release();
      dispatchQueued();
      console.error('Completion error:', err.message);
      return res.status(500).json({ error: { message: err.message } });
    }
  } catch (err) {
    return res.status(503).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      res.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      let captchaRetryCount = 0;
      const MAX_CAPTCHA_RETRIES = 2;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'captcha_required') {
          captchaRetryCount++;
          if (captchaRetryCount > MAX_CAPTCHA_RETRIES) {
            console.error('Max captcha retries exceeded');
            res.write(`data: ${JSON.stringify({
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: 'Error: Captcha verification failed after retries' }, finish_reason: null }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            break;
          }
          console.warn(`[glm-openai] Captcha required in stream, retry ${captchaRetryCount}/${MAX_CAPTCHA_RETRIES}`);
          try {
            const freshResult = await completion({ token: slot.token, model: baseModel, messages: glmMessages, features });
            const freshStream = freshResult.body;
            for await (const freshEvent of parseSSEStream(freshStream)) {
              if (freshEvent.type === 'content') {
                res.write(`data: ${JSON.stringify({
                  id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { content: freshEvent.content }, finish_reason: null }],
                })}\n\n`);
              } else if (freshEvent.type === 'thinking') {
                res.write(`data: ${JSON.stringify({
                  id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { reasoning_content: freshEvent.content }, finish_reason: null }],
                })}\n\n`);
              } else if (freshEvent.type === 'done') {
                const usage = freshEvent.usage;
                res.write(`data: ${JSON.stringify({
                  id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  ...(usage ? { usage: {
                    prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
                    completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
                    total_tokens: (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
                  }} : {}),
                })}\n\n`);
                res.write('data: [DONE]\n\n');
              } else if (freshEvent.type === 'error') {
                console.error('Stream error on retry:', freshEvent.content);
                break;
              }
            }
            break;
          } catch (retryErr) {
            console.error('Captcha retry failed:', retryErr.message);
            res.write(`data: ${JSON.stringify({
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: `Error: ${retryErr.message}` }, finish_reason: null }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            break;
          }
        } else if (event.type === 'content') {
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'thinking') {
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'done') {
          const usage = event.usage;
          res.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            ...(usage ? { usage: {
              prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
              completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
              total_tokens: (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
            }} : {}),
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        } else if (event.type === 'error') {
          console.error('Stream error event:', event.content);
          break;
        }
      }
      res.end();
    } else {
      // Non-streaming: collect all events into a single response
      let fullContent = '';
      let fullThinking = '';
      let usage = null;
      let streamError = null;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'content') {
          fullContent += event.content;
        } else if (event.type === 'thinking') {
          fullThinking += event.content;
        } else if (event.type === 'done') {
          usage = event.usage;
        } else if (event.type === 'error') {
          streamError = event.content;
        }
      }

      if (streamError && !fullContent) {
        throw new Error(streamError);
      }

      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: fullContent,
            ...(fullThinking ? { reasoning_content: fullThinking } : {}),
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: usage?.prompt_tokens || usage?.input_tokens || 0,
          completion_tokens: usage?.completion_tokens || usage?.output_tokens || 0,
          total_tokens: (usage?.prompt_tokens || usage?.input_tokens || 0) + (usage?.completion_tokens || usage?.output_tokens || 0),
        },
      };
      res.json(response);
    }
  } catch (err) {
    console.error('Stream processing error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  } finally {
    slot.release();
    dispatchQueued();
  }
}
