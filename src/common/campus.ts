/**
 * 管理端 token 的默认校园范围（IK8W5J 多校园隔离）。
 * 平台运营 token 固定落在湖工大校园，多校区运营位拆分后再按账号分配；
 * 其余写路径一律从 req.user.campusId（JWT claims）取，不得在业务代码里散落硬编码。
 */
export const ADMIN_CAMPUS_ID = 'campus-hbut';

/**
 * 官方商品库伪校区（IKAJSM 道哥决策版）： Campus 表里 status='official' 的一行，
 * hq 的商品读写都落这个"校区"；campuses() 列表与用户端选校区流程均排除。
 * 好处：Product.campusId 保持非空 + 外键不变，全部按校区隔离的查询零改动。
 */
export const OFFICIAL_CAMPUS_ID = 'campus-official';

/**
 * 总部仓固定 id（IKFOPY）：migration 预置的 Campus 行（type=hq），总部业务
 * （订货批次锁库存 / 铺货）按它定位；不可停用、不可删（IKFOQ0 延续使用）。
 */
export const HQ_CAMPUS_ID = 'campus-hq';
