# glm

OpenAI-compatible API proxy for [Z.ai](https://chat.z.ai) (Zhipu GLM models).

Converts Z.ai's web chat interface into a standard OpenAI API format, supporting both `/v1/chat/completions` and `/v1/messages` (Anthropic compatibility).

## Features

- OpenAI `/v1/chat/completions` compatible (streaming & non-streaming)
- Anthropic `/v1/messages` compatible (for Cherry Studio, etc.)
- Model capability suffixes: `-thinking`, `-vision`, `-search`, `-free-think`, `-mcp`, `-agent`, `-file-qa`
- Token pool with auto-rotation and error recovery
- Request queuing with concurrency limits
- CAPTCHA bypass via browser intercept-replay

## Prerequisites

- Node.js >= 18
- Chrome or Chromium installed
- Xvfb (for headless Linux servers)

## Setup

```bash
cp .env.example .env
# Edit .env with your Z.ai credentials
npm install
```

## Configuration (.env)

| Variable | Description | Default |
|----------|-------------|---------|
| `GLM_TOKENS` | Comma-separated JWT tokens from Z.ai | - |
| `GLM_ACCOUNTS` | Comma-separated email:password pairs | - |
| `PORT` | API server port | `3003` |
| `API_KEY` | Optional API key for authentication | (empty = no auth) |
| `CHROME_PATH` | Path to Chrome/Chromium executable | Auto-detected |
| `USER_DATA_DIR` | Chrome user data directory | `./edge-profile` |
| `GLM_SERVER_MODE` | Set to `1` for Linux server mode | Auto-detected |

## Running

### Local (Windows/Mac with display)
```bash
npm start
```

### Linux server (with Xvfb)
```bash
xvfb-run --auto-servernum node glm-index.js
# or with pm2:
pm2 start "xvfb-run --auto-servernum node glm-index.js" --name glm-2api
```

## API Endpoints

### POST /v1/chat/completions
OpenAI-compatible chat completion.

### POST /v1/messages
Anthropic-compatible messages API.

### GET /v1/models
List available models with capability suffixes.

### GET /
Health check with pool info.

## Available Models

Base models are auto-fetched from Z.ai. Capability suffixes generate variants:

| Suffix | Feature |
|--------|---------|
| `-thinking` | Deep thinking mode |
| `-vision` | Image understanding |
| `-search` | Web search |
| `-free-think` | Free-form thinking |
| `-mcp` | MCP tool use |
| `-agent` | Agent mode |
| `-file-qa` | File question answering |

Example: `GLM-5.1-thinking` enables thinking mode on GLM-5.1.

## How CAPTCHA Bypass Works

Z.ai requires an Aliyun slider CAPTCHA on every chat request. The captcha token is single-use and bound to the browser session. This proxy:

1. Launches a real Chrome browser via Puppeteer (with stealth plugin)
2. Navigates to Z.ai, lets the browser solve the CAPTCHA automatically
3. Intercepts the browser's completion request (which contains the captcha token)
4. Aborts the browser's request and replays it to the API
5. Returns the response in OpenAI format

This adds ~10-20s latency per request but is the only reliable method since the captcha token and X-Signature are both bound to the exact request content.
