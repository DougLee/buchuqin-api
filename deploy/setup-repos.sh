#!/usr/bin/env bash
# standalone 部署·代码拉取脚本（幂等）：仓库不存在则 clone，存在则 pull 到最新 main
# 用法：放在部署根目录（与 docker-compose-standalone.yml 同级）直接执行
#       bash setup-repos.sh
# 认证：服务器需配 Gitee SSH deploy key（git@gitee.com:buchuqin-group/*）
set -euo pipefail

# 部署根目录=脚本所在目录（不依赖执行时 cwd）
cd "$(dirname "$0")"

REPOS=(
  git@gitee.com:buchuqin-group/buchuqin-api.git
  git@gitee.com:buchuqin-group/buchuqin-admin.git
)

echo "部署根目录: $(pwd)"
for url in "${REPOS[@]}"; do
  name=$(basename "$url" .git)
  if [ -d "$name/.git" ]; then
    echo "== $name 已存在 → git pull =="
    # 部署目录以远端为唯一真源；有脏改动会 ff-only 失败并停下，人工处理后重跑
    git -C "$name" fetch origin
    git -C "$name" pull --ff-only origin main
  else
    echo "== $name 不存在 → git clone（全量，保留历史便于回滚到上一提交）=="
    git clone -b main "$url"
  fi
  echo "   → $name @ $(git -C "$name" rev-parse --short HEAD) $(git -C "$name" log -1 --format=%s | head -c 40)"
done

echo "拉取完成。下一步：确认 .env 后 docker compose -f docker-compose-standalone.yml up -d --build"
