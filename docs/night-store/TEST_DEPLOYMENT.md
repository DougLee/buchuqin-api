# 夜宵四端测试环境启动与发布

API、管理后台、用户小程序、配送小程序均使用 `feature/night-store`，本轮四端都有代码变更，必须配套发布。版本见 [RELEASE_VERSIONS.json](RELEASE_VERSIONS.json)，结论见 [ACCEPTANCE_REPORT.md](ACCEPTANCE_REPORT.md)。本任务没有发布生产。

## 环境边界

- **禁止连接生产API、生产数据库或生产微信商户测试。** 远程业务API仅允许 `https://admin-test.buchuqin.com/api/v1`。
- 本轮实际联调为本机API3150 → 测试库 `buchuqinshishe_spec` 的独立 schema `night_stock_preview_20261106`；集成测试使用 `night_stock_workflow_20261106`，迁移兼容测试另建临时schema。
- 外部微信支付/退款结果使用明确标识的本机模拟；内部订单、库存、额度、券、佣金和流水使用真实服务与数据库。界面明确提示不会真实扣款，不能当作微信收银台通过。
- 写入脚本校验 `_spec` 库名和独立schema；预览API启用出站白名单、清空微信/COS凭证，三端开发响应以CSP限制外部资源。否定生产地址的防护测试先替换底层网络为离线桩，没有发送真实请求。
- 不提交或部署 `.env`、本机JWT、`/tmp/night-stock-preview*.json`、商户私钥或管理员密码。预览登录/模拟支付中间件仅开发服务有效。

## 本机启动和账号

四仓库并列放置；API预览从相邻用户仓库读取本地商品图片。安装各仓库锁文件对应依赖。API `.env` 的 `DATABASE_URL` 必须已经指向独立 `_spec` 测试库，不能取消脚本检查改用业务库。

API仓库：

```sh
npm run db:generate
npm run build
node scripts/preview-night-stock.mjs
```

等待API成功启动后再操作H5。首次同步独立预览schema、准备权限与数据，监听3150；已有结构且无新增迁移时可用 `--skip-push`；`--prepare-only --skip-push` 只准备数据，不启动第二个API。初始化由数据库标记防重复，保留手工验收数据与管理员密码，不要删除标记重新覆盖数据。

后台仓库：

```sh
VITE_API_PROXY_TARGET=http://localhost:3150 npm run dev -- --port 5191 --strictPort
```

配送仓库：

```sh
VITE_API_PROXY_TARGET=http://localhost:3150 VITE_API_BASE_URL=/api/v1 VITE_DEV_PORT=5192 npm run dev:h5:buchuqin
```

用户仓库：

```sh
VITE_API_PROXY_TARGET=http://localhost:3150 VITE_API_BASE_URL=/api/v1 VITE_DEV_PORT=5193 npm run dev:h5:buchuqin
```

| 入口 | 账号/用途 |
| --- | --- |
| `http://localhost:5191` | 夜宵验收管理员；用户名/密码由API脚本存于本机0600权限的 `/tmp/night-stock-preview.json`，不提交其内容 |
| `http://localhost:5192/__night-preview/start` | 正式楼长方福宁，西区9栋，服务端签发本机会话 |
| `http://localhost:5193/__night-preview/start` | 用户 `night-demo-customer-0`，已绑定测试手机号，西区9栋201/202地址 |

夹具覆盖多楼栋/校区/角色、招募中/营业/休息、21种楼栋商品、20种可备货商品、备货各状态、差异/盘点/损耗、订单取消退款完成、押金退款、超过一页的收入。当前手工配置20:00–06:00、夜间运费2元、方福宁店营业；时段外显示休息，禁止新单。号码均为夹具，不实际拨打。端口已占用时核对PID/cwd，不关闭其他工作树服务。

补充数据脚本均只允许独立预览schema：

