import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';

/** 存活/就绪探针（IK93GT/IK93GM）：compose healthcheck 与反代探活共用。 */
@ApiTags('健康检查')
@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}
  @Get()
  @ApiOperation({ summary: '存活检查（含数据库连通性）' })
  async health() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        database: 'up',
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'degraded',
        database: 'down',
        timestamp: new Date().toISOString(),
      };
    }
  }
}
