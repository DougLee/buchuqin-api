# 夜宵四端冻结验收矩阵

完成率 **98%**；通过 42/43 项。核心未完成：无。冻结基线 SHA-256：`84030c7c1795a715dee3040214928c56a037531a08e7e26b670535dab8ab9882`。

由 `node scripts/report-night-acceptance.mjs --write` 从 JSON 生成；不能修改标准或权重以提高完成率。

## A01 商品来源与价格快照（2.5% · 通过 · 核心）

验收标准：官方导入去重；共享实物仓独立夜目录；停售与历史订单快照一致

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：官方库、夜宵商品库、货架、订单详情。

接口：`POST /admin/night/catalog/import`；`PATCH /admin/night/catalog/:id`。

数据流：官方Product→校区夜目录+共享仓关联→NightProduct；订单items与历史货值保持快照

正常：官方Product→校区夜目录+共享仓关联→NightProduct；订单items与历史货值保持快照

异常：官方导入去重；共享实物仓独立夜目录；停售与历史订单快照一致；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)

## A02 备货状态与仓库预留（2.5% · 通过 · 核心）

验收标准：预占→整单批准/驳回/取消→出库→一次实收；白天共享仓不超卖

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：备货、进度、后台备货审核。

接口：`POST /night-rider/night/stock/orders`；`POST /admin/night/stock-orders/:id/review`；`POST /admin/night/stock-orders/:id/ship`；`POST /night-rider/night/stock/orders/:id/receive`。

数据流：requested预占额度→approved转共享仓预留→shipped转在途→received实收一次入库

正常：requested预占额度→approved转共享仓预留→shipped转在途→received实收一次入库

异常：预占→整单批准/驳回/取消→出库→一次实收；白天共享仓不超卖；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)

## A03 盘点与损耗账本（2.5% · 通过 · 核心）

验收标准：冻结/恢复/盘盈/少收/退款未回库；库存版本与历史货值守恒

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：盘点报损、后台审核、库存流水。

接口：`POST /night-rider/night/inventory/reports`；`POST /admin/night/inventory-reports/:id/review`。

数据流：负差异先冻结；驳回恢复/通过确认损耗；盘盈通过才入库；外部少收不重复扣库存

正常：负差异先冻结；驳回恢复/通过确认损耗；盘盈通过才入库；外部少收不重复扣库存

异常：冻结/恢复/盘盈/少收/退款未回库；库存版本与历史货值守恒；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)

## A04 订单与并发幂等（2.5% · 通过 · 核心）

验收标准：服务端重算价格/数量/地址；并发库存和订单重复提交保护

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：结算、订单详情。

接口：`POST /night/orders`。

数据流：服务端重算→店锁与数量条件更新→用户requestId唯一建单与快照扣库存；重试返回原单

正常：服务端重算→店锁与数量条件更新→用户requestId唯一建单与快照扣库存；重试返回原单

异常：服务端重算价格/数量/地址；并发库存和订单重复提交保护；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)、[http-permissions-35.log](evidence/20261107/http-permissions-35.log)

## A05 支付与超时状态（2.5% · 通过 · 核心）

验收标准：预支付、到账回调幂等、超时关闭、晚到账异常；外部支付隔离适配

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：继续支付、超时订单。

接口：`POST /night/orders/:id/pay`；`GET /night/orders/:id/pay-status`；`PaymentsService回调`。

数据流：pending-payment→校验原金额/币种/商户→pending-accept；超时关闭后真晚到账转exception

正常：pending-payment→校验原金额/币种/商户→pending-accept；超时关闭后真晚到账转exception

异常：预支付、到账回调幂等、超时关闭、晚到账异常；外部支付隔离适配；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)

## A06 取消退款与佣金冲回（2.5% · 通过 · 核心）

验收标准：取消/退款状态、金额上限、库存/券/佣金原子一致；退款失败不得伪成功

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：取消、售后、后台退款。

接口：`POST /night/orders/:id/cancel`；`POST /admin/night/orders/:id/refund`；`POST /admin/night/orders/:id/refund/sync`。

数据流：NightRefund稳定单号及租约→处理中/未知保留占用→成功原子同步券库存佣金；明确失败可同号重试

正常：NightRefund稳定单号及租约→处理中/未知保留占用→成功原子同步券库存佣金；明确失败可同号重试

异常：取消/退款状态、金额上限、库存/券/佣金原子一致；退款失败不得伪成功；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)

## A07 优惠券范围和额度（2.5% · 通过 · 核心）

验收标准：夜/日渠道、校区/商品范围、门槛、限领限量并发和退券规则

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：后台券配置、店铺领券、结算。

接口：`POST /admin/coupons`；`POST /night/coupons/:couponId/claim`；`POST /night/orders`。

数据流：模板渠道校区商品范围→UserCoupon领取锁定使用→成功商品全退释放；并发限量限领

正常：模板渠道校区商品范围→UserCoupon领取锁定使用→成功商品全退释放；并发限量限领

异常：夜/日渠道、校区/商品范围、门槛、限领限量并发和退券规则；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[api-night-69.log](evidence/20261107/api-night-69.log)

## A08 权限与跨租户边界（2.5% · 通过 · 核心）

验收标准：用户/员工/管理员隔离；跨店、跨用户、跨校区及同店角色变化拒绝

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：四端受限操作与资源详情。

接口：`night-user/night-rider/night-admin三个Controller及RBAC守卫`。

数据流：JWT身份→当前DB角色/绑定→校区操作权限→具体资源归属；不信任客户端身份与金额

正常：JWT身份→当前DB角色/绑定→校区操作权限→具体资源归属；不信任客户端身份与金额

异常：用户/员工/管理员隔离；跨店、跨用户、跨校区及同店角色变化拒绝；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：隔离PostgreSQL业务与并发验收、签名回调边界及HTTP权限已实际通过；外部微信渠道为明确隔离模拟，不计真机验收。

未完成：无