```sh
node scripts/test-night-preview-data.mjs
node scripts/prepare-night-campus-preview.mjs
node scripts/seed-night-finance-preview.mjs
node scripts/seed-night-income-preview.mjs
```

分别检查数据、准备跨校区组织选择、财务和收入分页。收入脚本要求先在H5实际上传一次送达凭证，按固定请求号通过真实下单/支付落账/接单/送达生成订单；外部付款仍模拟。这些不是发布初始化脚本。

## 测试命令

API必须使用环境守卫入口，不能用默认 `.env` 裸跑 Jest/迁移测试：

```sh
node scripts/test-night-stock.mjs --all-night
node scripts/test-night-stock-migration.mjs
node --test scripts/test-night-isolation.mjs
node scripts/test-night-security-http.mjs
node scripts/test-night-workspace-http.mjs
node scripts/verify-night-preview-ledgers.mjs
node scripts/verify-night-preview-catalog.mjs
node scripts/verify-night-preview-order.mjs <本机夹具订单ID>
node scripts/report-night-acceptance.mjs --write
```

HTTP专项要求3150及本机会话文件就绪，只创建/复用隔离权限夹具。旧 `night.spec.ts` 是连续业务故事，不要只过滤“开店”跳过前序收货后误判无货拒绝。

配送仓库：

```sh
node --test scripts/test-workspace-switch.mjs scripts/test-night-preview-login.mjs scripts/test-new-order-poller.mjs
npm run type-check
```

用户仓库：

```sh
node --test scripts/test-night-cart.mjs scripts/test-addresses.mjs
npm run type-check
```

后台：`npm run type-check`、`npm run build`。日志及浏览器证据在 [evidence/20261107](evidence/20261107)，43项冻结标准与结果见 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md)。

## 五项迁移及权限

按仓库历史顺序运行 `prisma migrate deploy`，本功能涉及：

1. `20261106100000_night_stock_workflow`：多阶段备货、共享仓夜宵预留、历史货值/占用、盘点损耗及流水；旧已完成单不重新入库。
2. `20261106220000_night_product_management`：楼栋商品查询及既有夜宵查看权限补充。
3. `20261106233000_night_refund_state`：持久退款及恢复，不伪造历史微信成功。
4. `20261106234500_night_order_request_coupon_scope`：账号级下单幂等、券的夜商品范围、原商户/AppID快照、退款查单/售后审核权限。
5. `20261107010000_night_deposit_refund_state`：持久退押、原支付单分配、重试/查单及既有押金角色权限。

不能用 `db push` 替代发布迁移，不能跳过历史回填和RBAC版本刷新。兼容测试覆盖旧库存、历史备货、在配订单、缺仓库补链、条码、菜单授权及唯一请求索引。发布前备份**测试数据库**，检查实际迁移状态与授权。已有Docker启动会执行迁移，应核对成功日志。

校区运营的查看、经营修改、审核出库、盘点损耗审核、退款售后、押金退款/扣减、结算登记分别受已有权限节点控制；普通查看角色不可执行写操作。API再次核对校区/角色/资源归属。

仅已绑定夜宵店的**正式楼长**可切换日夜工作台；实习楼长、骑手、未绑定正式楼长不显示。仅更新配送端而API仍旧时按无资格隐藏，不放宽身份判断。

## 测试环境构建与部署顺序

1. 备份测试库，确认测试域名/库、测试微信AppID与商户、回调及图片存储配置。
2. 发布API、迁移、生成Prisma、启动，检查健康/权限/新接口。
3. 发布后台，再配套发布用户与配送小程序/H5。
4. 按下方清单最终验收。生产发布由用户另行安排。

两套小程序各自在仓库执行，必须显式指定测试API，**MP构建默认可能使用生产地址，禁止裸跑**：

```sh
VITE_API_BASE_URL=https://admin-test.buchuqin.com/api/v1 VITE_API_PROXY_TARGET=https://admin-test.buchuqin.com npm run build:mp-weixin:buchuqin
```

