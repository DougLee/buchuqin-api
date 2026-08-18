# 对内里程碑 API 契约（2026-08-15）

对应 Gitee issues：IK8W78 (A1) / IK8W79 (A2) / IK8W7A (A3) / IK8W7B (A4)。
决策依据：工作区 `docs/adr/0001`、`docs/adr/0002`。
统一响应包：`{ code, message, data }`（code=0 成功），鉴权 Bearer JWT，全局前缀 `/api/v1`。

## A1 文件上传（IK8W78）

- `POST /files/images` — multipart/form-data，字段名 `file`
  - 限制：单文件 ≤5MB，MIME 必须 image/*
  - 返回：`{ url: "https://<bucket>.cos.<region>.myqcloud.com/uploads/2026/08/uuid.jpg" }`（**腾讯 COS 绝对 URL**，ADR-0003；历史相对路径 /api/v1/uploads 仍可访问旧数据）
  - 权限：任意已登录角色（user / building-manager / fulltime-rider / parttime-rider / admin 系）
  - 存储：后端代理上传腾讯 COS（桶私有 + 对象 public-read ACL），路径 uploads/年/月/uuid.ext
  - 环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION /（可选）COS_PUBLIC_BASE_URL

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
- `DELETE /admin/staff/:id`（软删除：status=deleted）

### test-login（已于 IK9JHV / ADR-0004 彻底删除）
- 演示通道已下线，后台登录改用 `POST /auth/admin-login`（账号密码 + bcrypt，IK9JHP）
- 初始超管：`ADMIN_INITIAL_PASSWORD=xxx pnpm db:seed:admin`
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

---

# 功能与建模批次（2026-08-17，IK93GQ / IK8W5L / IK8W5H / IK8W5I / IK8W5U / IK8W5Y）

## B1 订单状态机 12 态（IK93GQ，PRD §11.1）

状态全集：`pending-payment / paid / picking / waiting-first-mile / first-mile / waiting-handover / last-mile / delivered / completed / cancelled / exception / refunded`

迁移（动作=操作角色）：`pay(用户/回调)`、`advance(admin，单步)`、`grab|accept(骑手)`、`pickup(骑手扫码)`、`depart(骑手)`、`arrive(骑手)`、`handover(骑手扫码)`、`receive(楼长)`、`start-delivery|delivered(楼长)`、`confirm-receipt(用户)`、`transfer|absent|refused|mark-exception → exception`、`售后通过 → refunded`。

- 用户端 `GET /orders`、`GET /orders/:id` 新增 **`statusPhase`**（`payment|fulfillment|done|exception`），前端 tab 直接映射；`delivering` 过滤参数含全部履约中状态（含 delivered）
- timeline 5 节点：`paid / picking / first-mile / waiting-handover（楼下待交接，arrive 写入）/ last-mile`
- exception 单用户端统一展示 `statusText:"履约异常，客服处理中"`；`delivered`（已送达待确认）与 `completed`（确认收货）已分离，`POST /orders/:id/confirm-receipt` 仅接受 delivered
- 售后：`delivered|completed` 均可申请（24h 从送达凭证时间起算）

## B2 财务结算（IK8W5L）

- `GET /admin/commission-rules` — 列表；`POST /admin/commission-rules` — `{ buildingId?, floor?, weightFrom?, weightTo?, mode?, price, effectiveAt? }`（维度 null=通配，命中维度多者优先、版本高者优先）；`PATCH /admin/commission-rules/:id` — `{ status?: active|disabled, price? }`（价格/状态变更版本自增，在途提成不追溯）
- `GET /admin/settlements?month=YYYY-MM` — 月度账单 BmBill 物化返回 `{ id, staffId, staffName, roleText, period, baseSalary, commissionTotal, adjustment, payable, status(pending-review|confirmed|paid), confirmedAt, paidAt }`（楼长底薪 500；已确认/已支付账单金额锁定）
- `POST /admin/settlements/:id/confirm` / `:id/pay` — 条件流转（未确认不可支付、重复操作 400）；pay 时同期 pending 提成置 settled
- `GET /fulfillment/commissions?month=YYYY-MM` — 从 Commission 记录读：`{ month, baseSalary, deliveryIncome, adjustment, payable, records:[{ id, orderNo, building, amount, status, fallback, remark, createdAt }] }`
- 任务卡 `commission` 字段与绩效 `income` 均与 Commission 记录同口径（未送达单按规则预览，无规则兜底 3 元/单并标 fallback）
- 退款跨期调整：settled 提成 → 负向 Commission(kind=adjustment) 挂当前月；pending 提成原地翻负对冲

## B3 微信登录（IK8W5H，env 门控）

- `POST /auth/wechat-login` — `{ code }` → wx.code2Session；`WX_APPID/WX_SECRET` 缺失返回 **501 `"微信登录未配置"`**（不回退 test-login）；成功 `{ token, user:{ id, campusId, role:'user', nickname, phone, avatar } }`（首登昵称"微信用户"）
- `POST /auth/phone` — `{ phone }`（用户 token）绑定手机号；简化版：直接传号，真实实现需小程序手机号授权码（见代码 TODO）

## B4 微信支付（IK8W5I，env 门控 + mock 回退）

- `POST /payments/wechat/prepay` — `{ orderId }`（用户 token）；商户 env 齐备 → `{ mock:false, payParams:{ appId, timeStamp, nonceStr, package, signType:'RSA', paySign } }`；缺失 → `{ mock:true, orderId, orderNo, amount, hint }`（前端改走 `POST /orders/:id/pay` 演示通道，**原通道保留**）
- `POST /payments/wechat/notify` — 微信回调（公开路由，响应裸 `{ code:'SUCCESS' }`）；AES-256-GCM 解密 + 复用 pay 条件更新幂等；验签 TODO；未配置 501
- `GET /payments/:orderId/status` — `{ orderId, orderNo, status, statusText, paid, paidAt, amount, mock }`
- 支付超时关单：Cron 每分钟扫 pending-payment 超 15 分钟（与用户侧懒执行并存）
- env：`WX_MCH_ID / WX_APIV3_KEY / WX_SERIAL_NO / WX_PRIVATE_KEY_PATH / WX_NOTIFY_URL`（见 .env.example）

## B5 抢单池与调配（IK8W5U / IK8W5Y）

- `GET /fulfillment/tasks/available` — 骑手角色专用（楼长 403）：本校园 `waiting-first-mile` 且 `riderId=null` 的任务（老单优先，金额为规则预览）
- `POST /fulfillment/tasks/:taskId/grab` — 与 accept 同语义同互斥（`taskId` 格式 `task-{role}-{orderId}`）
- `GET /admin/leave-requests` — 含 `staff:{ name, role, roleText, building, buildingId }`
- `POST /admin/dispatch-invitations` — `{ targetStaffId, buildingId, startAt, endAt, reward? }`；校验目标为在职楼长且非该楼绑定楼长
- `GET /admin/dispatch-invitations` / `POST /admin/dispatch-invitations/:id/cancel`（仅 invited 可取消，条件更新）
- 闭环：楼长请假（履约端已有）→ 平台邀请 → 楼长在履约端 accept（已有）