证据：[http-permissions-35.log](evidence/20261107/http-permissions-35.log)、[workspace-http.log](evidence/20261107/workspace-http.log)

## A09 押金收入与结算（2.5% · 通过 · 核心）

验收标准：押金到账/扣除/已有退还边界；佣金配送费分账和结算幂等

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：押金、收入、后台退押结算。

接口：`POST /night-rider/night/deposit/pay`；`POST /admin/night/stores/:id/deposit/refund`；`POST /admin/night/settlements/settle`。

数据流：支付回调一次入押金账→额度计算；退押稳定请求与成功后流水；佣金/配送费按批出账

正常：支付回调一次入押金账→额度计算；退押稳定请求与成功后流水；佣金/配送费按批出账

异常：押金到账/扣除/已有退还边界；佣金配送费分账和结算幂等；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：押金到账/退押、占用守恒与佣金冲回、1205笔完整批次及并发登记通过；外部渠道仅为隔离模拟。

未完成：无

证据：[api-night-71.log](evidence/20261107/api-night-71.log)、[api-history-and-settlements.log](evidence/20261107/api-history-and-settlements.log)、[preview-ledgers-latest.log](evidence/20261107/preview-ledgers-latest.log)、[admin-deposit-pending.png](evidence/20261107/admin-deposit-pending.png)、[admin-deposit-partial.png](evidence/20261107/admin-deposit-partial.png)

## A10 营业时段与数据查询（2.5% · 通过 · 核心）

验收标准：上海时区跨午夜、互斥校验；全量汇总/分页/筛选口径正确

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：营业配置、经营首页、筛选分页。

接口：`GET /night/entry`；`PUT /admin/night/config`；`GET /night-rider/night/income`。

数据流：上海时区跨日营业日→统一销售/收入统计→数据库筛选分页，完整汇总独立于列表页

正常：上海时区跨日营业日→统一销售/收入统计→数据库筛选分页，完整汇总独立于列表页

异常：上海时区跨午夜、互斥校验；全量汇总/分页/筛选口径正确；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：隔离PostgreSQL业务与并发测试；签名/支付边界测试；真实HTTP权限测试。结论：跨午夜/营业日测试通过；全月聚合、订单/账本/备货/申报/流水分页和510条后台历史筛选通过，无静默硬截断。

未完成：无

证据：[api-night-71.log](evidence/20261107/api-night-71.log)、[api-full-history-510.log](evidence/20261107/api-full-history-510.log)、[api-pagination-finance.log](evidence/20261107/api-pagination-finance.log)

## M01 店铺及楼长绑定（2.5% · 通过 · 核心）

验收标准：建店、唯一楼栋与经营者、换绑限制、暂停停业和校区权限

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：夜宵店铺列表与基础信息。

接口：`POST /admin/night/stores`；`PATCH /admin/night/stores/:id`。

数据流：唯一楼栋建店→合格经营者绑定→停业/恢复；库存资金未清不能换绑；显式0佣金保留

正常：唯一楼栋建店→合格经营者绑定→停业/恢复；库存资金未清不能换绑；显式0佣金保留

异常：建店、唯一楼栋与经营者、换绑限制、暂停停业和校区权限；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。

未完成：无

证据：[admin-create-store-zero-commission.png](evidence/20261107/admin-create-store-zero-commission.png)、[admin-unbound-store-zero-commission.png](evidence/20261107/admin-unbound-store-zero-commission.png)、[new-store-ledgers.log](evidence/20261107/new-store-ledgers.log)、[api-night-74.log](evidence/20261107/api-night-74.log)

## M02 官方与夜宵商品库（2.5% · 通过 · 核心）

验收标准：导入、创建编辑/售价/条码/分类、上下架、筛选和重复操作

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：官方商品库与夜宵商品库。

接口：`POST /admin/night/catalog/import`；`POST /admin/night/catalog`；`PATCH /admin/night/catalog/:id`。

数据流：官方上架资料导入→默认夜宵下架且库存0→独立分类单位价格编辑→上架供备货

正常：官方上架资料导入→默认夜宵下架且库存0→独立分类单位价格编辑→上架供备货

异常：导入、创建编辑/售价/条码/分类、上下架、筛选和重复操作；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。

未完成：无

证据：[catalog-browser-ledgers.log](evidence/20261107/catalog-browser-ledgers.log)、[api-catalog-metadata.log](evidence/20261107/api-catalog-metadata.log)、[api-night-74.log](evidence/20261107/api-night-74.log)

## M03 楼栋商品管理（2.5% · 通过 · 核心）

验收标准：配置零库存、许可/楼长上下架独立；分类/楼栋/库存筛选

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：楼栋商品管理与店铺商品。

接口：`GET /admin/night/store-products`；`POST /admin/night/stores/:id/products`；`PATCH /admin/night/stores/:id/products/:productId`。

数据流：目录配置生成0库存楼栋行；校区saleAllowed、楼长onShelf与目录status分别判定可售

正常：目录配置生成0库存楼栋行；校区saleAllowed、楼长onShelf与目录status分别判定可售

异常：配置零库存、许可/楼长上下架独立；分类/楼栋/库存筛选；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。

未完成：无

证据：[admin-attached-zero-stock.png](evidence/20261107/admin-attached-zero-stock.png)、[delivery-campus-sale-blocked-375.png](evidence/20261107/delivery-campus-sale-blocked-375.png)、[catalog-browser-ledgers.log](evidence/20261107/catalog-browser-ledgers.log)、[api-night-74.log](evidence/20261107/api-night-74.log)

## M04 备货审核与出库（2.5% · 通过 · 核心）

验收标准：明细、状态筛选、批准/驳回/取消/出库的业务与错误反馈

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：备货审核与出库。

接口：`GET /admin/night/stock-orders`；`POST /admin/night/stock-orders/:id/review`；`POST /admin/night/stock-orders/:id/cancel`；`POST /admin/night/stock-orders/:id/ship`。

数据流：筛选/明细→整单批准或驳回→校区取消未出库→整单出库；重复与过期状态受锁保护

