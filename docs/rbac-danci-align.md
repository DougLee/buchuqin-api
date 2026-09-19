# RBAC 对齐蛋词体系（feature/rbac-v1，2026-09-19 道哥拍板 B：全盘照搬模式）

参照：dancikeji-api（cool-admin，`base_sys_menu` 一体树 + role_menu + URL 匹配判权 + 前端菜单树/按钮指令）。

## 对齐清单（模式照搬）

| 蛋词实现 | buchuqin 落地 | 说明 |
|---|---|---|
| menu 表（type 0 目录/1 菜单/2 按钮，parentId 树，perms 逗号串） | `AdminMenu` 实体（同构字段） | 菜单+按钮权限合一棵树，后台可维护 |
| role_menu（勾菜单即勾权限，一体） | `AdminRoleMenu`（roleId+menuId） | 替代 role.menus + role_permissions 两层 |
| 判权=perms 与 URL 匹配（Redis 缓存） | PermsGuard：用户 perms=角色菜单树按钮行 perms 并集（缓存+rbacVersion 失效）；**perms=「METHOD 路径模式」**（如 `PATCH /admin/products/:id`），`:seg` 通配；不匹配即 403 | 适配 RESTful（蛋词动作式 URL 直译不适用）；Redis 不引入，用进程内缓存（单实例） |
| permmenu 契约 `{perms, menus}` | `GET /admin/rbac/permmenu` 同构返回 | 前端一棵树 + 按钮码 |
| 菜单后台 CRUD（增删改排序/图标/显隐） | `/admin/rbac/menus` CRUD | 新按钮/新菜单行随代码发版幂等 upsert（按 code），已有行尊重后台修改 |
| 前端动态路由（viewPath→组件） | 前端组件映射表（viewPath→静态 import 组件）+ 菜单树驱动路由注册 | 组件仍是代码产物；菜单行可重排/改名/指向已有组件 |

## 保留 buchuqin 内核（不搬蛋词的坑）

1. 密码 bcrypt（蛋词 md5 不搬）；JWT secret 无弱默认；7 天过期。
2. 会话版本 sv 即时踢线（蛋词 Redis passwordVersion 同语义，实现保留 sv，无 Redis 依赖）。
3. 超管=super-admin 角色通配（蛋词 userId==1 硬编码不搬）；内置行不可删改。
4. 免权白名单收窄为显式清单（登录/验证码/健康检查/公开回调），不做 `/comm|/open` 整段前缀放行。
5. 审计同事务保留（蛋词审计缺失不搬）。
6. 校区数据范围（AdminAccountRole platform/campus）正交保留——蛋词 role_department 的对应物。

## 数据迁移（增量，可回滚）

- 新表：`AdminMenu`（id/parentId(自关联树)/name/type(0目录1菜单2按钮)/perms(逗号分隔 URL 模式)/path(前端路由)/viewPath/icon/orderNum/isShow/status/builtin/code(唯一,代码登记锚点)）、`AdminRoleMenu`（roleId+menuId 唯一）。
- 旧 `AdminPermission`/`AdminRolePermission`/`AdminRole.menus` 退役（保留数据不删，权限真源切换到 AdminMenu）。
- 灌注源：registry.ts 升级为树形登记（目录→菜单→按钮(=旧权限码)→按钮 perms=URL 模式表）；启动幂等 upsert（按 code；已有行不覆盖后台修改）。
- 存量角色迁移：role_permissions → role_menu（按钮行 id）；role.menus → role_menu（菜单行 id）。

## perms URL 模式表（按钮行内容，鉴权唯一真源）

由现有 121 端点的 requirePerm/authorize 调用面整编（registry SECTION_ACCESS_CODE + 细粒度端点清单），形如：

```
商品改价 products.price → PATCH /admin/products/:id
商品上下架 products.status → POST /admin/products/batch-status, PATCH /admin/products/:id
账单确认 finance.confirm → POST /admin/settlements/:id/confirm
...
```

漏配=403（fail-closed），集成测试全端点×四角色矩阵扫描兜底。

## 阶段

1. 后端数据层：AdminMenu/AdminRoleMenu + 树形登记 + 启动迁移（本批）
2. 后端鉴权切换：PermsGuard URL 匹配（controller requirePerm 全撤）+ permmenu 端点 + 全端点矩阵测试
3. 前端：RolesPage 一棵树（目录/菜单/按钮勾选）+ 菜单管理页 + permmenu 消费 + 组件映射动态注册
