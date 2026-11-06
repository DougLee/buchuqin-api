# 20261107 测试服务器业务验收驱动

本目录是本轮有状态验收辅助，不是可以反复清空/重建的通用seed。业务数据均经正常HTTP API创建；bootstrap只引导验收管理员，不造库存、资金或订单。结果见 `docs/night-store/TEST_ENV_E2E_20261107.md`。

## 固定环境与保护

- 唯一SSH：`139.199.3.190-buchuqin-test`；唯一业务源：`https://admin-test.buchuqin.com`。
- 主组织：`夜宵部署验收20261107`，无真实商户密钥；另有无库存资金的组织边界对照数据。
- 本机私有材料：`/tmp/night-remote-acceptance/`，目录0700、文件0600，含测试JWT/随机密码，禁止提交、打印或归档。
- 服务器私有材料：`/opt/buchuqin/night-acceptance/`，只读挂载 `/acceptance`；测试图片单独挂载 `/app/uploads`。本目录不随正常Docker运行镜像发布。

guard校验显式标记、宿主、数据库主机/名称/schema及组织。channel只替换主验收组织的外部微信身份兑换、支付退款和对象存储，保留内部业务、账本、鉴权、RBAC、图片校验压缩。全局HTTP出站白名单防止测试机已有真实通道被任务/定时作业调用；也会阻止其他测试组织调用真实外部服务。验收期间不得关闭。

confirm通过受限SSH CLI核对单据归属、商户快照和状态，再调用真实领域落账；服务器没有公开模拟确认接口。audit只读核对主组织账实。

## 流程及复用限制

1. foundation：正常后台登录及组织/校区/楼栋/寝室、用户准备。**再次登录触发管理员单会话策略，需同步浏览器会话。**
2. onboarding：招募/面试/审批、员工绑定、实习/正式资格及建店；零押金断言不可在缴纳后重跑。
3. 配送H5取消支付及首次500元缴纳；catalog通过正常官方导入、订货采购验收、发货和校区收货备库。100件断言不可在消耗后重跑。
4. 配送H5提交备货，后台审核出库，H5实收，后台审核差异。addresses/coupons通过正常API准备，用户H5加购领券支付，配送H5接单上传送达。
5. permissions-setup正常创建绑定员工、配置后台角色账号；各checks脚本进行状态化验收。部分有阶段记录，不能清空state后把重跑当重置。
6. observe/main-order只读HTTP快照，服务器audit只读账实。

驱动的字段/状态码/供应链契约校正不属于产品缺陷。不得为让测试通过改规则或直接改业务库存余额。

## 本地H5与部署

两端可选Vite包装器只在serve、`NIGHT_REMOTE_ACCEPTANCE=20261107`、API目标精确为测试域名时加载本目录；正常独立构建不加载兄弟API仓库。

```sh
NIGHT_REMOTE_ACCEPTANCE=20261107 VITE_API_PROXY_TARGET=https://admin-test.buchuqin.com VITE_API_BASE_URL=/api/v1 VITE_DEV_PORT=5195 npm run dev:h5:buchuqin
```

用户端端口5196。本机 `/__night-preview/start` 注入正常认证API签发的验收会话；只接受回环地址，模拟确认限同源JSON、固定角色与所属单据，CSP阻止生产资源和第三方统计。页面明确提示模拟支付，不等于微信真机验收。

测试服务使用基础compose及 `docker-compose.night-acceptance.yml`。重建须保留两份配置；直接省略适配会重新启用测试机原来的真实外部通道。生产机器/配置/数据不属于本目录范围。
