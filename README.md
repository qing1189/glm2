# GLM-2API

将 [Z.ai](https://chat.z.ai)（智谱 GLM 模型）的网页聊天接口转换为 OpenAI 兼容 API 的代理服务。

## 功能特性

- 兼容 OpenAI `/v1/chat/completions` 接口（支持流式和非流式）
- 兼容 Anthropic `/v1/messages` 接口（适配 Cherry Studio 等客户端）
- 模型能力后缀：`-thinking`、`-vision`、`-search`、`-free-think`、`-mcp`、`-agent`、`-file-qa`
- Token 池自动轮换与错误恢复
- 请求队列与并发控制
- 验证码自动绕过（浏览器拦截-重放机制）
- Web 管理面板（密码保护、Token/配置热加载管理）

## 硬件要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| **CPU** | 2 核 | 4 核 |
| **内存** | 2 GB | 4 GB 及以上 |
| **磁盘** | 5 GB（镜像约 1.5GB + Chrome 数据） | 10 GB |
| **架构** | x86_64 (amd64) | x86_64 (amd64) |
| **操作系统** | Linux（内核 4.18+） | Ubuntu 20.04+ / Debian 11+ |
| **网络** | 需要访问 `chat.z.ai`（HTTPS 443） | 低延迟网络 |

> ⚠️ **注意**：本项目需要运行完整的 Chrome 浏览器 + Xvfb 虚拟显示，因此内存消耗较高。每个浏览器实例约占用 300-500MB 内存。

## Docker 部署（推荐）

### 前置条件

- Docker Engine 20.10+
- Docker Compose V2

### 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/qing1189/glm2.git
cd glm2
git checkout docker

# 2. 配置环境变量
cp .env.docker .env.docker.local
# 编辑 .env.docker 填入你的 Z.ai 凭证
```

编辑 `.env.docker` 文件：

```env
# Z.ai JWT Token（多个用英文逗号分隔）
GLM_TOKENS=your_jwt_token_here

# 或者使用账号密码（格式: email:password）
GLM_ACCOUNTS=your_email:your_password

# API 端口
PORT=3003

# API 密钥（留空则不验证）
API_KEY=

# 管理面板密码（强烈建议修改）
ADMIN_PASSWORD=your_secure_password

# 代理（可选）
HTTPS_PROXY=
```

```bash
# 3. 一键启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

### 构建镜像

```bash
# 本地构建
docker compose build

# 或手动构建
docker build -t glm-2api .
```

### 数据持久化

Chrome 浏览器数据（登录状态、cookies）保存在 Docker Volume `chrome-data` 中。

```bash
# 查看 volume
docker volume ls | grep chrome-data

# 如需清除浏览器数据（重新登录）
docker compose down -v
```

### 健康检查

容器内置健康检查，每 30 秒检测一次服务状态：

```bash
# 查看容器健康状态
docker ps

# 手动测试
curl http://localhost:3003/
```

## 手动部署

### 系统要求

- Node.js >= 18
- Google Chrome 或 Chromium
- Xvfb（Linux 无桌面环境时需要）

### 安装步骤

```bash
# 安装依赖
npm install

# 复制环境变量
cp .env.example .env
# 编辑 .env 填入配置

# 启动（Linux 服务器）
xvfb-run --auto-servernum node glm-index.js

# 或使用 pm2 后台运行
pm2 start "xvfb-run --auto-servernum node glm-index.js" --name glm-2api
```

## 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GLM_TOKENS` | Z.ai JWT Token（逗号分隔） | - |
| `GLM_ACCOUNTS` | Z.ai 账号密码（email:password，逗号分隔） | - |
| `PORT` | API 服务端口 | `3003` |
| `API_KEY` | API 访问密钥（留空不验证） | 空 |
| `ADMIN_PASSWORD` | 管理面板登录密码 | `admin123` |
| `CHROME_PATH` | Chrome 可执行文件路径 | Docker 内自动配置 |
| `USER_DATA_DIR` | Chrome 用户数据目录 | Docker 内自动配置 |
| `GLM_SERVER_MODE` | Linux 服务器模式 | Docker 内自动为 `1` |
| `HTTPS_PROXY` | HTTPS 代理地址 | 空 |
| `HTTP_PROXY` | HTTP 代理地址 | 空 |
| `DEBUG_SSE` | SSE 调试日志（`1` 开启） | `0` |

## 管理面板

本项目内置 Web 管理面板，可通过浏览器管理服务配置。

### 访问地址

```
http://localhost:3003/admin
```

### 默认密码

```
admin123
```

> ⚠️ **首次部署请务必修改 `ADMIN_PASSWORD` 环境变量！**

### 功能概览

| 功能 | 说明 |
|------|------|
| **服务状态** | 查看运行时间、内存使用、Token 池容量、队列状态 |
| **Token 池详情** | 每个 Token 的状态、过期时间、错误次数、并发数 |
| **配置管理** | 在线修改 Token、API Key、代理等配置，保存即热加载 |
| **Token 管理** | 快速添加/删除 Token，一键重载 Token 池 |

### 热加载说明

在管理面板中修改配置后：
- **立即生效**：GLM_TOKENS、GLM_ACCOUNTS、API_KEY、代理设置、调试模式、管理密码
- **需重启容器**：PORT（端口变更）

配置修改同时写入 `.env.docker` 文件持久化，容器重启后依然有效。

## API 接口

### POST /v1/chat/completions

OpenAI 兼容的聊天补全接口。

```bash
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "GLM-5.1",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### POST /v1/messages

Anthropic Messages API 兼容接口。

### GET /v1/models

获取可用模型列表（含能力后缀变体）。

### GET /

健康检查，返回服务状态和 Token 池信息。

## 可用模型

基础模型从 Z.ai 自动获取，通过能力后缀生成变体：

| 后缀 | 功能 |
|------|------|
| `-thinking` | 深度思考模式 |
| `-vision` | 图像理解 |
| `-search` | 联网搜索 |
| `-free-think` | 自由思考 |
| `-mcp` | MCP 工具调用 |
| `-agent` | Agent 模式 |
| `-file-qa` | 文件问答 |

示例：`GLM-5.1-thinking` 为 GLM-5.1 启用深度思考模式。

## 验证码绕过原理

Z.ai 每次聊天请求都需要阿里云滑块验证码。验证码 token 是一次性的且绑定浏览器会话。本项目的处理方式：

1. 通过 Puppeteer（Stealth 插件）启动真实 Chrome 浏览器
2. 导航到 Z.ai，让浏览器自动解决验证码
3. 拦截浏览器的补全请求（包含验证码 token）
4. 中止浏览器原始请求，将其重放到 API
5. 以 OpenAI 格式返回响应

> 每次请求约增加 10-20 秒延迟，但这是目前唯一可靠的方法。

## 常见问题

### Docker 容器启动后无法访问

1. 检查端口映射：`docker ps` 确认端口正确
2. 查看日志：`docker compose logs -f`
3. 确认 `.env.docker` 中的凭证正确

### Chrome 崩溃 / 内存不足

- 确保 `shm_size` 设置为 `1gb`（docker-compose.yml 中已配置）
- 增加容器内存限制或宿主机内存

### 验证码失败

- 检查网络是否能访问 `chat.z.ai`
- 尝试清除浏览器数据：`docker compose down -v` 后重启

## License

MIT
