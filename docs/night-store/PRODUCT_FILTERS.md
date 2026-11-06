# 夜宵商品与审批筛选

所有后台接口仍使用现有 JWT、菜单权限和校区数据范围校验。平台账号传 `campus` 选择业务校区；校区账号不能通过 `campus` 或 `storeId` 越权。详情、配置、停售及审核继续复用现有写权限。

| GET 接口 | 可选筛选 |
| --- | --- |
| `/admin/night/catalog` | `keyword` 名称/条码；`status=on-sale/off-sale`；`categoryId`；`stock=available/empty/unlinked`；`source=official/manual`；`page/pageSize` |
| `/admin/night/store-products` | `keyword` 商品/条码/楼栋/楼长；`storeId`；`categoryId`；`stock=available/empty/frozen`；`saleAllowed=true/false`；`onShelf=true/false`；`page/pageSize` |
| `/admin/night/stock-orders` | `keyword` 单号/商品/楼栋/楼长/说明；`storeId`；`status`；`from/to` |
| `/admin/night/inventory-reports` | 同备货；另有 `kind=loss/stocktake/receipt-shortage/order-loss`，`status=pending/approved/rejected` |

`catalog` 分页响应增加 `categories: [{id,name}]`，只返回当前校区有夜宵商品的分类。仓库可用库存沿用共享仓库的 `stock − lockedStock` 口径；夜宵审核已扣减 `stock` 预留，不重复扣减 `nightReservedStock`，未关联仓库单独筛选。`store-products` 返回扁平楼栋商品行：楼栋、楼长、分类、条码、夜宵售价、可售库存、冻结库存、历史货值、校区许可和楼长上架状态。冻结部分的占用保存在申报单中，不能用当前售价直接计算历史押金占用。

日期为 `YYYY-MM-DD`，包含北京时间开始日00:00至结束日23:59:59.999，非法日期或起止倒置返回400。备货/申报先按校区、状态、日期和关键词过滤，再返回最近500条；后台对这些匹配结果分页。

配送商品池 `/night-rider/night/stock/pool` 增加 `barcode` 和 `categoryName`，用于本地搜索与分类。筛选只影响展示，不清空已选商品或改变服务端额度校验。
