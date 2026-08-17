/**
 * 管理端 token 的默认校园范围（IK8W5J 多校园隔离）。
 * 平台运营 token 固定落在湖工大校园，多校区运营位拆分后再按账号分配；
 * 其余写路径一律从 req.user.campusId（JWT claims）取，不得在业务代码里散落硬编码。
 */
export const ADMIN_CAMPUS_ID = 'campus-hbut';
