# 构建阶段：pnpm 装依赖 + prisma generate + nest build
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build

# 运行阶段：alpine + openssl（prisma 引擎需要），携带全量 node_modules（seed 依赖 ts-node）
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.9 --activate
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
# 启动即迁移；SEED_ON_BOOT=true 时首次灌入演示数据（幂等）
CMD ["sh", "-c", "pnpm db:migrate && { [ \"$SEED_ON_BOOT\" = \"true\" ] && pnpm db:seed || true; } && node dist/main"]
