#!/usr/bin/env bash
# buchuqin 服务器部署/升级脚本（在服务器上运行，需 root）
# 位置约定：本脚本随仓库 clone 到 /opt/buchuqin/buchuqin-api/deploy/deploy.sh
# 首次部署：bash /opt/buchuqin/buchuqin-api/deploy/deploy.sh init
# 日常升级：bash /opt/buchuqin/buchuqin-api/deploy/deploy.sh
set -euo pipefail

ROOT=/opt/buchuqin
REPO=$ROOT/buchuqin-api

init() {
  mkdir -p $ROOT/admin-dist
  [ -f $ROOT/.env ] || { echo "缺少 $ROOT/.env，请先配置"; exit 1; }
}

sync_files() {
  # 编排文件以仓库为源，每次部署同步
  cp $REPO/deploy/docker-compose.yml $ROOT/docker-compose.yml
  cp $REPO/deploy/nginx.conf $ROOT/nginx.conf
}

case "${1:-up}" in
  init)
    init
    sync_files
    cd $ROOT && docker compose up -d --build
    ;;
  up)
    sync_files
    cd $ROOT && docker compose up -d --build
    ;;
  update)
    # 拉代码 + 重建 api（postgres/nginx 不动）
    git -C $REPO pull --ff-only
    sync_files
    cd $ROOT && docker compose up -d --build api
    ;;
  logs)
    cd $ROOT && docker compose logs -f --tail=100 api
    ;;
  *)
    echo "用法: deploy.sh [init|up|update|logs]"
    exit 1
    ;;
esac
