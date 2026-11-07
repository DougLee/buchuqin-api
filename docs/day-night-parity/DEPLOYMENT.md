# 测试环境部署与回退

仅TEST主机`139.199.3.190-buchuqin-test`和域名`https://admin-test.buchuqin.com`。生产API、服务器、数据库、支付和存储未连接/未修改。

- TEST API运行源代码：`d2bb7f8`，镜像`buchuqin-api:parity-20261108-r4`；此前r2/r3保留用于追踪。后台运行源`980d8ba`，镜像`buchuqin-admin:parity-20261108`。后台`de3d357`仅本地开发CSP调整，生产构建逻辑相同。
- 用户小程序源`f1fba9c`，配送源`626f4cb`。小程序本地H5为5196/5195，本地后台5197；微信包只完成构建，不代表真机发布。
- 升级前数据库备份`/opt/buchuqin/backups/parity-20261108/before.dump`（0600，目录0700）；原镜像保留`buchuqin-api:before-parity-20261108`及admin对应标签。未在文档归档环境文件、密钥或登录令牌。
- 先恢复独立克隆库`buchuqin_parity_retry_20261108_spec`，保持原数据库owner，预演两项新迁移成功后再升级TEST。首次`--no-owner`克隆权限错误未修改业务库，失败克隆保留用于审计。
- 必须合用`docker-compose.yml`、`docker-compose.night-acceptance.yml`和`docker-compose.parity-20261108.yml`。保留`NIGHT_REMOTE_ACCEPTANCE=20261107`、`NODE_OPTIONS=--import /acceptance/channel.mjs`、只读acceptance挂载与`SEED_ON_BOOT=false`；不能单独base compose重建造成外部隔离丢失。
- 原Dockerfile APK下载阻塞；锁文件未变化，使用原TEST镜像作为基底重新generate/build：部署专用`releases/parity-20261108/Dockerfile.api-cached`。构建/升级日志在同名backup目录，不改仓库业务Dockerfile。
- 回退应用时在相同三份compose组合里把镜像改回before标签；数据库恢复须独立评估迁移/新数据影响，禁止自动覆盖共享TEST，更不能恢复到生产。

验收组织仅临时开放白天做测试，结束恢复白天手动关闭、夜宵00:00–23:59供本地查看；临时秒杀停用，公告有1小时期限，TEST Banner保留展示。测试单均正常取消/完成/退款，所有资源变更可由业务流水追溯；没有直接修改押金或库存制造通过。最终健康与镜像信息见evidence/deployment-final.log。
