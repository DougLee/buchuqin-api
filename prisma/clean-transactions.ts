/**
 * 发版前数据清理（ADR-0004 / 发版 grilling 2026-08-19 W8）：
 * 清空「交易类」数据，保留「资产类」数据，让正式环境从零单量起步。
 *
 * 保留（不动）：Campus / AdminAccount / Category / Product / Banner /
 *   Building / Room / Address（用户地址保留，避免早期用户重填）/ Staff /
 *   LeaveRequest / DispatchInvitation / CommissionRule / DeliverySlot /
 *   Coupon（券模板；UserCoupon 已发记录随交易清）
 * 清空（按依赖序）：Order → AfterSale → Refund → Commission → BmBill →
 *   Notification → UserCoupon → CartItem → InventoryTxn → AuditLog
 *   （User 保留：openid 是登录资产，删了用户下次进小程序要重新授权手机号）
 *
 * 用法：
 *   DRY_RUN=1 pnpm db:clean   # 预览将删的行数，不动数据（默认即 DRY_RUN）
 *   APPLY=1 pnpm db:clean     # 真正执行（事务内按依赖序删除）
 *
 * 幂等：重复执行安全（清空操作天然幂等）。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** 交易类模型，按外键依赖排序（被引用者先删）。 */
const TX_MODELS = [
  'refund',
  'afterSale',
  'commission',
  'bmBill',
  'order',
  'notification',
  'userCoupon',
  'cartItem',
  'inventoryTxn',
  'auditLog',
] as const;

async function main() {
  const apply = process.env.APPLY === '1';
  if (!apply) console.log('[dry-run] 仅预览，确认后用 APPLY=1 执行\n');

  const counts: Record<string, number> = {};
  for (const model of TX_MODELS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    counts[model] = await (prisma as any)[model].count();
  }

  console.log('将清空的交易数据：');
  let total = 0;
  for (const [model, count] of Object.entries(counts)) {
    console.log(`  ${model.padEnd(20)} ${count}`);
    total += count;
  }
  console.log(`  合计 ${total} 行；保留：商品/分类/楼栋/寝室/员工/提成规则/券模板/用户/账号/地址\n`);

  if (!apply) {
    console.log('预览完成，未删除任何数据。');
    return;
  }

  await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TX_MODELS.map((model) => (prisma as any)[model].deleteMany({})),
  );
  console.log('已清空全部交易数据（事务完成）。');
  // 商品库存回到干净基线：锁定库存清零、销量清零，实际库存保留当前值。
  await prisma.product.updateMany({
    data: { lockedStock: 0, sales: 0 },
  });
  console.log('商品 lockedStock/sales 已归零（实际库存保留）。');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
