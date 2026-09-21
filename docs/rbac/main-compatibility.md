# 本地主线兼容记录

2026-09-21 固定对照：API main `a152b8dd09e1ac1db452aedb9c231e8c2fbc2d1e`；后台 main `46cabc0572cae8d62a963002e7e2e3ce181b166b`。权限改造仍在各自 feature/rbac-v1 工作树中，未合并或提交。参考 breeding 两个项目只读。

| 主线变化 | 合入本地工作树的行为 | 验证 |
|---|---|---|
| 新订单通知、水位线 | 保留 new-order-watch、轮询、声音解锁与标题提示，后台入口按有效权限显示 | 139 路由目录含新增端点；完整回归、后台构建 |
| 小票日序号与打印 | 原始 daily_seq_receipt SQL、打印格式/模板与测试 | printer service/spec 与固定 main 无差异；完整回归 |
| 秒杀双渠道 a152b8d | asSeckill 身份、正常渠道原价、秒杀限购/库存校验 | business controller/dto/seckill 测试与 main 无差异；新增 CartItem SQL 已在两个隔离迁移库 deploy |
| 秒杀分类 d611620 / 46cabc0 | API categoryId 过滤及后台分类下拉；按分类查看权限加载候选 | promotions.spec、全量回归、vue-tsc/Vite |
| 异常处理 350950f / 7331397 | 异常独立 Tab、工作台带参跳转；标记/解除异常统一原因弹窗 | 已核对 DataPage/Dashboard；权限按 POST order status；构建通过，未声称本轮浏览器逐项复测异常业务 |
| 官方商品价格、促销搜索及订单利润展示 | 保留既有同步与展示口径；内部导航使用动态 menuPath | official-library/business/promotion 领域测试；模块动态路径测试 |

API AdminService 相对 main 的差异集中于 RBAC、校区过滤、敏感审计和批次财务汇总隔离；业务服务仅保留招募审计快照脱敏差异。改订单状态注释同步为正式运营说明。未覆盖主线的代码版本指以上固定 SHA，后续新增提交需要再核对。

本轮完整 API：40 套、281 测试通过，`/tmp/buchuqin-rbac-main-compat-full.log`；API 类型检查 `...-main-compat-tsc.log`；后台 vue-tsc/Vite `...-main-compat-build.log`。这些证明本地回归，不代表生产部署或真实打印/COS 服务验收。
