# 夜宵备货、盘点报损与商品管理验收

日期：2026-11-06。业务基线见 `APPROVED_STOCK_WORKFLOW.md`。

## 本期交付

- 后台夜宵商品库：从官方库搜索勾选导入，复用校区实物 SKU；默认下架，确认夜宵售价后上架。导入不增加库存。
- 后台备货审核与出库：整单通过/驳回、审核预留共享仓库、整单出库、审核后未出库取消。
- 楼长备货：显示库存货值、备货预占和可用额度；申请不入库；待审核可撤回；已出库逐项确认实收，一次完成收货。
- 少收自动报损；差额审核通过才释放。驳回继续占用，楼长可补充说明重新报审。
- 楼长盘点/店内报损：申报先冻结盘亏和损耗数量，批准确认损耗、驳回恢复；盘盈批准才入库。保留草稿和原库存版本，库存变化后要求刷新重盘。
- 商品管理：搜索、可售筛选、上下架、可售/待配送/冻结数量、历史货值及库存流水。
- 历史货值：申请/收货锁定原价格，后续调价不重估；下单至送达继续占额度，取消按原货值回补，送达释放。未送达退款不回库转报损审核。
- 兼容校区总部到货：按官方来源匹配实物行时排除夜宵渠道副本，防止入错库存。
- 修复已有入口问题：白天主动进入夜宵工作区、白天未完单空态判断、待办与历史订单分页、取消/退款记录入口、收入结算状态、主页新单刷新、前台模式切换与原生 tab 恢复。

## 主要接口

楼长接口前缀 `/api/v1/night-rider/night`，仍使用员工 JWT 与本人绑定店铺校验。

| 方法与路径 | 用途 |
| --- | --- |
| GET `/stock/pool` | 可备货商品及共享仓库可用量 |
| POST `/stock/orders` | 申请备货；`requestId` 幂等；商品数量与售价快照 |
| GET `/stock/orders` | 备货记录 |
| POST `/stock/orders/:id/cancel` | 待审核撤回，需原因 |
| POST `/stock/orders/:id/receive` | 一次填写所有商品实际数量，范围 0..出库数 |
| GET/POST `/inventory/reports` | 查看记录、提交盘点或报损 |
| POST `/inventory/reports/:id/resubmit` | 被驳回收货/订单损耗补充重报 |
| GET `/inventory/txns` | 最近200条可售库存流水 |
| GET `/products` | 库存数量、版本、历史货值、售卖状态 |

后台接口前缀 `/api/v1/admin/night`，使用现有 AdminAuthGuard 权限与校区范围校验。

| 方法与路径 | 用途 |
| --- | --- |
| GET `/catalog/candidates`，POST `/catalog/import` | 官方资料导入 |
| GET `/stock-orders` | 备货审核列表 |
| POST `/stock-orders/:id/review` | 整单审核 |
| POST `/stock-orders/:id/ship` | 整单出库 |
| POST `/stock-orders/:id/cancel` | 未出库取消 |
| GET `/inventory-reports` | 盘点/损耗审核列表 |
| POST `/inventory-reports/:id/review` | 盘点/损耗批准或驳回 |

备货状态：`requested → approved → shipped → received`；`requested → rejected/cancelled`；`approved → cancelled`。旧 `completed` 单保持历史已入库，不重新执行。

报告状态：`pending → approved/rejected`。普通报告驳回恢复冻结库存；收货/退款未回库损耗驳回仍占额度，可重报。

## 已完成验证