正常：筛选/明细→整单批准或驳回→校区取消未出库→整单出库；重复与过期状态受锁保护

异常：明细、状态筛选、批准/驳回/取消/出库的业务与错误反馈；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。

未完成：无

证据：[admin-stock-approved.png](evidence/20261107/admin-stock-approved.png)、[delivery-shortage-approved-375.png](evidence/20261107/delivery-shortage-approved-375.png)、[api-night-74.log](evidence/20261107/api-night-74.log)

## M05 盘点与差异审核（2.5% · 通过 · 核心）

验收标准：损耗/盘盈/收货差异审核、凭证、历史货值与流水追溯

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：盘点报损审核与库存流水。

接口：`GET /admin/night/inventory-reports`；`POST /admin/night/inventory-reports/:id/review`；`GET /admin/night/stores/:id/stock-txns`。

数据流：实物/照片/历史货值核对→批准或驳回→对应库存与额度变化和关联单据流水

正常：实物/照片/历史货值核对→批准或驳回→对应库存与额度变化和关联单据流水

异常：损耗/盘盈/收货差异审核、凭证、历史货值与流水追溯；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[inventory-reviewed-ledgers.log](evidence/20261107/inventory-reviewed-ledgers.log)、[admin-loss-review.png](evidence/20261107/admin-loss-review.png)、[delivery-inventory-reviewed-375.png](evidence/20261107/delivery-inventory-reviewed-375.png)

## M06 订单与售后处理（2.5% · 通过 · 核心）

验收标准：检索详情/快照/凭证/售后/退款及回库选择、重复操作保护

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：夜宵订单列表、详情、退款与售后。

接口：`GET /admin/night/orders`；`GET /admin/night/orders/:id`；`POST /admin/night/orders/:id/refund`；`POST /admin/night/orders/:id/after-sale/reject`。

数据流：订单快照+完整凭证→核实退款/驳回留痕→成功后资金结果、资源和佣金联动

正常：订单快照+完整凭证→核实退款/驳回留痕→成功后资金结果、资源和佣金联动

异常：检索详情/快照/凭证/售后/退款及回库选择、重复操作保护；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[after-sale-refund-ledgers.log](evidence/20261107/after-sale-refund-ledgers.log)、[admin-after-sale-detail.png](evidence/20261107/admin-after-sale-detail.png)、[user-after-sale-refunded-375.png](evidence/20261107/user-after-sale-refunded-375.png)

## M07 押金佣金和结算（2.5% · 通过 · 核心）

验收标准：扣除与已有退还操作、双列结算/出账/打款、明细对账

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：押金账务、退还记录、夜宵结算。

接口：`POST /admin/night/stores/:id/deposit/deduct`；`GET /admin/night/stores/:id/deposit-refunds`；`POST /admin/night/settlements/:batch/pay`。

数据流：原路退押确认后落账；扣除不得占用待退押；待结算出账→线下打款留痕幂等，不模拟真实转账

正常：原路退押确认后落账；扣除不得占用待退押；待结算出账→线下打款留痕幂等，不模拟真实转账

异常：扣除与已有退还操作、双列结算/出账/打款、明细对账；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[admin-settled-marked-paid.png](evidence/20261107/admin-settled-marked-paid.png)、[admin-deposit-partial.png](evidence/20261107/admin-deposit-partial.png)、[api-night-72.log](evidence/20261107/api-night-72.log)

## M08 营业规则券与审计（2.5% · 通过 · 核心）

验收标准：配置生效/零运费、夜宵券发行管理与操作审计及经营报表

角色：有对应权限的校区运营/总部/财务、只读管理员（拒绝写入）。页面：校区配置夜宵页签、优惠券配置、审计、经营统计。

接口：`PUT /admin/night/config`；`POST /admin/coupons`；`GET /admin/night/stores`。

数据流：配置/0元运费生效→账单变动须重新确认；夜宵券独立范围；业务动作留审计与真实统计

正常：配置/0元运费生效→账单变动须重新确认；夜宵券独立范围；业务动作留审计与真实统计

异常：配置生效/零运费、夜宵券发行管理与操作审计及经营报表；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：操作RBAC与校区范围，同时校验具体店铺/订单/批次归属

测试：后台真实浏览器操作；真实数据库结果核对；API异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。 实际关闭夜宵后仍可保存，用户端停用，再开启恢复；跨校区配置不混用。

未完成：无

证据：[admin-night-config-restored.png](evidence/20261107/admin-night-config-restored.png)、[user-free-delivery-checkout-375.png](evidence/20261107/user-free-delivery-checkout-375.png)、[user-fee-change-reconfirmed-375.png](evidence/20261107/user-fee-change-reconfirmed-375.png)、[user-coupon-checkout-375.png](evidence/20261107/user-coupon-checkout-375.png)、[api-night-74.log](evidence/20261107/api-night-74.log)、[night-final-admin-config-disabled-save-1024.png](evidence/20261107/night-final-admin-config-disabled-save-1024.png)、[night-final-user-campus-disabled-430.png](evidence/20261107/night-final-user-campus-disabled-430.png)、[night-final-user-campus-enabled-again-430.png](evidence/20261107/night-final-user-campus-enabled-again-430.png)

## U01 入口与楼栋场景（2% · 通过 · 核心）

验收标准：校区/楼栋确认、白夜入口、营业/休息/招募三态与切换

角色：本校区用户、店铺楼长（关联履约）。页面：首页、夜宵楼栋选择、分享落地。

接口：`GET /night/entry`；`GET /night/stores`；`GET /night/stores/:id`。

数据流：当前校区+已选楼栋→营业/休息/招募三态；分享先确认楼栋，时段变化重新判定

正常：当前校区+已选楼栋→营业/休息/招募三态；分享先确认楼栋，时段变化重新判定

异常：校区/楼栋确认、白夜入口、营业/休息/招募三态与切换；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。

未完成：无

