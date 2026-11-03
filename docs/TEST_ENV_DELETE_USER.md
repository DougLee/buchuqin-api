# 测试环境删除用户标准操作（SQL 手册）

> 2026-11-03 IKSN19 测试期整理。适用：测试环境 139.199.3.190（容器
> `1Panel-postgresql-rbaV`，库 `buchuqinshishe`，用户 `nongmo`）。
> **仅限测试环境**——生产环境删除用户是破坏性数据操作，必须道哥逐次批准。

## 使用方式

把下文 SQL 里的 `:OPENID` 替换成目标用户的 openid（推荐入口，从
admin 用户列表/开发者工具都能拿到；只有 userId 时把条件换成
`id = ':USER_ID'`）。通过 ssh + psql heredoc 执行（注意 `docker exec -i`
接 stdin，SQL 里的驼峰列名必须带双引号）：

```bash
ssh root@139.199.3.190 "docker exec -i 1Panel-postgresql-rbaV psql -U nongmo -d buchuqinshishe" <<'EOF'
-- 这里贴 SQL
EOF
```

三步走：**① 只读盘点 → ② 事务删除 → ③ 复核**。删除前先跑 ①，
确认关联数据量符合预期（避免删错人/漏关联）。

## ① 只读盘点

```sql
WITH u AS (SELECT id FROM "User" WHERE openid = ':OPENID'),
o AS (SELECT id FROM "Order" WHERE "userId" IN (SELECT id FROM u))
SELECT 'User(主行)' t, count(*) FROM "User" WHERE id IN (SELECT id FROM u)
UNION ALL SELECT 'Order(订单)', count(*) FROM "Order" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'Refund(退款)', count(*) FROM "Refund" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'RefundItem(退款明细)', count(*) FROM "RefundItem" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "userId" IN (SELECT id FROM u))
UNION ALL SELECT 'Commission(佣金)', count(*) FROM "Commission" WHERE "orderId" IN (SELECT id FROM o)
UNION ALL SELECT 'TransferLog(流转日志)', count(*) FROM "TransferLog" WHERE "orderId" IN (SELECT id FROM o)
UNION ALL SELECT 'UserCoupon(券)', count(*) FROM "UserCoupon" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'CartItem(购物车)', count(*) FROM "CartItem" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'Address(地址)', count(*) FROM "Address" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'Notification(通知)', count(*) FROM "Notification" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'UserEvent(埋点)', count(*) FROM "UserEvent" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'LotteryDraw(抽奖)', count(*) FROM "LotteryDraw" WHERE "userId" IN (SELECT id FROM u)
UNION ALL SELECT 'RecruitingApplication(楼长报名)', count(*) FROM "RecruitingApplication" WHERE "userId" IN (SELECT id FROM u);
```

## ② 事务删除（整体执行，任一步失败自动回滚）

```sql
BEGIN;
DELETE FROM "RefundItem" WHERE "refundId" IN (SELECT id FROM "Refund" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID'));
DELETE FROM "UserEvent" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "RecruitingApplication" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "CartItem" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "UserCoupon" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "Address" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "Notification" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "LotteryDraw" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "Commission" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID'));
DELETE FROM "TransferLog" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID'));
DELETE FROM "Refund" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "Order" WHERE "userId" IN (SELECT id FROM "User" WHERE openid = ':OPENID');
DELETE FROM "User" WHERE openid = ':OPENID';
COMMIT;
```

## ③ 复核

```sql
SELECT count(*) AS 残留主行 FROM "User" WHERE openid = ':OPENID';
SELECT count(*) AS openid占用 FROM "User" WHERE openid = ':OPENID';  -- 应为 0
```

## 要点说明

- **删除顺序即外键依赖顺序**：子表（券/购物车/退款明细/佣金/流转日志）先于
  主表（订单/用户）；`RefundItem` 是 `Refund` 的子表，最先删。
- **openid 写错的兜底**：所有子查询按 openid 实时查 `User`——openid 不存在
  时子查询为空，全部 `DELETE 0`，无害。所以跑 ① 盘点确认主行 = 1 再执行 ②。
- **删完即新用户**：openid 释放后该微信重开小程序静默登录会重新建档
  （走 IKSN19 校区确认页 + 注册发新人券），可直接当验收号。
- **不覆盖的关联**：员工档案（`Staff`）走 openid 绑定但独立于 `User` 表，
  如目标曾绑定员工/楼长（`RecruitingApplication.staffId` 非空），需另行
  处理 Staff（测试环境一般不会发生）。