1. `node scripts/test-night-stock.mjs --skip-push --all-night`：3套、26项全部通过，使用 `_spec` 数据库独立 `night_stock_workflow_20261106` schema。覆盖完整备货、并发额度与仓库库存、撤回取消、重复收货、少收重报、冻结恢复、盘盈、版本过期、改价、跨店、销售取消/送达、退款回库/报损、退押正常并发、总部到货共享仓兼容。
2. `node scripts/test-night-stock-http.mjs`：通过真实 HTTP 校验 JWT 登录、负数量 DTO 拒绝、员工与后台隔离、跨校区列表/导入/审核/出库/取消/报损审批的 403 拒绝。只连接本地3150及独立预览 schema。
3. `node scripts/test-night-stock-migration.mjs`：旧模型生成独立迁移 schema，带旧楼栋库存、已入库备货单、在配/取消订单、条码和菜单后执行迁移。验证旧库存数量不变、货值回填、已回库标识、缺仓库补链不造库存、旧备货不重复入库及菜单扩展。
4. API `npm run build`；后台 `npm run build`；配送端 `npm run type-check`、`npm run build:h5:buchuqin`、指定测试 API 的 `npm run build:mp-weixin` 均通过。
5. gstack `/browse` 浏览器联调：楼长申请薯片2袋，校区审核并出库2袋，楼长实收1袋，自动生成1袋收货差异报损。批准后预占从4.50元降至0，本店库存增加1袋，历史货值135元变139.50元。导入额外官方饼干后默认下架、共享仓库库存0。盘点/损耗填写数量与说明后进入商品页再返回，草稿保留。

## 扩展回归中的既有失败

`node scripts/test-night-stock.mjs --skip-push --rbac`：6套中3套通过、3套失败；54项通过、69项失败。失败集中在旧集成夹具未初始化菜单及尝试通过已禁止的接口授予内置 `super-admin`。相关 RBAC 服务/集成测试文件在本次 diff 中未修改，没有为跑绿而放宽权限。**本仓库全套测试未宣称通过**；本期新接口权限另以真实 HTTP 用例验证通过。

## 验证边界

- 所有写入均为本地服务及测试主机 `_spec` 数据库的独立 schema；没有迁移共享测试业务 schema，没有修改或部署生产。
- 微信真机选图、上传、支付未做端到端实测；H5业务操作和微信小程序编译已验证。
- 退出清算及资金未知状态机属于本期明确暂不考虑的范围。正常退押已与新增备货互斥；既有微信退押网关超时后可能出现资金结果未知，本地事务回滚不能代表微信未受理，仍须后续查单及持久退款预留方案，不能把该异常链路视为完整闭环。

## 本地复现

API worktree 先构建，然后运行 `node scripts/preview-night-stock.mjs`。脚本严格限定 `_spec` + `night_stock_preview_20261106`，本地 API 为3150；支付环境变量置空。预览登录材料仅写本机 `/tmp/night-stock-preview.json`，不提交仓库。

配送 worktree：

```sh
VITE_DEV_PORT=5192 VITE_API_PROXY_TARGET=http://localhost:3150 VITE_API_BASE_URL=/api/v1 npm run dev:h5:buchuqin
```

后台 worktree：

```sh
VITE_API_PROXY_TARGET=http://localhost:3150 npm run dev -- --port 5191 --host 127.0.0.1
```

配送 H5：`http://localhost:5192/h5/delivery/m/#/pages/night/home`；后台：`http://localhost:5191/#/night-stores`。普通配送开发代理默认仍为 `admin-test.buchuqin.com`；上述独立预览使用显式代理覆盖。

### H5 夜宵测试登录入口修复

原5188入口写死的夜宵 JWT 在2026-11-06 17:58:16过期，401后触发H5不支持的微信重登，显示登录失败。已删除该夜宵固定令牌：点击「夜宵楼长」转到5192的 `/__night-preview/start`，本机Vite使用独立预览密钥即时签发会话，再进入夜宵首页。此中间件仅开发模式启用，限本机请求及3150独立API，只接受固定验收校区/员工，不向共享测试或生产API提供会话。

验证：`node --test scripts/test-night-preview-login.mjs`（配送worktree，3项通过）、`npm run type-check`通过；浏览器从5188实际点击入口，确认跳转5192、显示方福宁且无登录失败提示。无需再将JWT粘贴到源码。

迁移文件：`prisma/migrations/20261106100000_night_stock_workflow/migration.sql`。它包含旧库存货值/订单回填及现有夜宵菜单权限扩展，不能以只推 schema 替代业务迁移。