证据：[user-buildings-three-states-375.png](evidence/20261107/user-buildings-three-states-375.png)、[user-night-recruit-prefill-375.png](evidence/20261107/user-night-recruit-prefill-375.png)、[http-closed-store.log](evidence/20261107/http-closed-store.log)、[api-night-74.log](evidence/20261107/api-night-74.log)

## U02 商品浏览详情与检索（2% · 通过 · 核心）

验收标准：商品图片/分类/搜索/详情/售罄/停售；共享首页与商品Tab一致

角色：本校区用户、店铺楼长（关联履约）。页面：共享首页、商品Tab、店铺、商品详情弹层。

接口：`GET /night/stores/:id/products`。

数据流：同一NightProductShelf消费真实库存分类条码单位；本店上下架后多入口同步；售罄保留禁加购

正常：同一NightProductShelf消费真实库存分类条码单位；本店上下架后多入口同步；售罄保留禁加购

异常：商品图片/分类/搜索/详情/售罄/停售；共享首页与商品Tab一致；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮H5实际操作与跨端数据核对通过；共享组件、账本分页和会话轮询分别有截图、真实数据库或行为测试证据。

未完成：无

证据：[user-category-shared-shelf-375.png](evidence/20261107/user-category-shared-shelf-375.png)、[user-category-product-detail-fixed-375.png](evidence/20261107/user-category-product-detail-fixed-375.png)、[user-home-category-shared-cart-375.png](evidence/20261107/user-home-category-shared-cart-375.png)、[api-night-74.log](evidence/20261107/api-night-74.log)

## U03 独立购物车（2% · 通过 · 核心）

验收标准：按店铺/账号隔离、数量边界、失效/调价重验、增减删除与持久化

角色：本校区用户、店铺楼长（关联履约）。页面：夜宵本地购物车、结算。

接口：`GET /night/stores/:id/products`；`POST /night/orders`。

数据流：用户ID+店铺隔离持久化→加减与上限→结算重验→成功只消费该单数量且幂等

正常：用户ID+店铺隔离持久化→加减与上限→结算重验→成功只消费该单数量且幂等

异常：按店铺/账号隔离、数量边界、失效/调价重验、增减删除与持久化；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：实际Pinia模块5项通过，按用户店铺隔离/数量/刷新调价；真实H5选购付款链已验证，按订单扣除购买数量且重复查单不重复清除后来加购。

未完成：无

证据：[user-cart-5.log](evidence/20261107/user-cart-5.log)、[user-completed-order-375.png](evidence/20261107/user-completed-order-375.png)、[api-night-71.log](evidence/20261107/api-night-71.log)

## U04 地址与配送范围（2% · 通过 · 核心）

验收标准：本楼地址选择/新增/编辑，跨楼跨校区拒绝，分享入口再次确认

角色：本校区用户、店铺楼长（关联履约）。页面：结算管理地址、寝室地址列表与编辑。

接口：`GET /addresses`；`POST /addresses`；`PATCH /addresses/:id`；`POST /night/orders`。

数据流：已录入楼栋楼层寝室选择→保存/编辑→返回选择本楼地址；服务端再验校区楼栋归属

正常：已录入楼栋楼层寝室选择→保存/编辑→返回选择本楼地址；服务端再验校区楼栋归属

异常：本楼地址选择/新增/编辑，跨楼跨校区拒绝，分享入口再次确认；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：真实隔离数据库/API和本轮后台或H5操作通过；正常链路、主要失败和校区权限均有可复核证据。

未完成：无

证据：[user-managed-address-checkout-375.png](evidence/20261107/user-managed-address-checkout-375.png)、[user-address-chinese-picker-375.png](evidence/20261107/user-address-chinese-picker-375.png)、[http-permissions-latest-35.log](evidence/20261107/http-permissions-latest-35.log)、[address-pages-2.log](evidence/20261107/address-pages-2.log)

## U05 券与账单确认（2% · 通过 · 核心）

验收标准：夜宵券领取/适用商品与门槛、不使用券、金额与配送费明细

角色：本校区用户、店铺楼长（关联履约）。页面：店铺领券、确认订单。

接口：`GET /night/coupons`；`POST /night/coupons/:couponId/claim`；`POST /night/orders`。

数据流：领取夜宵券→适用商品金额核门槛和抵扣→商品/运费/优惠/实付独立列出

正常：领取夜宵券→适用商品金额核门槛和抵扣→商品/运费/优惠/实付独立列出

异常：夜宵券领取/适用商品与门槛、不使用券、金额与配送费明细；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[user-coupon-checkout-375.png](evidence/20261107/user-coupon-checkout-375.png)、[after-sale-refund-ledgers.log](evidence/20261107/after-sale-refund-ledgers.log)、[api-night-72.log](evidence/20261107/api-night-72.log)

## U06 下单支付及继续支付（2% · 通过 · 核心）

验收标准：重复点击/重试保护、支付成功/取消/失败/超时与购物车处理

角色：本校区用户、店铺楼长（关联履约）。页面：确认订单、待支付、继续支付。

接口：`POST /night/orders`；`POST /night/orders/:id/pay`；`GET /night/orders/:id/pay-status`。

数据流：保存稳定下单意图→原单支付/取消外部收银台/恢复→详情继续支付；确认成功才消费购物车

正常：保存稳定下单意图→原单支付/取消外部收银台/恢复→详情继续支付；确认成功才消费购物车

异常：重复点击/重试保护、支付成功/取消/失败/超时与购物车处理；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[user-pay-query-outage-375.png](evidence/20261107/user-pay-query-outage-375.png)、[user-pay-recovered-375.png](evidence/20261107/user-pay-recovered-375.png)、[unpaid-cancel-ledgers.log](evidence/20261107/unpaid-cancel-ledgers.log)、[api-cancel-payment-race.log](evidence/20261107/api-cancel-payment-race.log)

## U07 订单列表详情进度（2% · 通过 · 核心）

验收标准：状态筛选、快照/配送状态/凭证、返回刷新及空态

