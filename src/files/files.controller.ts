import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { memoryStorage } from 'multer';
import COS from 'cos-nodejs-sdk-v5';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { PrismaService } from '../database/prisma.service';
import { RbacService } from '../admin/rbac/rbac.service';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
// MIME 白名单：位图格式收敛，拒绝 svg+xml（可携带脚本导致存储型 XSS）。
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// 腾讯 COS 客户端（ADR-0003：替代本地磁盘存储）
// 惰性初始化：模块求值早于 ConfigModule 加载 .env，顶层创建会拿到空密钥
let cosClient: COS | null = null;
const getCos = () => {
  cosClient ??= new COS({
    SecretId: process.env.COS_SECRET_ID ?? '',
    SecretKey: process.env.COS_SECRET_KEY ?? '',
  });
  return cosClient;
};
const COS_BUCKET = process.env.COS_BUCKET ?? '';
const COS_REGION = process.env.COS_REGION ?? '';
const COS_PUBLIC_BASE =
  process.env.COS_PUBLIC_BASE_URL ??
  `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;

const monthlyFolder = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `uploads/${now.getFullYear()}/${month}`;
};

// IK9VBI/IK9VBM：目录白名单——app/ 系放小程序静态素材（Banner 背景 app/、
// 商品图 app/product/、分类图 app/category/、群码 app/wechat-group/ IKC1AE），
// 缺省 uploads/（按月归档）放运营素材；其余值拒绝，防任意前缀落桶。
// RBAC V1（2026-09-19）：app/idcard=身份证照片私有目录——private ACL +
// recruit.idcard.write 门控，读取走签名 URL（cos-presign.ts），不复用公开图。
const FOLDERS = new Set([
  'uploads',
  'app',
  'app/product',
  'app/category',
  'app/wechat-group',
  'app/idcard',
]);
const PRIVATE_FOLDERS = new Set(['app/idcard']);

const putToCos = (
  key: string,
  buffer: Buffer,
  mimetype: string,
  acl: 'public-read' | 'private',
) =>
  new Promise<string>((resolve, reject) => {
    getCos().putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        ACL: acl,
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data.Location);
      },
    );
  });

@ApiTags('文件上传')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(
    private readonly db: PrismaService,
    private readonly rbac: RbacService,
  ) {}
  @Post('images')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
          cb(
            new BadRequestException(
              '只能上传 JPG、PNG、WebP 或 GIF 格式的图片文件',
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  async uploadImage(
    @Req() req: AuthRequest,
    @Query('folder') folder?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('请上传文件');
    if (!COS_BUCKET || !COS_REGION)
      throw new BadRequestException('文件存储未配置，请检查 COS 环境变量');
    const target = folder ?? 'uploads';
    if (!FOLDERS.has(target))
      throw new BadRequestException(
        `不支持的目录：${target}（可选 ${[...FOLDERS].join(' / ')}）`,
      );

    // RBAC V1：私有目录（身份证照片）须为在职后台账号且持 recruit.idcard.write
    if (PRIVATE_FOLDERS.has(target)) {
      const account = await this.db.adminAccount.findUnique({
        where: { id: req.user.id },
      });
      if (!account || account.status !== 'active')
        throw new ForbiddenException('该目录仅后台账号可用');
      const tokenSv = (req.user as { sv?: number }).sv ?? 0;
      if (tokenSv !== account.sessionVersion)
        throw new ForbiddenException('登录已失效，请重新登录');
      const ctx = await this.rbac.getEffective(account);
      // 蛋词体系：URL 模式判定（recruit.idcard.write 节点的按钮模式）
      if (!this.rbac.allow(ctx, 'POST', '/admin/recruit-applications/:id/idcard'))
        throw new ForbiddenException('无身份证资料上传权限');
    }

    const ext = extname(file.originalname || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.jpg';
    // app/ 系（小程序素材，IK9VBI）直接落白名单对应 COS 子目录（IKC1AE 起
    // 支持 app/wechat-group 等子目录）；uploads/ 按月归档
    const dir = target === 'uploads' ? monthlyFolder() : target;
    const key = `${dir}/${randomUUID()}${safeExt}`;

    try {
      await putToCos(
        key,
        file.buffer,
        file.mimetype,
        PRIVATE_FOLDERS.has(target) ? 'private' : 'public-read',
      );
    } catch (error) {
      throw new BadRequestException(
        `上传到对象存储失败：${(error as Error).message}`,
      );
    }

    return ok(
      {
        url: `${COS_PUBLIC_BASE}/${key}`,
        private: PRIVATE_FOLDERS.has(target),
      },
      '上传成功',
    );
  }
}
