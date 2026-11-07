> 历史阶段记录（2026-11-07夜宵基础功能目标）。当前日夜对齐目标、测试与部署版本见 [最新交付报告](../day-night-parity/FINAL_REPORT.md) 和 [当前TEST部署](../day-night-parity/DEPLOYMENT.md)，不能沿用本文旧版本号执行升级。

# 夜宵四端Goal最终状态

2026-11-07：原43项冻结验收，42项通过，**98%**；全部核心项通过。唯一剩余X05真实微信/真机外部能力2%明确未验收。完整结论以 [ACCEPTANCE_REPORT.md](ACCEPTANCE_REPORT.md) 和自动计算的 [acceptance-progress.json](acceptance-progress.json) 为准，旧阶段记录不代表最终状态。

已完成真实PG75项、HTTP35项、配送行为17项、用户行为7项、隔离3项、五角色HTTP、五迁移兼容、最终账本/商品独立性核对、四端类型与构建、90个主要页面/尺寸布局、真实受控断网恢复及跨端业务。没有使用或连接生产业务API或生产数据库测试。

代码已按仓库提交，版本见 [RELEASE_VERSIONS.json](RELEASE_VERSIONS.json)。部署、迁移、配置、账号材料位置和最终验收清单见 [TEST_DEPLOYMENT.md](TEST_DEPLOYMENT.md)。自主决定记录见 [DECISIONS.md](DECISIONS.md)，外部未验证清单见 [NATIVE_VERIFICATION.md](NATIVE_VERIFICATION.md)。

当前本机服务保留供复测：API3150、后台5191、配送5192、用户5193；重启前实际核对PID/cwd，不使用记录中的旧PID。数据库只使用 `_spec` 独立schema。浏览器保留后台、配送首页、用户首页，未提交购物车/备货草稿已清理，真实测试业务记录保留。

复算：`node scripts/report-night-acceptance.mjs --write`。脚本校验原基线SHA-256、元数据和证据，不能通过改变原标准或权重提高完成率。生产发布仍由用户另行安排。
