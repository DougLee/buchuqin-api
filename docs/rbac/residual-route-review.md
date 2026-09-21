# 自动索引未匹配条目的人工复核

索引只是静态调用定位，不能替代断言审阅。2026-09-21 当前 139 条，94 条直接 HTTP 调用、28 条服务调用、17 条未静态匹配。以下逐组解释全部17条，避免把别名/循环/浏览器证据遗漏误当为业务漏洞，也不将源码检查冒充 HTTP 测试。

| 路由 | 实际证据和范围结论 |
|---|---|
| GET banners / commission-rules / coupons / locations / printers / promotions（6条） | rbac-scope.integration 的 list endpoints 测试循环逐项请求，响应包含真实A记录、不含真实B记录，campus及campusId伪造均不扩大。静态脚本不解析循环变量。完整285项回归已执行此循环。 |
| POST/PATCH/DELETE categories（3条） | AdminService 三个分类方法已逐项读取：全局共享字典，无campus归属；写入受各自METHOD权限控制；创建/改名判重、有关联商品禁止删除。当前校区仅作为审计归属。类别产品计数读取已有A/B HTTP验证。这里的写入为源码核对，不声称逐条HTTP写测试。 |
| GET featured（1条） | AdminService.featured where campusId；真实浏览器只读账号读取本校已选商品、编辑账号清空保存并查DB。PUT跨校区混合ID已有HTTP测试。 |
| GET rbac/accounts/:id/preview、GET rbac/audit（2条） | access-policy PLATFORM_PATTERNS显式列举；rbac.integration“校区列表…全局账号/权限预览/授权审计不能由校区角色获得”测试循环请求并拒绝。对应全局读取只允许该操作的平台授权，权限审计与通用业务日志已分离。 |
| GET rbac/catalog、PATCH rbac/roles/:id（2条） | access-policy super-only正则强制，不能通过普通角色勾接口绕过；rbac.integration配置拒绝及角色编辑/空菜单/版本刷新测试；浏览器接口搜索多选保存回显、角色树保存重开。 |
| GET restock/batches（1条） | restock.spec“列表与详情：校区只看本校区，总部看全校区”使用服务别名，静态索引未归并；已审阅批次共享元数据与嵌套订单按campus过滤。valid-scope另验证实际订单、收货及采购汇总隐藏；浏览器只读/编辑账号均可显示批次。 |
| POST restock/batches、PATCH restock/batches/:id（2条） | PLATFORM_PATTERNS明确平台专属且须匹配本操作，混合平台只读不放大校区写。领域restock测试通过；浏览器仅PATCH账号成功编辑批次，无创建按钮；只读账号两项都不显示。POST合法批次创建由restock领域测试覆盖，非单独HTTP正向声称。 |

源码证据的准确方法与行号见 endpoint-inventory.json；测试名称与定位见 endpoint-evidence.json。新增测试后的后端最新执行：/tmp/buchuqin-rbac-audit-isolation-full.log（40套285通过）；类型检查 /tmp/buchuqin-rbac-audit-isolation-tsc.log。

这份复核说明证据的层级，不将139条都声明为直接HTTP越权验证。全部接口均经过统一守卫，代表性有效A/B目标、全部资源类别及敏感/批量/嵌套操作由范围矩阵列出的HTTP与领域测试覆盖；最终Goal判定见 completion-audit.md。
