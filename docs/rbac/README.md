# 权限改造本地交付

2026-09-21。实现与本地验收完成；两个项目均留在 feature/rbac-v1 工作树，未提交、推送、合并或部署生产。

- [逐项完成审计](completion-audit.md)：对照原Goal A1—E8。
- [管理员操作说明](operator-guide.md)：B模型、多校区、角色与菜单、会话及字段边界。
- [迁移与回滚](migration-guide.md)：新库引导、旧库升级、逐账号对照和回滚约束。
- [主线兼容](main-compatibility.md)：固定API/后台SHA及移植行为。
- [范围矩阵](data-scope-matrix.md)、[接口清单](endpoint-inventory.json)、[测试索引](endpoint-evidence.json)、[补充复核](residual-route-review.md)。
- [迁移对照结果](upgrade-rehearsal.json)、[过程记录](implementation-status.md)。过程记录按时间追加，早期pending由最终完成审计取代。
- [证据文件校验清单](evidence/manifest.json)：保存测试日志、迁移diff、浏览器截图；原/tmp路径只是采集位置。

## 验证结果与复现

API使用隔离合成数据库 buchuqin_rbac_regression_20260921，运行 `pnpm exec jest --runInBand`：40套285项通过。`pnpm exec tsc --noEmit`通过。后台 `pnpm run build`通过（vue-tsc+Vite），`pnpm run test:rbac-session`为14个场景全部通过（TAP计父测试为15）。对应日志在evidence目录。构建有非阻断的静态/动态import分包提示，未影响功能或构建结果。

复现前先按migration-guide创建隔离库、生成Prisma客户端并载入项目合成seed；领域回归需要官方商品库与总部仓种子。不要将测试DATABASE_URL指向真实业务库。接口索引：`pnpm exec ts-node scripts/rbac-endpoint-inventory.ts`；测试定位：`pnpm exec ts-node scripts/rbac-evidence-index.ts`。浏览器合成账号由scripts/rbac-browser-*-fixtures.ts准备，脚本有本地数据库名限制，重新执行会重置这些测试账号的授权和会话。

两个迁移演练库各52项完成、0未完成，schema diff为空。旧账号5组×A/B权限对照通过，撤权和空角色重启不恢复。合成库证明本地路径；真实上线前必须用部署库副本作逐账号核对。

## 预览与边界

本地后台 http://127.0.0.1:5191 ，API http://127.0.0.1:3191/api/v1 ，均使用checks合成库。API已重启加载最后的业务审计修复；启动后登录、权限读取及两类审计分离验证通过。测试账号qa-super可用于本地查看，密码见受本地库限制的fixture脚本。

真实COS写入、云打印和生产迁移未执行；相应权限/拒绝路径由mock及本地HTTP验证。139条接口都有授权与范围分类，不宣称139条均独立进行了所有HTTP越权组合；证据层级在索引中明确。保留既有成本与毛利字段口径，没有新增独立成本读取权限。未发现仍阻止本次本地交付的未解决项。
