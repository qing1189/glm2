import { reportTokenError, reportTokenSuccess } from './glm-auth.js';
import { solveCaptchaFull } from './captcha-solver.js';

const DEBUG_SSE = process.env.DEBUG_SSE === '1';

export async function completion({ token: envToken, model, messages, features = {}, params = {} }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Each captcha is single-use and bound to the browser's message — get fresh every time
    const intercepted = await solveCaptchaFull(messages);
    if (!intercepted) {
      console.warn(`[glm-chat] No captcha (attempt ${attempt + 1})`);
      continue;
    }

    // Replay the exact intercepted request — the browser typed the user's message,
    // solved captcha, and the server already validated the signature against this content
    const body = intercepted.body;

    // Use the intercepted request's headers (minus hop-by-hop ones)
    const reqHeaders = { ...intercepted.headers };
    delete reqHeaders['host'];
    delete reqHeaders['connection'];
    delete reqHeaders['content-length'];
    delete reqHeaders['accept-encoding'];

    const res = await fetch(intercepted.url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      reportTokenError(envToken);
      let errText;
      try {
        const errRaw = await res.text();
        try {
          const errJson = JSON.parse(errRaw);
          errText = errJson.detail || JSON.stringify(errJson);
        } catch {
          errText = errRaw;
        }
      } catch {
        errText = `HTTP ${res.status}`;
      }
      console.error(`[glm-chat] HTTP ${res.status}: ${errText.slice(0, 300)}`);
      if (errText.includes('captcha') || errText.includes('verify_failed') || errText.includes('missing_param') || errText.includes('INTERNAL_ERROR')) {
        console.warn(`[glm-chat] Retrying with fresh captcha`);
        continue;
      }
      throw new Error(`Completion failed: ${res.status} ${errText}`);
    }

    reportTokenSuccess(envToken);
    return { body: res.body };
  }

  throw new Error('All captcha retry attempts exhausted');
}

export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEventType = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEventType = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        if (DEBUG_SSE) console.log(`[SSE] raw event=${currentEventType} data=${data.slice(0, 500)}`);

        try {
          const parsed = JSON.parse(data);
          const eventType = parsed.type || currentEventType;

          let eventData = parsed.data ?? parsed;

          // Handle Z.ai v2 nested data: {data: {data: {...}}}
          if (eventData?.data && typeof eventData.data === 'object' && !eventData.content && !eventData.delta_content) {
            eventData = eventData.data;
          }

          // chat:completion with delta_content (thinking/content phases)
          if (eventType === 'chat:completion' && eventData.delta_content) {
            const phase = eventData.phase || '';
            if (phase === 'thinking') {
              yield { type: 'thinking', content: eventData.delta_content, usage: null };
            } else {
              yield { type: 'content', content: eventData.delta_content, usage: eventData.usage || null };
            }
            if (eventData.done) {
              yield { type: 'done', usage: eventData.usage || null };
            }
          }
          // chat:message:delta / message
          else if (eventType === 'chat:message:delta' || eventType === 'message') {
            const content = eventData.content || '';
            const reasoning = eventData.reasoning_content || eventData.thinking || '';
            const usage = eventData.usage || null;
            if (reasoning) yield { type: 'thinking', content: reasoning, usage };
            if (content) yield { type: 'content', content, usage };
          }
          // chat:message / replace
          else if (eventType === 'chat:message' || eventType === 'replace') {
            const content = eventData.content || '';
            if (content) yield { type: 'content', content, usage: null };
          }
          // chat:completion with choices (OpenAI-style)
          else if (eventType === 'chat:completion' && eventData.choices) {
            for (const choice of eventData.choices) {
              const delta = choice.delta || {};
              if (delta.content) yield { type: 'content', content: delta.content, usage: eventData.usage || null };
              if (delta.reasoning_content) yield { type: 'thinking', content: delta.reasoning_content, usage: null };
              if (choice.finish_reason === 'stop') yield { type: 'done', usage: eventData.usage || null };
            }
          }
          // Captcha error
          else if (eventData.error?.code === 'FRONTEND_CAPTCHA_REQUIRED') {
            yield { type: 'captcha_required', content: eventData.error.detail || 'Captcha required' };
            return;
          }
          // Status
          else if (eventType === 'status') {
            const desc = eventData.description || eventData.content || '';
            if (desc) yield { type: 'status', content: desc };
          }
          // Heartbeat
          else if (eventType === 'conn:heartbeat') {
            // skip
          }
          // Source/citation
          else if (eventType === 'source' || eventType === 'citation') {
            // skip
          }
          // Error
          else if (eventType === 'error' || currentEventType === 'error') {
            const errorMsg = eventData.error || eventData.message || eventData.detail || parsed.detail || 'Unknown stream error';
            yield { type: 'error', content: errorMsg };
            return;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    yield { type: 'done', usage: null };
  } finally {
    reader.releaseLock();
  }
}