角色：本校区用户、店铺楼长（关联履约）。页面：我的夜宵单、订单进度。

接口：`GET /night/orders`；`GET /night/orders/:id`。

数据流：真实数据库分页与状态筛选→快照/凭证/上海时间展示；未支付取消不得显示实付

正常：真实数据库分页与状态筛选→快照/凭证/上海时间展示；未支付取消不得显示实付

异常：状态筛选、快照/配送状态/凭证、返回刷新及空态；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮H5实际操作与跨端数据核对通过；共享组件、账本分页和会话轮询分别有截图、真实数据库或行为测试证据。

未完成：无

证据：[user-order-list-all-375.png](evidence/20261107/user-order-list-all-375.png)、[user-orders-refunded-375.png](evidence/20261107/user-orders-refunded-375.png)、[user-orders-empty-375.png](evidence/20261107/user-orders-empty-375.png)、[api-night-74.log](evidence/20261107/api-night-74.log)

## U08 取消售后与退款（2% · 通过 · 核心）

验收标准：取消限制、售后原因/凭证、退款处理中/结果和重复操作反馈

角色：本校区用户、店铺楼长（关联履约）。页面：订单取消、售后弹层、退款进度。

接口：`POST /night/orders/:id/cancel`；`POST /night/orders/:id/after-sale`；`GET /night/orders/:id`。

数据流：按是否已付明确确认→退款处理中可刷新→成功回库/退券；接单后只能售后

正常：按是否已付明确确认→退款处理中可刷新→成功回库/退券；接单后只能售后

异常：取消限制、售后原因/凭证、退款处理中/结果和重复操作反馈；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[user-after-sale-form-375.png](evidence/20261107/user-after-sale-form-375.png)、[user-after-sale-refunded-375.png](evidence/20261107/user-after-sale-refunded-375.png)、[after-sale-refund-ledgers.log](evidence/20261107/after-sale-refund-ledgers.log)、[api-cancel-payment-race.log](evidence/20261107/api-cancel-payment-race.log)

## U09 异常与时段变化（2% · 通过 · 核心）

验收标准：缺货/停售/打烊/暂停/过期/断网/鉴权失败均可恢复

角色：本校区用户、店铺楼长（关联履约）。页面：货架、结算、支付、订单失败态。

接口：`GET /night/entry`；`GET /night/stores/:id/products`；`POST /night/orders`。

数据流：停售/无货/休息/时段外拦截；旧账单变化重载核对；离线与鉴权失败可回退/重试

正常：停售/无货/休息/时段外拦截；旧账单变化重载核对；离线与鉴权失败可回退/重试

异常：缺货/停售/打烊/暂停/过期/断网/鉴权失败均可恢复；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：真实PG覆盖时段/开关/营业三态与下单拒绝、缺货停售/重复/价格变更；H5暂停/打烊、原单断网恢复、首页/地址/详情重试已实际完成，保留楼栋/车/备注。

未完成：无

证据：[api-night-75.log](evidence/20261107/api-night-75.log)、[http-permissions-final-35.log](evidence/20261107/http-permissions-final-35.log)、[user-store-outside-session-375.png](evidence/20261107/user-store-outside-session-375.png)、[user-home-offline-final-375.png](evidence/20261107/user-home-offline-final-375.png)、[user-final-details.log](evidence/20261107/user-final-details.log)

## U10 联系通知与招募入口（2% · 通过）

验收标准：已定义联系、订单通知及已有楼长招募入口可用且权限正确

角色：本校区用户、店铺楼长（关联履约）。页面：订单联系客服、消息中心、夜宵意向报名。

接口：`GET /notifications`；`POST /notifications/read-all`；`GET /recruit/application`；`POST /recruit/applications`。

数据流：订单所属校区客服→已定义订单通知可见与已读→夜宵楼栋意向预填及报名进度，审核不自动激活经营

正常：订单所属校区客服→已定义订单通知可见与已读→夜宵楼栋意向预填及报名进度，审核不自动激活经营

异常：已定义联系、订单通知及已有楼长招募入口可用且权限正确；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前用户及校区；订单/地址只能本人；下单必须同楼栋同校区

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮H5实际操作与跨端数据核对通过；共享组件、账本分页和会话轮询分别有截图、真实数据库或行为测试证据。

未完成：无

证据：[user-notifications-read-375.png](evidence/20261107/user-notifications-read-375.png)、[user-night-notifications-375.png](evidence/20261107/user-night-notifications-375.png)、[user-order-campus-support-375.png](evidence/20261107/user-order-campus-support-375.png)、[user-night-recruit-pending-375.png](evidence/20261107/user-night-recruit-pending-375.png)、[http-permissions-latest-35.log](evidence/20261107/http-permissions-latest-35.log)

## D01 身份与工作台切换（2.5% · 通过 · 核心）

验收标准：仅绑定正式楼长双向切换；账号隔离/解绑/刷新/轮询/四Tab一致

角色：绑定夜宵店的正式楼长、不具资格的其他身份。页面：日夜首页切换、四Tab、我的账号。

接口：`GET /fulfillment/business-context`。

数据流：仅已绑定正式楼长显示切换；账号选择持久化；轮询不覆盖手动选择，身份变化清理

正常：仅已绑定正式楼长显示切换；账号选择持久化；轮询不覆盖手动选择，身份变化清理

异常：仅绑定正式楼长双向切换；账号隔离/解绑/刷新/轮询/四Tab一致；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：五类身份真实HTTP、工作台模块13项及此前双向切换浏览器验证通过；仅正式且绑定楼长显示。

未完成：无

证据：[workspace-switch-13.log](evidence/20261107/workspace-switch-13.log)、[workspace-http.log](evidence/20261107/workspace-http.log)

## D02 经营首页与真实统计（2.5% · 通过 · 核心）

验收标准：营业状态、真实今日/月销售和收入、待办及库存摘要无占位

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：夜宵经营首页。

接口：`GET /night-rider/night/dashboard`；`GET /night-rider/night/products`；`GET /night-rider/night/orders`。

