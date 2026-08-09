# 不出寝食社 API

NestJS 11 实现的 MVP Mock API。当前不连接数据库，数据集中在 `src/mock/`，服务重启后恢复初始状态。

## 启动

```bash
pnpm install
pnpm start:dev
```

- API：`http://localhost:3000/api/v1`
- Swagger：`http://localhost:3000/docs`
- Mock 登录：`POST /api/v1/auth/mock-login`

除登录接口外均需携带 `Authorization: Bearer <token>`。

## 已实现的 MVP

- Mock 微信登录和 JWT
- 湖北工业大学默认校园
- 首页、分类、商品列表与详情
- 购物车增减
- 寝室地址和优惠券
- 两种配送方式的结算预览
- Mock 下单、支付成功、订单列表、履约轨迹和取消
- Mock 仓储/一级配送/二级配送状态推进、消息中心
- 送达后售后申请、自动审核与退款记录
- Swagger、DTO 校验、统一响应、单元测试与端到端测试

后续接数据库时，保留 Controller 和 Service，将 `MockStore` 替换为仓储层即可。
