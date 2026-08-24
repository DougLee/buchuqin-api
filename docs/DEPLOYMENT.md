# 部署拓扑（admin.buchuqin.com）

> 2026-08-24 起（道哥决策）：**小程序与后台统一走 `https://admin.buchuqin.com`**，
> buchuqin.com 不再用于小程序合法域名。历史：2026-08-18 域名化改造曾用
> buchuqin.kaola101.com（现已不可达，server_name 仍并列保留）；
> 更早的 buchuqin.nongmokeji.com 因备案接入商不匹配被腾讯拦截弃用。

## 线上拓扑

```
admin.buchuqin.com ──DNS──▶ 139.199.3.190（腾讯云，1Panel）

OpenResty（1Panel 面板网站，持有 80/443，证书面板托管自动续期）
├── 80  → 301 https（面板自动生成）
├── 443
│   ├── /api/ ──▶ 127.0.0.1:8080 ──▶ api 容器（容器内 3000）→ Nest，全局前缀 /api/v1
│   └── /     ──▶ nginx 直出后台静态站（hash 路由 SPA，try_files 兜底）

postgres 容器（compose 内网，仅 api 可达）
```

- 小程序（用户端/配送端）API 基址同为 `https://admin.buchuqin.com/api/v1`
  （两个 weapp 的 `.env.production`），微信 request 合法域名配本域名即可。

- 站点主配置：`/opt/1panel/www/conf.d/buchuqin.nongmokeji.com.conf`（目录名是建站时的旧域名，无碍）
- 反代规则：`/opt/1panel/www/sites/buchuqin.nongmokeji.com/proxy/buchuqin.conf`（/api/ 反代 + / 静态直出）
- 后台静态根：`/opt/1panel/www/sites/buchuqin.nongmokeji.com/index/`（nginx 直出；⚠️ 改配置走服务器文件或面板"配置文件"，别用面板"反向代理"页改——它会重写回 location /）
- 证书：面板申请（DNS 验证），存 `sites/.../ssl/`，续期面板托管；旧 acme.sh 已停用（`--remove`）
- `/opt/buchuqin/admin-dist` + ADMIN_DIST_DIR 是旧托管通道（Nest 兜底），已不再是发布目标，不再更新
- 防火墙：firewalld 开 80/443/18080（443 忘放行的症状：外部 TLS 握手 0 字节断开）

## 决策记录

| 决策 | 结论 |
|---|---|
| 域名 | `admin.buchuqin.com` 唯一对外入口（后台 + API + 小程序），HTTPS 强制 |
| API 端口 | 容器发布 `127.0.0.1:8080`（原 3000），仅本机，安全组不开 |
| 前缀 | `/api/v1` 由后端 `src/main.ts` setGlobalPrefix 定义，nginx 不改写路径 |
| 后台托管 | 2026-08-18 起拆分：nginx 直出静态 + `/api/` 专项反代（原整站反代进 API 容器） |
| 老 IP 入口 | 全部下线，旧配置存档 conf.d/*.removed-20260818 |
| H5 线上部署 | 已移除（小程序是唯一线上客户端）；静态文件暂留 /opt/1panel/www/sites/h5-* |

## 常用操作

```bash
# 升级 API（服务器上；拉代码 + 同步 compose + 重建 api 容器，中断约 15 秒）
bash /opt/buchuqin/buchuqin-api/deploy/deploy.sh update

# 更新后台（本地 build 后 tar 管道，目标改为面板站点静态根）
cd buchuqin-admin && pnpm build
tar czf - -C dist . | ssh 139.199.3.190-buchuqin \
  "rm -rf /opt/1panel/www/sites/buchuqin.nongmokeji.com/index/* && tar xzf - -C /opt/1panel/www/sites/buchuqin.nongmokeji.com/index/"

# OpenResty 配置校验与重载（容器内）
docker exec 1Panel-openresty-m45r nginx -t && docker exec 1Panel-openresty-m45r nginx -s reload
```

## 小程序发布前 checklist

1. 微信后台（两个小程序各自）→ 开发管理 → 开发设置 → 服务器域名 → request 合法域名加 `https://admin.buchuqin.com`
2. 生产构建自动带 `.env.production` 里的 `VITE_API_BASE_URL=https://admin.buchuqin.com/api/v1`
3. 上线前轮换两端 AppSecret + 开启微信 IP 白名单（139.199.3.190）
