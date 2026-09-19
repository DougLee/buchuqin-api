# RBAC V1 权限改造（feature/rbac-v1）

日期：2026-09-19
状态：待评审（未合并 main、未部署生产）

## 1. 模型

```
AdminAccount ──< AdminAccountRole（scope: platform|campus + campusId）>── AdminRole ──< AdminRolePermission >── AdminPermission
                                                                    └── RbacState（全局版本号，缓存失效）
```

- 账号多角色；权限永远经角色获得（无账号直授权）。
- 绑定带生效范围：`platform`=平台级（跨校区），`campus`=指定校区（campusId 非空，DB CHECK 约束，不用空串冒充全部校区）。
- 有效权限（上下文校区 C）= 平台级授权全部权限 ∪ 校区级（campusId=C）授权的**校区业务码**。
  平台功能码（rbac.*/purchase.*/products.official.*/campuses.manage/restock.manage）仅平台级授权可获得。
- 内置 `super-admin`：通配全量（不落 AdminRolePermission 行，无法被改权/删权）；唯一可管理角色/账号授权的角色。
- 会话版本 `AdminAccount.sessionVersion` 进 JWT（`sv`）：停用/改密/授权变更 bump → 旧 token 即刻 401。
- 缓存：`(accountId, sv, rbacVersion, campusId)` 键 + 15s TTL；授权读取失败默认拒绝。

## 2. 旧→新迁移对照（基线：permissions.ts ADMIN_MATRIX，2026-08-18 签字版 + 后续修订）

| 旧角色 | 迁移落点 | 说明 |
|---|---|---|
| admin | super-admin（平台级） | 全量通配，原样保留（不降级） |
| hq | 模板 `hq-director`（平台级） | 跨校区只读 + 官方库/类别/总部仓库存/库位/订货批次/采购/经营日报/校区本体/账号查看/用户/审计 |
| operations | 模板 `campus-operations`（校区级） | 按 {旧campusId ∪ 旧AdminCampusAccess} 逐校区授角色 |
| warehouse | 模板 `campus-warehouse`（校区级） | 同上 |
| finance | 模板 `campus-finance`（校区级） | 同上 |

迁移由启动同步（RbacService.onModuleInit）幂等完成：仅处理「AdminAccountRole 零行 + role 为旧五角色」的账号；模板角色 `seeded=false` 时首灌权限集。**旧 write 持有者在新粒度下拿齐拆分码（不缩水）。**

### 明确的权限变化（需道哥确认）

| # | 变化 | 理由 |
|---|---|---|
| 1 | 旧 hq 的「账号管理写」收窄为「账号查看」；账号管理/角色管理仅超管 | goal 第三节：V1 仅超管管理角色权限及账号授权 |
| 2 | 超管（原 admin）可以下校区订货单（旧 admin 被「订货由校区发起」拦截） | 超管通配；低风险 |
| 3 | 修复类：招募列表不再返回身份证/运营备注（新增专用端点+权限）；C 端报名进度不再回显后台补录的证件/备注；staff body.campusId 越校区写入被拦；buildings ?campus 越权参数被拦；审计不再落身份证明文 | goal 安全要求 |

## 3. 权限点登记（src/admin/rbac/registry.ts）

- 9 分组约 60 码；scope=platform/campus；启动同步入库（AdminPermission，只增不删）。
- 旧 authorize(section, access) 调用面经 SECTION_ACCESS_CODE 映射；细粒度端点直接 requirePerm：
  - 商品：products.write（普通编辑）/ products.price（价格字段）/ products.status（上下架）/ products.official.*（官方库）
  - 库存：inventory.inbound（直接入库，平台）/ inventory.adjust（调整盘点）/ inventory.outbound（订单出库）/ locations.*
  - 订货采购：restock.order（校区）/ restock.manage（批次+审单+发货，平台）/ purchase.*
  - 招募：recruit.read / note / interview / approve / reject / idcard.read / idcard.write
  - 财务：finance.read / confirm / pay / rules.write
  - 账号权限：rbac.accounts.* / rbac.roles.* / rbac.permissions.read / rbac.audit.read
  - 其它：users.phone.reveal（明文手机号单列）；campuses.config.write（本校区配置）与 campuses.manage（本体，平台）拆分

## 4. 关键安全修复清单（相对 main）

1. JWT 角色串不再作为权限依据（每请求查库+缓存）；停用/撤权/改密即时生效（sv）。
2. 默认拒绝：AdminController 全量挂 AdminAuthGuard，未登录/非后台账号/无权限码一律 403/401。
3. campusScope 服务端校验 ?campus 真实性；校区级授权忽略客户端校区参数（恒上下文校区）。
4. 招募证件白名单：列表/补录响应脱敏；专用读取端点（权限+敏感审计）；照片 COS 私有目录 app/idcard（private ACL + 5 分钟签名 URL）；上传须 recruit.idcard.write。
5. C 端 /recruit/application 不再回显 idCardNo/idCardImages/staffRemark。
6. staff 建改、buildings 查询的 body/query campusId 越权收口。
7. 授权/撤权/角色/账号变更与审计同事务落库；超管保护（advisory lock 串行 + 最后一名校验）。

## 5. 部署与回滚（生产，需道哥批准后执行）

部署：
1. `pnpm db:migrate`（=prisma migrate deploy，只跑 20260919150000_rbac_v1：AdminAccount 加列 + 五张新表，前向无破坏）。
2. 发新 API 镜像/产物；启动即同步权限/角色/旧账号绑定（幂等）。
3. 发新 admin 前端。
- 旧 token（无 sv）视为 sv=0 继续有效；权限按新体系实时计算，无需强制重登。
- 停用/改密后才强制 401。

回滚：
1. 回滚 API 到旧版本即可——新表/新列对旧代码零影响（旧代码不读它们；AdminAccount 旧列语义未动）。
2. 期间产生的 AdminAccountRole 数据保留，重发新版本自动续用。
3. 不需要降迁移（无删列/改列）。

## 6. 测试

- 单测：rbac.spec（冻结旧矩阵为基线，断言迁移无缩水 + authorize 新语义）+ 全套件回归。
- 集成：rbac.integration.spec（独立 PostgreSQL buchuqin_rbac_test，HTTP 层 supertest）：多角色并集/校区隔离/撤权余权/停用与旧 token/越权参数/敏感字段/超管保护/审计。

## 7. 遗留与风险

- 历史已上传的身份证照片仍是旧公开 URL（改造只覆盖新上传）；可选跑一次批量转私。
- 订单详情/打印机 key 等存量敏感回显未动（履约需要，保留现状，见盘点报告）。
- 前端 DataPage 内 recruit/用户明文按钮的显隐为体验层，真实拦截在服务端。