数据流：真实营业状态与今日/月统计→待办、库存种数/售罄与货值；无占位数据

正常：真实营业状态与今日/月统计→待办、库存种数/售罄与货值；无占位数据

异常：营业状态、真实今日/月销售和收入、待办及库存摘要无占位；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：真实API与账本计算今日/月净商品销售额、收入，375px浏览器实看；无占位统计。

未完成：无

证据：[api-pagination-finance.log](evidence/20261107/api-pagination-finance.log)、[delivery-dashboard-375.png](evidence/20261107/delivery-dashboard-375.png)

## D03 开店暂停与打烊（2.5% · 通过 · 核心）

验收标准：押金/可售商品/时段/互斥校验，暂停恢复与未完单提示

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：开始营业、暂停接单、恢复、打烊。

接口：`POST /night-rider/night/store/open`；`POST /night-rider/night/store/pause`；`POST /night-rider/night/store/resume`；`POST /night-rider/night/store/close`。

数据流：锁内重验角色绑定时段押金可售→状态变更；打烊显示未完单并仍允许配送

正常：锁内重验角色绑定时段押金可售→状态变更；打烊显示未完单并仍允许配送

异常：押金/可售商品/时段/互斥校验，暂停恢复与未完单提示；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[delivery-closed-paid-todo-375.png](evidence/20261107/delivery-closed-paid-todo-375.png)、[http-closed-store.log](evidence/20261107/http-closed-store.log)、[api-store-status-races.log](evidence/20261107/api-store-status-races.log)

## D04 商品与库存管理（2.5% · 通过 · 核心）

验收标准：检索/上下架/停售、售罄、历史货值、冻结和流水

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：本店商品、库存流水。

接口：`GET /night-rider/night/products`；`PATCH /night-rider/night/products/:id/shelf`；`GET /night-rider/night/inventory/txns`。

数据流：楼长控制onShelf，后台许可优先；0库存/冻结/待配送/历史货值分开显示

正常：楼长控制onShelf，后台许可优先；0库存/冻结/待配送/历史货值分开显示

异常：检索/上下架/停售、售罄、历史货值、冻结和流水；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮H5实际操作与跨端数据核对通过；共享组件、账本分页和会话轮询分别有截图、真实数据库或行为测试证据。

未完成：无

证据：[delivery-product-off-shelf-375.png](evidence/20261107/delivery-product-off-shelf-375.png)、[delivery-campus-sale-blocked-375.png](evidence/20261107/delivery-campus-sale-blocked-375.png)、[delivery-zero-stock-product-375.png](evidence/20261107/delivery-zero-stock-product-375.png)、[after-income-ledgers.log](evidence/20261107/after-income-ledgers.log)、[api-night-74.log](evidence/20261107/api-night-74.log)

## D05 备货选择与提交（2.5% · 通过 · 核心）

验收标准：检索分类/数量/额度/补缴差额、重复提交与状态变化

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：进货备货与补缴押金。

接口：`GET /night-rider/night/stock/pool`；`POST /night-rider/night/stock/orders`。

数据流：商品分类/条码/选择数量→历史申请价格与额度核算→稳定请求提交，仅预占不入库

正常：商品分类/条码/选择数量→历史申请价格与额度核算→稳定请求提交，仅预占不入库

异常：检索分类/数量/额度/补缴差额、重复提交与状态变化；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：H5实际搜索可乐、数量选择、3听提交；负数失焦回正、防重复确认；1190元申请对796元额度准确提示差394元并进入500元档补缴，返回保留草稿。

未完成：无

证据：[delivery-stock-confirm-chinese-375.png](evidence/20261107/delivery-stock-confirm-chinese-375.png)、[delivery-stock-quota-gap-modal-375.png](evidence/20261107/delivery-stock-quota-gap-modal-375.png)、[api-night-71.log](evidence/20261107/api-night-71.log)

## D06 备货进度与实收（2.5% · 通过 · 核心）

验收标准：状态明细/撤回、一次实收/少收处理/幂等/异常重试

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：备货进度、实收确认。

接口：`GET /night-rider/night/stock/orders`；`POST /night-rider/night/stock/orders/:id/receive`。

数据流：按状态分页→一次实收→入库真实数量；少收转独立报损，撤回释放未审核占用

正常：按状态分页→一次实收→入库真实数量；少收转独立报损，撤回释放未审核占用

异常：状态明细/撤回、一次实收/少收处理/幂等/异常重试；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：H5一次实收2/3听、少收报损、审批后释放350分；另1听申请主动撤回且预占归零。数据库并发/重复实收与驳回重报专项通过。

未完成：无

证据：[delivery-stock-received-375.png](evidence/20261107/delivery-stock-received-375.png)、[delivery-stock-withdrawn-375.png](evidence/20261107/delivery-stock-withdrawn-375.png)、[browser-stock-before-approval.log](evidence/20261107/browser-stock-before-approval.log)、[browser-stock-after-approval.log](evidence/20261107/browser-stock-after-approval.log)、[browser-stock-after-withdraw.log](evidence/20261107/browser-stock-after-withdraw.log)、[api-night-71.log](evidence/20261107/api-night-71.log)

## D07 盘点报损与审批回看（2.5% · 通过 · 核心）

验收标准：草稿、数量/版本/凭证、盘点差异/报损/审核记录

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：库存盘点、报损、申报记录。

接口：`POST /night-rider/night/inventory/reports`；`POST /night-rider/night/inventory/reports/:id/resubmit`。

数据流：选择商品与库存版本→草稿+照片→冻结/待审→审核回看；外部差异驳回可补充重报

正常：选择商品与库存版本→草稿+照片→冻结/待审→审核回看；外部差异驳回可补充重报

异常：草稿、数量/版本/凭证、盘点差异/报损/审核记录；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮真实数据库、HTTP边界及本地H5跨端操作通过；订单、报损和出账记录可按归档ID复核。支付/打款仅为明确隔离模拟或留痕，不等同外部微信渠道验收。

