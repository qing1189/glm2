# GLM-2API Docker 镜像
# 基于 Node.js 20 + Google Chrome + Xvfb

FROM node:20-slim

LABEL maintainer="qing1189"
LABEL description="GLM (Zhipu AI / chat.z.ai) Web Chat to OpenAI-compatible API proxy"

# 设置环境变量
ENV DEBIAN_FRONTEND=noninteractive \
    GLM_SERVER_MODE=1 \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    USER_DATA_DIR=/app/edge-profile \
    PORT=3003 \
    # Puppeteer 跳过下载 Chromium（使用系统 Chrome）
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 安装系统依赖 + Google Chrome + Xvfb
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Xvfb 虚拟显示 + xauth
    xvfb \
    xauth \
    # Chrome 依赖
    wget \
    gnupg2 \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    # 进程管理
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# 安装 Google Chrome Stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-key.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-key.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# 创建工作目录
WORKDIR /app

# 复制 package 文件并安装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制应用代码
COPY . .

# 创建 Chrome 用户数据目录
RUN mkdir -p /app/edge-profile

# 创建启动脚本
RUN echo '#!/bin/bash\nxvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" node glm-index.js' > /app/start.sh \
    && chmod +x /app/start.sh

# 暴露端口
EXPOSE ${PORT}

# 使用 dumb-init 作为 PID 1 进程管理器
ENTRYPOINT ["dumb-init", "--"]

# 启动服务
CMD ["/app/start.sh"]