开发者工具导入各自 `dist/build/mp-weixin-buchuqin`；AppID用各自真实测试配置，本机会话不会随构建发布。H5同域反代部署：

```sh
VITE_API_BASE_URL=/api/v1 VITE_API_PROXY_TARGET=https://admin-test.buchuqin.com npm run build:h5:buchuqin
```

各自输出 `dist/build/h5-buchuqin`；配送基路径 `/h5/delivery/m/`，用户 `/h5/user/m/`，同源 `/api/v1` 反代到测试API。跨域部署显式填测试API完整地址并配置测试CORS。后台 `VITE_API_PROXY_TARGET=https://admin-test.buchuqin.com npm run build`，部署 `dist` 并配置API反代。

真实微信测试需要对应AppID、商户、公钥/证书、回调、订阅模板及测试COS，沿用组织/校区支付配置。不要部署 `NIGHT_LOCAL_GATEWAY`、`NIGHT_LOCAL_UPLOADS` 或本机预览文件。服务端未配置COS会明确失败，不降级到生产存储。

## 最终测试环境验收清单

- [ ] 核对四仓库版本、五迁移、测试域名/数据库；无预览登录/模拟支付服务器入口。
- [ ] 官方库→导入夜宵默认下架→独立编辑分类/单位/条码/售价→上架→配置楼栋0库存；重复导入跳过，不改白天/共享仓/历史订单。
- [ ] 绑定正式楼长才有双向切换；刷新/轮询/各Tab保持本人选择，不改变营业、在线和未完成单。
- [ ] 申请3件只占额度→审核预留→出库→实收2件才入库；少收1件保持占额到报损批准，驳回可重新申报。
- [ ] 停售/下架/缺货/额度不足/重复提交/并发审核/重复收货正确拒绝或幂等，无负库存/重复释放。
- [ ] 盘亏/损耗先冻结、驳回恢复、批准释放；盘盈批准才入库，流水可追溯商品与单据。
- [ ] 同楼下单，搜索/分类/条码/详情、购物车、地址新增编辑选择、券领取/范围/门槛/退回、旧价格与运费变更重确认。
- [ ] 待付取消、支付失败原单重试、超时/晚到账、已付未接单取消、部分赔付/仅配送费/整单退款/回库与未回库，核对券/库存/额度/佣金。
- [ ] 新单提示→接单→真实上传→送达完成，四端同单状态；带待办打烊仍能履约，暂停/时段外不收新单。
- [ ] 带图售后→驳回/退款，未知/处理中不提前回库退券冲佣金，同号重试/查单只完成一次。
- [ ] 押金500元档差额、到账一次、退押占用及原路分配、失败恢复；上海营业日统计、整月汇总/分页、结算与打款登记留痕准确。
- [ ] 跨用户/楼栋/校区、只读角色、解绑/降角色越权拒绝；客服与员工联系方式按订单归属和隐私规则展示。
- [ ] 断网可重试、保留楼栋/购物车/地址/备货/备注草稿；旧数据有提示、配置失败不能保存、确认弹窗防重。
- [ ] 用户与配送375/390/430、主要点击44px、底栏安全区；后台1440/1024无整页溢出，宽表/长Tab内部滚动。
- [ ] **X05仍待外部验收**：真实微信登录/手机号授权、收银台取消与支付回调/原路退款、订阅推送、相机/相册上传、真机键盘/安全区/右上胶囊；开发者工具和iOS/Android设备实际验证，不能以H5模拟代替。

## 已确认的范围排除

不新增部分审核、分批出库、多次收货、超量收货、批次效期库存、跨楼栋配送、多人共同经营、复杂退出交接或叠加营销。保留已有清算能力。实习楼长既有夜宵业务资格保持原规则，但不开放日夜切换。微信外部未验证能力统一列X05，不计通过权重。
