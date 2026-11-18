#!/usr/bin/env bash
# buchuqin 服务器部署/升级脚本（在服务器上运行，需 root）
# 位置约定：本脚本随仓库 clone 到 /opt/buchuqin/buchuqin-api/deploy/deploy.sh
# 首次部署：bash /opt/buchuqin/buchuqin-api/deploy/deploy.sh init
# 日常升级：bash /opt/buchuqin/buchuqin-api/deploy/deploy.sh
#
# 编排形态（2026-11-18 IKW9WP 部署踩坑收口）：生产现役拓扑 = standalone
# （api+admin 双容器，openresty 整站反代 127.0.0.1:20010）。sync_files 改为
# 同步 docker-compose-standalone.yml——旧主编排只有 api 单服务，覆盖后会把
# 在跑的 admin 容器当 orphan 警告，且 api 被加上无用的 8080 发布/丢失
# container_name 与日志轮转。
set -euo pipefail

ROOT=/opt/buchuqin
REPO=$ROOT/buchuqin-api

init() {
  mkdir -p $ROOT/admin-dist
  [ -f $ROOT/.env ] || { echo "缺少 $ROOT/.env，请先配置"; exit 1; }
}

sync_files() {
  # 编排文件以仓库为源，每次部署同步（standalone 双服务形态）
  cp $REPO/deploy/docker-compose-standalone.yml $ROOT/docker-compose.yml
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
    # 拉代码 + 重建（api/admin 都在编排内；数据库用 1Panel 容器不在编排内）
    git -C $REPO pull --ff-only
    sync_files
    cd $ROOT && docker compose up -d --build
    ;;
  logs)
    cd $ROOT && docker compose logs -f --tail=100 api
    ;;
  *)
    echo "用法: deploy.sh [init|up|update|logs]"
    exit 1
    ;;
esac
