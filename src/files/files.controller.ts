import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { diskStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const UPLOAD_ROOT = join(process.cwd(), 'uploads');
const monthlyFolder = () => {
  const now = new Date();
  return join(
    UPLOAD_ROOT,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
  );
};

@ApiTags('文件上传')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  @Post('images')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const folder = monthlyFolder();
          void mkdir(folder, { recursive: true })
            .then(() => cb(null, folder))
            .catch((error: Error) => cb(error, folder));
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').toLowerCase();
          const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.jpg';
          cb(null, `${randomUUID()}${safeExt}`);
        },
      }),
      limits: { fileSize: MAX_IMAGE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new BadRequestException('只能上传图片文件'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  async uploadImage(
    @Req() _req: AuthRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('请上传文件');
    const folder = monthlyFolder();
    return ok(
      {
        url: `/api/v1/uploads/${folder.slice(UPLOAD_ROOT.length + 1)}/${file.filename}`,
      },
      '上传成功',
    );
  }
}
