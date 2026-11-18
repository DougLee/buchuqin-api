#!/usr/bin/env bash
# standalone 部署·夜宵分支拉取脚本（幂等）：仓库不存在则 clone 到指定分支，
# 存在则 checkout 到该分支并 ff 到最新。夜宵验收合并回 main 后本脚本停用，
# 回归 setup-repos.sh（main 正道流程）。
# 用法：放在部署根目录（与 docker-compose-standalone.yml 同级）直接执行
#       bash setup-repos-night.sh            # 默认拉 feature/night-store
#       bash setup-repos-night.sh 某分支名    # 临时拉其他分支
# 认证：服务器需配 Gitee SSH deploy key（git@gitee.com:buchuqin-group/*）
set -euo pipefail

# 部署根目录=脚本所在目录（不依赖执行时 cwd）
cd "$(dirname "$0")"

BRANCH="${1:-feature/night-store}"

REPOS=(
  git@gitee.com:buchuqin-group/buchuqin-api.git           # api 服务
  git@gitee.com:buchuqin-group/buchuqin-admin.git         # admin 前端
  git@gitee.com:buchuqin-group/buchuqin-user-weapp.git    # 用户端 H5（不需要可注释）
  git@gitee.com:buchuqin-group/buchuqin-delivery-weapp.git # 楼长端 H5（不需要可注释）
)

echo "部署根目录: $(pwd)"
echo "目标分支:   $BRANCH"
for url in "${REPOS[@]}"; do
  name=$(basename "$url" .git)
  if [ -d "$name/.git" ]; then
    echo "== $name 已存在 → checkout + ff 到 $BRANCH =="
    git -C "$name" fetch origin
    # 先落位到目标分支（本地脏改动会让 checkout 失败停下，人工处理后重跑）
    git -C "$name" checkout "$BRANCH"
    # ff-only：以远端为唯一真源，本地分叉绝不静默合并（同 setup-repos.sh 口径）
    git -C "$name" pull --ff-only origin "$BRANCH"
  else
    echo "== $name 不存在 → git clone（-b $BRANCH，全量保留历史便于回滚）=="
    git clone -b "$BRANCH" "$url"
  fi
  echo "   → $name @ $(git -C "$name" rev-parse --short HEAD) $(git -C "$name" log -1 --format=%s | head -c 40)"
done

echo "拉取完成（$BRANCH）。下一步：确认 .env 后 docker compose -f docker-compose-standalone.yml up -d --build"
