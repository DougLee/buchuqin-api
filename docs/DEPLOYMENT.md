# 部署拓扑（buchuqin.nongmokeji.com）

> 2026-08-18 域名化改造（道哥决策）：全站只走域名 + HTTPS；IP 入口与 H5 线上部署全部下线。

## 线上拓扑

```
buchuqin.nongmokeji.com  ──DNS A──▶  139.199.3.190（腾讯云，1Panel）

OpenResty（1Panel，host 网络，持有 80/443）
├── 80  → 301 https（保留 /.well-known/acme-challenge 供续期）
└── 443（Let's Encrypt，acme.sh 自动续期 + reload）
    └── /  ──▶ 127.0.0.1:8080 ──▶ api 容器（容器内仍监听 3000）
        ├── /api/v1/*   Nest API
        └── /*          PC 后台静态站（admin-dist 挂载进容器托管）

postgres 容器（compose 内网，仅 api 可达）
```

- 站点配置：`/opt/1panel/www/conf.d/buchuqin.nongmokeji.com.conf`（1Panel conf.d 挂载）
- 证书：`/opt/1panel/apps/openresty/openresty/conf/ssl/buchuqin.nongmokeji.com/`，acme.sh webroot 续期（cron `acme.sh --cron`，reloadcmd 已挂钩）
- 防火墙：firewalld 开 80/443/18080（**443 是本次踩坑点：忘了放行，症状是外部 TLS 握手 0 字节断开**）

## 决策记录

| 决策 | 结论 |
|---|---|
| 域名 | `buchuqin.nongmokeji.com` 唯一入口，HTTPS 强制（80 → 301） |
| API 端口 | 容器发布 `127.0.0.1:8080`（原 3000），**仅本机**，安全组不开 |
| PC 后台 | 域名根路径 `/`，继续由 api 容器托管（ADMIN_DIST_DIR），前端同源调 `/api/v1` |
| 老 IP 入口 | 全部下线（后台/api/h5 均 404），旧配置存档为 `buchuqin.conf.removed-20260818` |
| H5 线上部署 | 移除（小程序是唯一线上客户端）；本地 `pnpm dev:h5` 不受影响；静态文件暂留 `/opt/1panel/www/sites/h5-*` 可随时删 |

## 常用操作

```bash
# 升级 API（服务器上）
cd /opt/buchuqin/buchuqin-api && git pull
docker compose -f /opt/buchuqin/docker-compose.yml up -d --build api

# 更新后台
本地 pnpm build → scp dist/* 到 /opt/buchuqin/admin-dist/ → 无需重启（Nest 直接读目录）

# 证书状态 / 手动续期
~/.acme.sh/acme.sh --list
~/.acme.sh/acme.sh --renew -d buchuqin.nongmokeji.com --ecc --force

# OpenResty 配置校验与重载（容器内）
docker exec 1Panel-openresty-m45r nginx -t && docker exec 1Panel-openresty-m45r nginx -s reload
```

## 小程序发布前 checklist

1. 微信后台（两个小程序各自）→ 开发管理 → 服务器域名 → request 合法域名加 `https://buchuqin.nongmokeji.com`
2. 小程序生产构建需带 `VITE_API_BASE_URL=https://buchuqin.nongmokeji.com/api/v1`（dev 默认 localhost:3100，MP 不能用相对路径）
3. 上线前轮换两端 AppSecret + 开启微信 IP 白名单（139.199.3.190）
