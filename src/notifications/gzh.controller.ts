import { Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';

/**
 * 服务号回调（IKI3ZP，公网公开）：微信服务器推送事件（subscribe/unsubscribe）。
 * 鉴权 = 微信签名（token 验签在 service），不挂 JWT 守卫。
 * XML 报文不经 JSON parser，此处手动收原始流。
 */
@Controller('notifications/gzh')
export class GzhController {
  constructor(private readonly notifications: NotificationsService) {}

  /** URL 有效性验证（微信后台配置服务器时的一次性 GET）+ 事件推送入口。 */
  @ApiExcludeEndpoint()
  @Get()
  verify(@Query() query: Record<string, string>) {
    return this.notifications.handleGzhCallback(query, '');
  }

  @ApiExcludeEndpoint()
  @Post()
  handleEvent(
    @Req() req: IncomingMessage,
    @Query() query: Record<string, string>,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.notifications
          .handleGzhCallback(query, Buffer.concat(chunks).toString('utf8'))
          .then(resolve)
          .catch(() => resolve('success'));
      });
      req.on('error', () => resolve('success'));
    });
  }
}
