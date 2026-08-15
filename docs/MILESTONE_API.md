# 对内里程碑 API 契约（2026-08-15）

对应 Gitee issues：IK8W78 (A1) / IK8W79 (A2) / IK8W7A (A3) / IK8W7B (A4)。
决策依据：工作区 `docs/adr/0001`、`docs/adr/0002`。
统一响应包：`{ code, message, data }`（code=0 成功），鉴权 Bearer JWT，全局前缀 `/api/v1`。

## A1 文件上传（IK8W78）

- `POST /files/images` — multipart/form-data，字段名 `file`
  - 限制：单文件 ≤5MB，MIME 必须 image/*
  - 返回：`{ url: "/api/v1/uploads/2026/08/xxxx.jpg" }`（相对路径，前端拼 baseURL）
  - 权限：任意已登录角色（user / building-manager / fulltime-rider / parttime-rider / admin 系）
  - 存储：`uploads/` 目录（gitignore），NestJS 静态服务挂 `/api/v1/uploads`
  - 幂等/安全：文件名随机化（uuid），保留扩展名

## A2 优惠券（IK8W79）

### 管理端
- `GET /admin/coupons` — 列表（现有，补充 total/remain 字段）
- `POST /admin/coupons` — `{ name, amount, threshold, total, expiresAt }` → 创建（status=active）
- `PATCH /admin/coupons/:id` — `{ status: 'active'|'paused' }`（下架后不可领不可用）
- `POST /admin/coupons/:id/issue` — `{ userIds: string[] }` 定向发放（每人生成一条 UserCoupon）
  - 校验：不重复发放（同券同人仅一条未使用记录）、不超 total

### 用户端
- `GET /coupons` — 返回 `{ claimable: Coupon[], mine: UserCoupon[] }`
  - claimable：status=active、未过期、claimed<total、本人无未使用记录的券
  - mine：本人 UserCoupon（含状态）
- `POST /coupons/:couponId/claim` — 领取 → UserCoupon(status='claimed')；幂等（重复领返回已有）；并发不超发
- 下单改动：`POST /orders/checkout` 与 `POST /orders` 的 `couponId` 字段语义改为 **UserCoupon id**
  - 校验：归属本人、status=claimed、未过期、金额达 threshold
  - 状态机：下单 → locked；支付成功 → used；取消/超时 → released（released 可再次选用）
- UserCoupon：`id, userId, couponId, status(claimed|locked|used|released), claimedAt`

## A3 楼栋寝室 + 员工（IK8W7A）

### 管理端
- `GET /admin/buildings` — `[{ id, name, floors, hasElevator, gender, roomsCount, staffName? }]`
- `POST /admin/buildings` — `{ name, floors, hasElevator, gender }`
- `PATCH /admin/buildings/:id` / `DELETE /admin/buildings/:id`（有寝室或在职员工时拒绝删除）
- `GET /admin/buildings/:id/rooms` — `[{ id, floor, roomNo, qrToken }]`
- `POST /admin/buildings/:id/rooms` — `{ floor, roomNo }`（qrToken 自动生成）
- `DELETE /admin/buildings/:id/rooms/:roomId`
- `POST /admin/staff` — `{ name, role, staffNo, buildingId?, status }`（role: building-manager|fulltime-rider|parttime-rider）
- `PATCH /admin/staff/:id` — 上述字段部分更新
- `DELETE /admin/staff/:id`（软删除：status=deleted，test-login 不再可用）

### test-login 兼容
- 现有 identity 语义不变（user / building-manager / fulltime-rider / parttime-rider / admin 系）
- 若传入 identity 为具体 staffNo 或 staff id，则映射到该员工记录（演示登录后台增删的账号）
- 新增 Building/Room 模型需 seed 迁移：从现有 Address.buildingName 归并生成

## A4 出入库 + 聚合 + 绩效（IK8W7B）

### 管理端
- `POST /admin/inventory/stock-in` — `{ productId, quantity, reason }` → InventoryTxn(type='stock-in')，product.stock += quantity
- `POST /admin/inventory/adjust` — `{ productId, delta, reason }` → InventoryTxn(type='adjust')，可正可负
- `GET /admin/inventory/txns?productId=` — 流水列表（时间倒序，含 operator/reason/关联）
- `GET /admin/dashboard` 增强：
  - `trend: [{ date: 'MM-DD', orders, paidAmount, newUsers }]` — 近 7 日，数据库聚合（缺数据日期补零）
  - `activities: [{ time, text, type }]` — 真实来源（最近订单事件 + 审计日志，取前 8 条）
  - 既有 KPI 保持并改为真实聚合

### 履约端（真实化）
- `GET /fulfillment/performance` — 从订单 timeline 计算今日完成数、准时率、凭证完整率（不再读 Staff 冗余字段）
- `GET /fulfillment/commissions` — 简化提成规则（本里程碑不做规则快照）：每单按 `2 + floor重量档` 元或固定 3 元/单（实现时定死一个常量并注释），按实际配送人归属，数据来自真实订单

## 前端对接要点（B/C/D 线）

- 凭证/售后图片：`uni.chooseImage` → 上传（H5/小程序分通道）→ 拿 url → 随动作/表单提交
- 用户端 coupons 页：改用 `GET /coupons` 新结构 + 领取按钮；checkout `couponId` 改传 UserCoupon id
- 履约端 KPI/profile：接真实 performance/commissions 返回
- admin 四板块写操作 + dashboard trend/activities 消费新字段