未完成：无

证据：[delivery-inventory-loss-confirm-375.png](evidence/20261107/delivery-inventory-loss-confirm-375.png)、[delivery-inventory-reviewed-375.png](evidence/20261107/delivery-inventory-reviewed-375.png)、[inventory-reviewed-ledgers.log](evidence/20261107/inventory-reviewed-ledgers.log)

## D08 接单配送与凭证（2.5% · 通过 · 核心）

验收标准：真实订单与白天未完、接单/送达/选图上传/凭证与失败恢复

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：夜宵订单、单据详情、送达凭证。

接口：`POST /night-rider/night/orders/:id/accept`；`POST /night-rider/night/orders/:id/deliver`；`POST /files/images`。

数据流：已付款待接→接单→本机真实鉴权上传→凭证送达完成；失败保留照片并刷新状态

正常：已付款待接→接单→本机真实鉴权上传→凭证送达完成；失败保留照片并刷新状态

异常：真实订单与白天未完、接单/送达/选图上传/凭证与失败恢复；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：用户本机H5付款→楼长接单→原生选图真实上传→送达→用户确认凭证的同一订单链已跑通。

未完成：无

证据：[user-completed-order-375.png](evidence/20261107/user-completed-order-375.png)、[http-permissions-35.log](evidence/20261107/http-permissions-35.log)

## D09 押金与佣金明细（2.5% · 通过 · 核心）

验收标准：差额缴纳/取消重试/流水；每单券后佣金与配送费分列

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：经营押金、单单所得。

接口：`GET /night-rider/night/deposit`；`POST /night-rider/night/deposit/pay`；`GET /night-rider/night/orders/:id/earning`。

数据流：档位差额预支付→到账一次记押金→完整流水；券后佣金和配送费分列并扣退款冲回

正常：档位差额预支付→到账一次记押金→完整流水；券后佣金和配送费分列并扣退款冲回

异常：差额缴纳/取消重试/流水；每单券后佣金与配送费分列；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：H5取消缴纳不落账、补缴500元至2000元只记一次；历史流水分页，账号店铺隔离待确认单。每单收入取券后佣金和配送费实际账本净额，退款后的单笔对账通过。

未完成：无

证据：[delivery-deposit-paid-375.png](evidence/20261107/delivery-deposit-paid-375.png)、[admin-deposit-confirmed.png](evidence/20261107/admin-deposit-confirmed.png)、[api-pagination-finance.log](evidence/20261107/api-pagination-finance.log)、[preview-ledgers-latest.log](evidence/20261107/preview-ledgers-latest.log)

## D10 收入通知及前后台（2.5% · 通过 · 核心）

验收标准：全量收入分桶/筛选与结算、新单提示、刷新和会话变化

角色：绑定夜宵店的楼长、校区运营（关联审核）。页面：收入月份、状态、分页、新单轮询。

接口：`GET /night-rider/night/income`；`GET /night-rider/night/orders`；`GET /fulfillment/business-context`。

数据流：按营业月全量汇总+趋势和分页明细；前台轮询增加提醒，隐藏/换会话丢弃在途旧响应

正常：按营业月全量汇总+趋势和分页明细；前台轮询增加提醒，隐藏/换会话丢弃在途旧响应

异常：全量收入分桶/筛选与结算、新单提示、刷新和会话变化；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：当前DB员工角色与店铺绑定，跨店/撤销资格拒绝；工作台切换限正式楼长

测试：本地H5真实操作与截图；真实API/数据库跨端核对；关联业务异常/权限回归。结论：本轮H5实际操作与跨端数据核对通过；共享组件、账本分页和会话轮询分别有截图、真实数据库或行为测试证据。

未完成：无

证据：[delivery-new-order-polled-375.png](evidence/20261107/delivery-new-order-polled-375.png)、[delivery-income-page1-375.png](evidence/20261107/delivery-income-page1-375.png)、[delivery-income-page2-375.png](evidence/20261107/delivery-income-page2-375.png)、[delivery-income-pending-375.png](evidence/20261107/delivery-income-pending-375.png)、[delivery-income-history-empty-375.png](evidence/20261107/delivery-income-history-empty-375.png)、[new-order-poller-4.log](evidence/20261107/new-order-poller-4.log)、[income-pagination-fixtures.log](evidence/20261107/income-pagination-fixtures.log)、[api-night-74.log](evidence/20261107/api-night-74.log)

## X01 日夜视觉与响应式（2% · 通过）

验收标准：四端风格统一；375/390/430、小屏/窄后台；可点44px和安全区

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：四端全部夜宵页面。

接口：`对应A/M/U/D业务接口与组件`。

数据流：沿用深翡翠暖金或各端现有系统；数据/状态不因响应式布局丢失

正常：沿用深翡翠暖金或各端现有系统；数据/状态不因响应式布局丢失

异常：四端风格统一；375/390/430、小屏/窄后台；可点44px和安全区；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：跨端浏览器检查；本地隔离脚本与构建；部署清单及证据复核。结论：90个主要页面/尺寸组合，手机375/390/430及后台1440/1024；手机按钮不足44px、弹层遮挡和后台溢出已修复并复测。宽表/长Tab按设计内部滚动，真机安全区/胶囊仍单列X05。

未完成：无

证据：[layout-final-90.json](evidence/20261107/layout-final-90.json)、[night-final-delivery-home-375.png](evidence/20261107/night-final-delivery-home-375.png)、[night-final-delivery-day-home-375.png](evidence/20261107/night-final-delivery-day-home-375.png)、[night-final-delivery-income-390.png](evidence/20261107/night-final-delivery-income-390.png)、[night-final-user-checkout-375.png](evidence/20261107/night-final-user-checkout-375.png)、[night-final-user-product-modal-430.png](evidence/20261107/night-final-user-product-modal-430.png)、[night-final-admin-stock-ledger-1024.png](evidence/20261107/night-final-admin-stock-ledger-1024.png)

