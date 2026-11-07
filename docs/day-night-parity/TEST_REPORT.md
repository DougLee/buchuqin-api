# 测试执行与证据

2026-11-08。功能验收采用冻结40项/100权重；自动化通过率、118场景清单和功能权重分别统计，不相互替代。真实微信能力没有混入H5/测试渠道结果。

| 执行入口 | 当前结果 | 证据 |
| --- | --- | --- |
| API `jest --runInBand` | 77套件、661/661通过，无跳过 | evidence/api-full-local-final.log |
| API `jest --config test/jest-e2e.json --runInBand` | 1套件、5/5通过 | evidence/api-http-e2e-final.log |
| 用户 `node --test scripts/test-*.mjs` | 49/49通过 | evidence/user-node-tests-final.log |
| 后台 `node --test scripts/test-*.mjs` | 25/25通过 | evidence/admin-node-tests-final.log |
| 配送 `node --test scripts/test-*.mjs` | 20/20通过 | evidence/delivery-node-tests-final.log |
| API隔离与验收适配守卫 `node --test scripts/test-night-isolation.mjs scripts/test-remote-night-acceptance.mjs` | 5/5通过，离线否定测试未连接生产 | evidence/network-isolation-final.log |
| 历史迁移兼容脚本 | 旧库存、备货、在配订单、条码、仓库补链和菜单授权通过 | evidence/migration-remote.log |
| TEST最终正常HTTP补验 | 重复建店拒绝；暂停领券不作废已领券；取消测试单恢复库存和券 | evidence/final-http-checks.log |
| TEST只读账本 | 押金流水平衡、零开放夜宵订单/零待审单/零未知退款，仓库预留为0 | evidence/test-ledger-final.json |

以上计数合计765个自动化断言用例通过，不含浏览器操作数量和迁移场景，也不重复累加多轮回归。没有代码覆盖率采集，不能据此声称95%代码覆盖率。

## 环境、运行方法和真实性

最终API完整回归使用本机独立PostgreSQL数据库`night_parity_spec`的新schema `night_stock_parity_full7_20261108`。`PARITY_LOCAL_DEBUG=1`与15449端口仅允许此库，runner强制NODE_ENV=test及HTTP出站白名单。顺序为`run-parity-spec.mjs prisma db push --skip-generate`、seed、`prepare-parity-baseline.mjs`、Jest全量、HTTP E2E。各轮使用新schema，不重置共享TEST或生产。基线仅补历史org-a/总部/官方伪校区和第二测试用户；未伪造测试主体的库存或资金结果。

两小程序在本地H5，后台使用本地Vue后台，正常业务HTTP连接`admin-test.buchuqin.com`，只有验收组织`夜宵部署验收20261107`被允许测试写入。商品/备货/订单/售后/库存/佣金执行真实业务服务和真实数据库。微信身份兑换、支付退款及对象存储外部边界使用明确标识的验收适配；H5弹窗写明不会真实扣款。图片通过实际文件input、鉴权、压缩及TEST持久存储路径；自有静态图标是测试图片，不能称作真实商品/送达实拍。

浏览器实际动作逐条见[evidence/browser-acceptance.jsonl](evidence/browser-acceptance.jsonl)，包含商品编辑→详情、日夜条码、推荐/秒杀/券、支付恢复精确清车、备货实收/报损、履约凭证/退款、角色入口、朋友/朋友圈等价深链、响应式。部分旧流程兼容证据保留原日期于`docs/night-store/evidence/test-env-20261107`的52个TEST场景，未冒充本轮重新点击全部按钮。

## 构建、类型和发布隔离

API `tsc --noEmit`及Nest build；后台`vue-tsc --noEmit`及Vite build；两小程序`vue-tsc --noEmit`及不出寝品牌H5/MP-WEIXIN构建通过。构建显式使用TEST API；发布产物扫描没有`__night-preview`、`LOCAL_PREVIEW_ONLY`或本机模拟支付分支。H5开发态入口仅loopback+本机Origin+显式标记开启，不进入发布包。用户MP构建的循环依赖已消除。

既有Sass @import弃用和后台大chunk提示仍存在，构建成功；没有把这些提示当作功能阻断或静默隐藏。

## 失败、修复与跳过说明

最初全量回归真实失败已保留round1/round2日志。修复品牌测试配置与陈旧断言、隔离夹具基线、单角色写入/旧混合授权兼容等；恢复两条强RBAC断言后31/31通过。没有删除失败测试或调低校区/权限/资金断言来过绿。

新增实际缺陷包括日夜上下文晚到响应、秒杀活动ID迁移、登录校区确认误拒、购物车支付精确消费/队列、首页scoped礼包和旧浮层、token刷新永久loader、白天条码缺失、订阅API异常阻断支付、订单UTC/终态显示、失效活动车行反馈和到期时钟。先红后绿日志及审查记录见REVIEW_01和evidence；最终全量无跳过。

旧`test-night-stock.mjs`是同一Jest入口包装，本轮全部night suite已包含于全量661，不重复算。旧`test-night-stock-http.mjs`、`test-night-workspace-http.mjs`、`test-night-security-http.mjs`、`test-night-store-state-http.mjs`、`test-night-preview-data.mjs`绑定已退役本地3150服务、`night_stock_preview_20261106`固定夹具/私有JWT材料；当前未恢复旧服务或向共享库伪造夹具。对应库存/状态/越权/工作台行为由本轮真实PostgreSQL集成、当前HTTP E2E、H5角色检查及原52个TEST场景替代验证。这些旧环境专用脚本不能计作本轮新执行通过，迁移脚本和安全守卫已单独执行。

真实微信身份手机号、收银台、真实退款到账、订阅推送、相机设备、电话与原生分享缺少真机执行，P40保留未验收。夜宵抽奖尚未开放，P08保留未完成。其余38项按矩阵列明证据验收；118清单的7个原生复合场景保持未勾选，见CHECKLIST_RESULTS。
