import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import { paginate } from '../common/pagination';
import { BusinessService } from './business.service';
import {
  AddCartItemDto,
  CartQuantityDto,
  CreateAddressDto,
  CreateAfterSalesDto,
  CreateOrderDto,
  DrawWheelDto,
  UpdateAddressDto,
  UpdateCartDto, RecruitApplyDto,
} from './dto';
@ApiTags('用户端')
@ApiBearerAuth()
// 用户端角色白名单：员工/admin token 调用用户端接口一律 403（IK93GT）。
@SetMetadata(USER_ROLES_KEY, ['user'])
@UseGuards(JwtAuthGuard, UserRoleGuard)
@Controller()
export class BusinessController {
  constructor(private readonly service: BusinessService) {}
  @Get('home') async home(@Req() req: AuthRequest) {
    return ok(await this.service.home(req.user.campusId));
  }
  /** 支付成功页广告位（IKA57F→IKB87P）：?placement=pay-success，
   *  返回数组（sort 升序最多 2 条）；未配置返回 []。 */
  @Get('banners/current')
  async bannerByPlacement(
    @Req() req: AuthRequest,
    @Query('placement') placement?: string,
  ) {
    return ok(
      await this.service.bannerByPlacement(
        req.user.campusId,
        placement === 'pay-success' ? 'pay-success' : 'home',
      ),
    );
  }
  @Get('campus/current') async campus(@Req() req: AuthRequest) {
    return ok(await this.service.campus(req.user.campusId));
  }
  /** 校区选项（IKAJT2 选校区流程）：开放中校区列表，切换走 POST /auth/campuses/select。 */
  @Get('campuses') async campuses(@Req() req: AuthRequest) {
    return ok(await this.service.campusOptions());
  }
  @Get('categories') async categories() {
    return ok(await this.service.categories());
  }
  @Get('products')
  @ApiOperation({
    summary:
      '商品列表（?categoryId/keyword 过滤保留；?page&pageSize 统一分页包裹）',
  })
  async products(
    @Req() req: AuthRequest,
    @Query('categoryId') category?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const items = await this.service.listProducts(
      req.user.campusId,
      category,
      keyword,
      req.user.id,
    );
    // 2026-09-19 生产实测：C 端商品目录为全量消费设计（分类页完整流分组/搜索
    // 平铺），未显式翻页时返回全量信封——走 paginate 会吃 DEFAULT_PAGE_SIZE=20
    // 把大校区目录截断（湖工大 267 在售只回 20，冰镇特饮 123 只剩 4）。
    if (!page && !pageSize) {
      return ok({ items, page: 1, pageSize: items.length, total: items.length });
    }
    return ok(paginate(items, page, pageSize));
  }
  /** 限时秒杀商品（IKBW0K）：进行中 seckill 活动带促销价，分类页特殊分类用。 */
  @Get('promotions/seckill')
  @ApiOperation({ summary: '限时秒杀商品列表（进行中活动，含促销价）' })
  async seckill(@Req() req: AuthRequest) {
    return ok(await this.service.listSeckill(req.user.campusId, req.user.id));
  }
  /** 同款匹配（IKGZSU 跨校区分享）：外校区商品 id → 按条码找本校区在售同款。
   *  命中返回 productView（价格/促销按本校区）；未命中 product=null，
   *  sourceName/sourceCampusName 供前端弹窗/占位页展示来源。 */
  @Get('products/:id/local-match')
  async localMatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      await this.service.localMatchProduct(id, req.user.campusId, req.user.id),
    );
  }
  @Get('products/:id') async product(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.product(id, req.user.campusId, req.user.id));
  }
  @Get('cart') async cart(@Req() req: AuthRequest) {
    return ok(await this.service.cart(req.user.id));
  }
  @Put('cart') async updateCart(
    @Req() req: AuthRequest,
    @Body() dto: UpdateCartDto,
  ) {
    return ok(await this.service.updateCart(req.user.id, dto));
  }
  @Post('cart/items') async addCartItem(
    @Req() req: AuthRequest,
    @Body() dto: AddCartItemDto,
  ) {
    const cart = await this.service.cart(req.user.id),
      current = cart.items.find((i) => i.product.id === dto.productId);
    return ok(
      await this.service.setCartItem(
        req.user.id,
        dto.productId,
        (current?.quantity ?? 0) + dto.quantity,
      ),
    );
  }
  @Patch('cart/items/:productId') async updateCartItem(
    @Req() req: AuthRequest,
    @Param('productId') id: string,
    @Body() dto: CartQuantityDto,
  ) {
    return ok(await this.service.setCartItem(req.user.id, id, dto.quantity));
  }
  @Delete('cart/items/:productId') async deleteCartItem(
    @Req() req: AuthRequest,
    @Param('productId') id: string,
  ) {
    return ok(await this.service.setCartItem(req.user.id, id, 0));
  }
  @Delete('cart') async clearCart(@Req() req: AuthRequest) {
    return ok(await this.service.clearCart(req.user.id));
  }
  @Post('orders/checkout') async checkout(
    @Req() req: AuthRequest,
    @Body() dto: CreateOrderDto,
  ) {
    return ok(await this.service.checkout(req.user.id, req.user.campusId, dto));
  }
  @Post('orders')
  @ApiOperation({ summary: '创建待支付测试订单' })
  async createOrder(@Req() req: AuthRequest, @Body() dto: CreateOrderDto) {
    return ok(
      await this.service.createOrder(req.user.id, req.user.campusId, dto),
      '下单成功',
    );
  }
  @Get('orders')
  @ApiOperation({
    summary: '我的订单（?status 过滤保留；?page&pageSize 统一分页包裹）',
  })
  async orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return ok(
      paginate(await this.service.orders(req.user.id, status), page, pageSize),
    );
  }
  @Get('orders/:id') async order(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.order(req.user.id, id));
  }
  @Post('orders/:id/cancel') async cancel(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.cancel(req.user.id, id), '订单已取消');
  }
  @Post('orders/:id/confirm-receipt') async confirm(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.confirmReceipt(req.user.id, id), '已确认收货');
  }
  @Get('addresses')
  @ApiOperation({ summary: '地址列表（?page&pageSize 统一分页包裹）' })
  async addresses(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return ok(
      paginate(
        await this.service.addresses(req.user.id, req.user.campusId),
        page,
        pageSize,
      ),
    );
  }
  @Post('addresses') async addAddress(
    @Req() req: AuthRequest,
    @Body() dto: CreateAddressDto,
  ) {
    return ok(
      await this.service.addAddress(req.user.id, req.user.campusId, dto),
      '地址已保存',
    );
  }
  @Patch('addresses/:id') async updateAddress(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return ok(
      await this.service.updateAddress(req.user.id, req.user.campusId, id, dto),
    );
  }
  @Delete('addresses/:id') async deleteAddress(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      await this.service.deleteAddress(req.user.id, req.user.campusId, id),
    );
  }
  @Put('addresses/:id/default') async defaultAddress(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      await this.service.setDefaultAddress(req.user.id, req.user.campusId, id),
    );
  }
  @Get('campuses/current/buildings') async buildings(
    @Req() req: AuthRequest,
    // IKEAGE：楼长报名页跨校区选楼栋——?campusId= 指定开放中校区（缺省当前）
    @Query('campusId') campusId?: string,
  ) {
    return ok(await this.service.buildings(campusId || req.user.campusId));
  }
  /** 楼栋寝室列表（IKD6FH）：?floor= 选填收窄到某层，供地址四级选择 */
  @Get('campuses/current/buildings/:buildingId/rooms')
  async buildingRooms(
    @Req() req: AuthRequest,
    @Param('buildingId') buildingId: string,
    @Query('floor') floor?: string,
  ) {
    return ok(
      await this.service.buildingRooms(
        req.user.campusId,
        buildingId,
        floor ? Number(floor) : undefined,
      ),
    );
  }
  @Get('coupons') async coupons(@Req() req: AuthRequest) {
    return ok(await this.service.coupons(req.user.id, req.user.campusId));
  }
  @Post('coupons/:couponId/claim') async claimCoupon(
    @Req() req: AuthRequest,
    @Param('couponId') couponId: string,
  ) {
    return ok(
      await this.service.claimCoupon(req.user.id, couponId, req.user.campusId),
      '领取成功',
    );
  }
  @Post('coupons/available') async availableCoupons(
    @Req() req: AuthRequest,
    @Body() dto: CreateOrderDto,
  ) {
    return ok(
      await this.service.availableCoupons(req.user.id, req.user.campusId, dto),
    );
  }
  @Get('delivery/slots') async slots(@Req() req: AuthRequest) {
    return ok(await this.service.slots(req.user.campusId));
  }
  @Post('orders/:id/after-sales') async createAfterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: CreateAfterSalesDto,
  ) {
    return ok(
      await this.service.createAfterSales(req.user.id, id, dto),
      '售后申请已提交',
    );
  }
  @Get('after-sales') async afterSales(@Req() req: AuthRequest) {
    return ok(await this.service.afterSales(req.user.id));
  }
  @Get('after-sales/:id') async afterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.afterSale(req.user.id, id));
  }
  @Post('after-sales/:id/cancel') async cancelAfterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.cancelAfterSale(req.user.id, id));
  }
  @Get('refunds') async refunds(@Req() req: AuthRequest) {
    return ok(await this.service.refunds(req.user.id));
  }
  @Get('refunds/:id') async refund(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.refund(req.user.id, id));
  }
  @Get('notifications')
  @ApiOperation({ summary: '站内消息列表（?page&pageSize 统一分页包裹）' })
  async notifications(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return ok(
      paginate(await this.service.notifications(req.user.id), page, pageSize),
    );
  }
  @Post('notifications/:id/read') async readNotification(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.readNotification(req.user.id, id));
  }
  @Post('notifications/read-all') async readAll(
    @Req() req: AuthRequest,
    @Body() body: { type?: string } = {},
  ) {
    return ok(await this.service.readAllNotifications(req.user.id, body.type));
  }
  @Get('notifications/unread-count') async unread(@Req() req: AuthRequest) {
    return ok(await this.service.unreadNotificationCount(req.user.id));
  }
  /** 进群二维码（IKAJSZ）：当前地址楼栋群（?buildingId= 覆盖，缺省默认地址）
   *  → 校级大群 → null（前端隐藏入口）。 */
  @Get('wechat-group') async wechatGroup(
    @Req() req: AuthRequest,
    @Query('buildingId') buildingId?: string,
  ) {
    return ok(await this.service.wechatGroup(req.user.id, buildingId || undefined));
  }

  /** 转盘信息（IKD6FB）：首页入口显隐 + 转盘页奖位/今日已抽，两处共用。 */
  @Get('wheel') async wheel(@Req() req: AuthRequest) {
    return ok(await this.service.wheel(req.user.id, req.user.campusId));
  }
  /** 抽奖（IKD6FB）：每日 1 次，权重随机，平台券自动入账。 */
  @Post('wheel/draw') async drawWheel(
    @Req() req: AuthRequest,
    @Body() _dto: DrawWheelDto,
  ) {
    return ok(await this.service.drawWheel(req.user.id, req.user.campusId));
  }

  /* ---------- 楼长招募（IKEAGE）：报名页即进度页（banner 自定义路径直达） ---------- */
  /** 我的报名（最新一条任意状态；approved 附工号供 C 端展示登录指引） */
  @Get('recruit/application')
  @ApiOperation({ summary: '我的楼长报名（IKEAGE）' })
  async recruitApplication(@Req() req: AuthRequest) {
    return ok(await this.service.recruitApplication(req.user.id));
  }
  @Post('recruit/applications')
  @ApiOperation({ summary: '楼长报名（IKEAGE）' })
  async recruitApply(
    @Req() req: AuthRequest,
    @Body() dto: RecruitApplyDto,
  ) {
    return ok(await this.service.recruitApply(req.user.id, dto));
  }
  /** 审核前修改报名（IKEAGE）：仅待联系/面试中可改，body 同报名 */
  @Patch('recruit/application')
  @ApiOperation({ summary: '修改楼长报名（IKEAGE，审核前）' })
  async recruitUpdate(
    @Req() req: AuthRequest,
    @Body() dto: RecruitApplyDto,
  ) {
    return ok(await this.service.recruitUpdate(req.user.id, dto));
  }
}