## X02 交互状态与可恢复性（2% · 通过 · 核心）

验收标准：全页面骨架/空态/失败/重试/无权限、草稿/返回/防重与控制台

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：四端加载、空态、失败与恢复。

接口：`对应A/M/U/D业务接口`。

数据流：业务失败与网络失败均有可恢复反馈；草稿保留、防重及原单恢复，控制台无未捕获错误

正常：业务失败与网络失败均有可恢复反馈；草稿保留、防重及原单恢复，控制台无未捕获错误

异常：全页面骨架/空态/失败/重试/无权限、草稿/返回/防重与控制台；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：跨端浏览器检查；本地隔离脚本与构建；部署清单及证据复核。结论：实际中断3150检查各端失败/重试、配置禁止保存、旧数据提示与草稿保留；恢复后继续操作，跨校区配置未混用。防重/轮询/购物车/地址行为测试通过；浏览器无未捕获异常、未处理Promise或Vue运行时警告。

未完成：无

证据：[console-final-summary.json](evidence/20261107/console-final-summary.json)、[user-home-offline-final-375.png](evidence/20261107/user-home-offline-final-375.png)、[admin-building-products-offline.png](evidence/20261107/admin-building-products-offline.png)、[user-final-details.log](evidence/20261107/user-final-details.log)、[delivery-unit-final-17.log](evidence/20261107/delivery-unit-final-17.log)、[user-unit-final-7.log](evidence/20261107/user-unit-final-7.log)

## X03 隔离环境与真实夹具（2% · 通过 · 核心）

验收标准：仅本地/测试白名单、独立schema、幂等夹具、原生外部适配隔离

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：本机三端预览与测试runner。

接口：`scripts/preview-night-stock.mjs`；`三端loopback开发中间件`。

数据流：_spec独立schema检查→真实业务API/DB→仅外部微信适配；网络与CSP拒绝生产API

正常：_spec独立schema检查→真实业务API/DB→仅外部微信适配；网络与CSP拒绝生产API

异常：仅本地/测试白名单、独立schema、幂等夹具、原生外部适配隔离；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：跨端浏览器检查；本地隔离脚本与构建；部署清单及证据复核。结论：独立_spec/schema与固定夹具；离线桩确认拒绝业务库名/public/非test和HTTP主机覆盖，fetch不自动跟随重定向。否定场景没有发送真实网络请求。DEV适配器不进入发布版路由，原生能力不冒充通过。

未完成：无

证据：[isolation-offline-3.log](evidence/20261107/isolation-offline-3.log)、[http-permissions-latest-35.log](evidence/20261107/http-permissions-latest-35.log)、[workspace-switch-13.log](evidence/20261107/workspace-switch-13.log)、[migrations.log](evidence/20261107/migrations.log)

## X04 四端构建迁移及交付（2% · 通过 · 核心）

验收标准：类型/测试/构建/兼容迁移；完整跨端浏览器证据、提交/启动/发布清单

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：四仓库类型、构建、迁移、发布文档。

接口：`五项夜宵迁移`；`四端构建命令`；`feature/night-store提交`。

数据流：验证兼容迁移→API/后台/双小程序测试构建→证据/启动账号/权限配置/部署顺序及版本

正常：验证兼容迁移→API/后台/双小程序测试构建→证据/启动账号/权限配置/部署顺序及版本

异常：类型/测试/构建/兼容迁移；完整跨端浏览器证据、提交/启动/发布清单；主要输入边界、过期状态、重复操作及请求失败按关联证据复核

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：跨端浏览器检查；本地隔离脚本与构建；部署清单及证据复核。结论：四仓库代码已提交；最终API/后台/双端类型、H5/MP构建均通过，五迁移兼容通过，完整浏览器/账本证据已归档；发布产物使用测试API且无本机模拟入口，启动账号位置/迁移/RBAC/部署顺序及验收清单齐全。API最终验收文档随后以独立提交封存。

未完成：无

证据：[api-night-75.log](evidence/20261107/api-night-75.log)、[migrations-final.log](evidence/20261107/migrations-final.log)、[final-api-build.log](evidence/20261107/final-api-build.log)、[final-admin-status.json](evidence/20261107/final-admin-status.json)、[final-user-weapp-status.json](evidence/20261107/final-user-weapp-status.json)、[final-delivery-weapp-status.json](evidence/20261107/final-delivery-weapp-status.json)、[night-final-artifact-inspection.json](evidence/20261107/night-final-artifact-inspection.json)、[RELEASE_VERSIONS.json](RELEASE_VERSIONS.json)、[TEST_DEPLOYMENT.md](TEST_DEPLOYMENT.md)、[ACCEPTANCE_REPORT.md](ACCEPTANCE_REPORT.md)

## X05 微信原生真机能力（2% · 外部待验收）

验收标准：真实微信登录/收银台/订阅推送/真机胶囊与相册；H5内部流程不能替代

角色：用户、楼长、校区运营/财务、无权限及其他校区身份。页面：微信开发者工具与真实设备。

接口：`wx.login`；`wx.requestPayment`；`wx.requestSubscribeMessage`；`微信原生相机/相册`。

数据流：真实微信登录/支付/订阅与设备UI必须外部验收，H5模拟仅证明内部业务链

正常：真实微信登录/支付/订阅与设备UI必须外部验收，H5模拟仅证明内部业务链

异常：无真机/外部授权时明确记录未验证，不用本机模拟替代

权限边界：服务端身份、资源归属及独立测试环境约束，见A08/X03专项

测试：真实微信/设备人工验收（不以H5冒充）。结论：真实微信登录/收银台/原路渠道/订阅消息和真机相机胶囊安全区未执行，H5模拟不计通过；完整外部验收清单已交付。

未完成：需测试AppID/商户及获授权微信账号、开发者工具和iOS/Android设备执行原生验收，禁止使用生产验证。

证据：[NATIVE_VERIFICATION.md](NATIVE_VERIFICATION.md)
