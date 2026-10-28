# 廊坊一中回忆录 —— 生产镜像
# 构建：docker build -f deploy/Dockerfile -t langfang-memoir .
# 运行：docker run -d -p 3000:3000 -v memoir-data:/app/data -v memoir-uploads:/app/uploads --env-file .env --name memoir langfang-memoir
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UPLOAD_DIR=/app/uploads

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 再拷代码
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# 数据目录（挂载卷），并交给非 root 用户
RUN mkdir -p /app/data /app/uploads \
 && chown -R node:node /app/data /app/uploads /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]