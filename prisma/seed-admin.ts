/**
 * 初始超管账号种子（ADR-0004 / IK9JHP）。
 * 与 seed.ts 解耦：不灌演示数据也可单独创建/重置后台账号。
 *
 * 用法：
 *   ADMIN_INITIAL_USERNAME=admin ADMIN_INITIAL_PASSWORD='<强密码>' pnpm db:seed:admin
 *
 * 幂等：username 已存在则重置密码（用于找回），不存在则创建。
 * 角色固定 admin、campusId 固定 ADMIN_CAMPUS_ID；运营/仓储/财务账号上线后由
 * 超管在后台维护（账号管理界面属后续里程碑，试点期可复用本脚本改 role）。
 */
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { ADMIN_CAMPUS_ID } from '../src/common/campus';

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_INITIAL_USERNAME ?? 'admin';
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error(
      'ADMIN_INITIAL_PASSWORD 未设置或不足 8 位，拒绝创建弱密码账号',
    );
  }
  const passwordHash = await hash(password, 10);
  const account = await prisma.adminAccount.upsert({
    where: { username },
    update: { passwordHash },
    create: {
      username,
      passwordHash,
      nickname: '平台管理员',
      role: 'admin',
      campusId: ADMIN_CAMPUS_ID,
    },
  });
  console.log(
    `[seed-admin] 超管账号就绪: ${account.username}（${account.id}，角色 ${account.role}）`,
  );
  // IKAJSL 总部长账号：设 HQ_INITIAL_PASSWORD 时创建/重置（username 固定 hq，
  // campusId 空 = 跨校区视角）。不设置则跳过，不影响单校区部署。
  const hqPassword = process.env.HQ_INITIAL_PASSWORD;
  if (hqPassword && hqPassword.length >= 8) {
    const hqAccount = await prisma.adminAccount.upsert({
      where: { username: 'hq' },
      update: { passwordHash: await hash(hqPassword, 10) },
      create: {
        username: 'hq',
        passwordHash: await hash(hqPassword, 10),
        nickname: '总部运营',
        role: 'hq',
        campusId: '',
      },
    });
    console.log(
      `[seed-admin] 总部账号就绪: ${hqAccount.username}（${hqAccount.id}，角色 ${hqAccount.role}，跨校区）`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
