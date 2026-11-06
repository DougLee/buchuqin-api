import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { USER_ROLES_KEY, UserRoleGuard } from '../auth/user-role.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { NightUserService } from './night-user.service';
import { NightAfterSaleDto, NightOrderCreateDto } from './night.dto';
import { CancelReasonDto } from '../business/dto';

/**
 * 用户端夜宵接口（IKSW1F）：/night/*。
 * 用户 JWT 鉴权（UserRoleGuard 只放 role=user，与白天业务同守卫链）。
 * 购物车一期为客户端本地暂存（提交时服务端全量重验），无服务端购物车。
 */
@ApiTags('用户端-夜宵店')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserRoleGuard)
@SetMetadata(USER_ROLES_KEY, ['user'])
@Controller('night')
export class NightUserController {
  constructor(private readonly service: NightUserService) {}

  private campusId(req: AuthRequest): string {
    return req.user.campusId;
  }

  /* ---------- 店铺 ---------- */

  @Get('entry')
  @ApiOperation({ summary: '夜宵入口数据（夜宵开关/窗口/白天闭店态）' })
  async entry(@Req() req: AuthRequest) {
    return ok(await this.service.entry(this.campusId(req)));
  }

  @Get('stores')
  @ApiOperation({ summary: '楼栋店铺列表（三态，?buildingId 过滤）' })
  async stores(
    @Req() req: AuthRequest,
    @Query('buildingId') buildingId?: string,
  ) {
    return ok(await this.service.stores(this.campusId(req), buildingId));
  }

  @Get('stores/:id')
  @ApiOperation({ summary: '店铺详情（三态+营业时间+公告位预留）' })
  async storeDetail(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.storeDetail(this.campusId(req), id));
  }

  /* ---------- 商品 ---------- */

  @Get('stores/:id/products')
  @ApiOperation({ summary: '本店可购商品（上架+售卖许可+库存>0）' })
  async storeProducts(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.storeProducts(this.campusId(req), id));
  }

  /* ---------- 订单 ---------- */

  @Post('orders')
  @ApiOperation({ summary: '提交夜宵订单（服务端重验+券锁定+库存原子扣减）' })
  async submitOrder(@Req() req: AuthRequest, @Body() d: NightOrderCreateDto) {
    return ok(await this.service.submitOrder(req.user.id, d));
  }

  @Get('orders')
  @ApiOperation({ summary: '我的夜宵订单（?status 过滤）' })
  async orders(@Req() req: AuthRequest, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return ok(await this.service.orders(req.user.id, status, page, pageSize));
  }

  @Get('orders/:id')
  @ApiOperation({ summary: '夜宵订单详情' })
  async order(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.order(req.user.id, id));
  }

  @Post('orders/:id/cancel')
  @ApiOperation({ summary: '取消订单（未接单；已支付走原路退款）' })
  async cancel(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() d: CancelReasonDto,
  ) {
    const order = await this.service.cancelOrder(req.user.id, id, d.reason);
    const message = ['cancelled', 'refunded'].includes(order.status) ? '订单已取消' : order.refund?.status === 'failed' ? '退款未完成' : order.status === 'cancelling' ? '退款处理中' : '订单状态已更新，请核对';
    return ok(order, message);
  }

  @Post('orders/:id/confirm')
  @ApiOperation({ summary: '确认收货（delivered → completed，佣金转待结算）' })
  async confirm(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.confirmOrder(req.user.id, id), '已完成');
  }

  @Post('orders/:id/after-sale')
  @ApiOperation({ summary: '售后申请（轻量承载：timeline+afterSaleStatus）' })
  async afterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() d: NightAfterSaleDto,
  ) {
    return ok(
      await this.service.applyAfterSale(req.user.id, id, d),
      '售后申请已提交',
    );
  }

  /* ---------- 支付 ---------- */

  @Post('orders/:id/pay')
  @ApiOperation({ summary: '夜宵订单微信支付下单（YX 业务标记）' })
  async prepay(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.prepayOrder(req.user.id, id));
  }

  @Get('orders/:id/pay-status')
  @ApiOperation({ summary: '支付结果查询（查单兜底落账）' })
  async payStatus(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.orderPayStatus(req.user.id, id));
  }

  /* ---------- 券 ---------- */

  @Get('coupons')
  @ApiOperation({ summary: '夜宵券（可领+我的，businessType=night 隔离）' })
  async coupons(@Req() req: AuthRequest) {
    return ok(await this.service.coupons(req.user.id, this.campusId(req)));
  }

  @Post('coupons/:couponId/claim')
  @ApiOperation({ summary: '领取夜宵券（白天券在夜宵渠道拒收，双向隔离）' })
  async claim(@Req() req: AuthRequest, @Param('couponId') couponId: string) {
    return ok(
      await this.service.claimCoupon(req.user.id, couponId, this.campusId(req)),
      '领取成功',
    );
  }
}
