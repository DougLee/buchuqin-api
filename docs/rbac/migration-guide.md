# RBAC 迁移与回滚

本地验收文档，未执行生产升级。变更包含旧菜单/授权数据保留、新的迁移标记和菜单缓存字段；角色授权仍由服务启动时同步。历史迁移文件未改写。

## 新空数据库

历史 `20260915120000_restock_shipment` 排在其依赖 `20260917000000_restock_batch` 前，直接从零 `prisma migrate deploy` 会失败。不要在失败库中直接把失败项标为已完成，也不要为了安装改写历史 SQL。

使用新建的空数据库，配置该库的 `DATABASE_URL`（不要把真实密码写入版本库或命令日志）：

```sh
pnpm db:bootstrap
pnpm db:bootstrap --apply
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
```

第一条只输出执行计划。`--apply` 检查目标 schema 为空，在一个事务中执行所有原始 SQL，仅把 restock_batch 提前到 restock_shipment 之前；SQL 全部成功后，调用 Prisma 自带 `migrate resolve --applied` 逐项登记原文件校验和。SQL 失败整体回滚；任何已有表/视图/序列都拒绝引导。此命令不删除数据、不自动重置库。

登记期间如进程退出或 Prisma resolver 失败：SQL 已提交，禁止再次 bootstrap 或直接 deploy。先只读检查本次 bootstrap 日志、目标 schema 与模型 diff、`_prisma_migrations`，确认 SQL 全部成功且没有其他写入；再对日志中 SQL 已成功但 ledger 未登记的**具体项目**执行 `pnpm exec prisma migrate resolve --applied <migration-name>`。不能对未执行成功的 SQL 做 resolve。无法证明时保留故障库，在另一个新空库重演。

引导完成后后续升级正常使用 `pnpm db:migrate`。`--through=<完整迁移目录名>` 仅供构造旧版本测试库，不允许截断已知依赖。

## 已有数据库升级

1. 确认目标库/当前部署版本，备份数据库，保留当前应用构建与配置；读取迁移 ledger，检查已部署 SQL checksum 与当前文件一致。若没有 `_prisma_migrations` 却已有业务表（P3005），先完成独立的 schema/ledger 基线审计，不能直接套用空库脚本或批量标记全部已应用。
2. 执行 `node scripts/rbac-snapshot.mjs /安全路径/rbac-before.json`（通过环境变量提供 DATABASE_URL，输出拒绝覆盖已有文件），用只读一致性快照保存逐账号资料（排除密码）、角色×校区绑定、角色菜单与旧 `menus`、迁移标记、菜单配置、RbacState、相关授权审计。特别列出零授权账号和空角色：没有明确审计证据的旧记录不能仅凭“零行”推断为未迁移。先人工确认再执行迁移。
3. 在隔离数据库恢复备份，执行 `pnpm db:migrate`、`pnpm db:generate`，启动新版本一次；比较迁移前后每个账号在每个授权校区的角色/功能/范围。升级后用同一快照脚本输出另一个 rbac-after.json，再逐账号核对；快照兼容标记字段增加前后的 schema，不包含 passwordHash。先在副本完成验收，再安排实际升级。此目标没有实际升级授权。
4. 停止旧服务写入权限配置，执行已演练迁移，启动新服务；启动同步失败必须让实例启动失败，不能忽略错误继续服务。多实例共用事务锁与版本号。
5. 验证超级管理员、A/B 单校区、A运营+B财务、空权限、停用账号；修改校区参数/记录ID应拒绝越权。撤权后旧 token 失效，重复启动不得恢复授权。

新增字段迁移：

- `20260921090000_daily_seq_receipt`：主线兼容的小票日序号，独立于权限逻辑。
- `20260921110000_cart_as_seckill`：主线兼容的购物车秒杀身份字段，默认 false。
- `20260921120000_rbac_migration_markers`：已有绑定/明确授权审计/rbac账号标记为已迁移；角色已有菜单或显式编辑审计标记为已迁移。首次遗留转换随后将标记置 true。
- `20260921130000_menu_view_cache`：菜单 `keepAlive` 默认 false。

迁移不会把拥有一个平台角色的账号所有校区权限都提升成平台权限；能力与范围按具体操作配对。普通角色配置权限接口、校区范围的超管绑定及校区角色的平台操作会被收紧，这是修复而非无意丢权。

## 本次演练结果

- 空库 `buchuqin_rbac_migration_20260921`：先引导 51 个原始迁移，随后正常 deploy 新增购物车迁移；当前共 52 项完成，0 项未完成；`migrate status` up to date；schema diff 为空。日志 `/tmp/buchuqin-rbac-bootstrap.log`。
- 旧版副本 `buchuqin_rbac_upgrade_20260921`：引导至 `20260919150000_rbac_v1`，载入 `scripts/fixtures/rbac-upgrade.sql` 的合成数据，然后正常 deploy 3 个新迁移；本轮另 deploy 主线购物车迁移，当前共 52 项完成，0 项未完成。
- `scripts/verify-rbac-upgrade.ts` 验证旧运营账号多校区映射、已撤权账号不回填、已有自定义授权精确保留、显式清空模板不回填、停用账号拒绝、重复启动权限与版本不变；逐账号输出见 `upgrade-rehearsal.json`。
- 合成样本证明已覆盖分支的迁移行为，不能替代真实部署库的副本审计。
- Prisma schema 补录历史已存在的三个索引与 Product.updatedAt 默认值，避免后续 schema diff 误报/生成删除索引。无业务表删除或历史 SQL 改写。

## 回滚

- SQL 执行失败：空库引导事务自动回滚；增量升级发生失败时保留错误与备份，按失败项目检查实际执行状态，禁止用 resolve 掩盖部分成功。
- 本次字段为加法变更，回滚应用不需要立刻删列。**不能直接回到旧权限实现启动服务**：旧实现可能重新回填被撤销的权限、接受校区超管绑定，或覆盖菜单配置。
- 推荐停服后修复前进。确需回滚应用时，先在副本验证兼容补丁（至少保留迁移标记、超管/平台范围与撤权保护），校验逐账号权限不扩大后再切换。
- 若恢复整个升级前数据库备份，升级后的业务写入和授权变更会丢失；必须先冻结写入、导出期间变化并明确恢复点。不要为回滚权限功能直接恢复全库而忽略订单数据。
- 旧 AdminPermission/AdminRolePermission/AdminRole.menus 保留供核对，不是真实授权来源；不可将其直接恢复成当前权限，以免撤权失效。

最终复核日志：`/tmp/buchuqin-rbac-final-fresh-deploy.log`、`/tmp/buchuqin-rbac-final-upgrade-deploy.log`；当前两个库分别在 `...-final-fresh-diff.log`、`...-final-upgrade-diff.log` 确认 schema 无差异。旧 replay 库的 51 项记录属于上一轮快照演练，不混同本轮 52 项结果。
