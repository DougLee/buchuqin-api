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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { BusinessService } from './business.service';
import {
  AddCartItemDto,
  CartQuantityDto,
  CreateAddressDto,
  CreateAfterSalesDto,
  CreateOrderDto,
  UpdateAddressDto,
  UpdateCartDto,
} from './dto';
@ApiTags('用户端')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class BusinessController {
  constructor(private readonly service: BusinessService) {}
  @Get('home') async home() {
    return ok(await this.service.home());
  }
  @Get('campus/current') async campus() {
    return ok(await this.service.campus());
  }
  @Get('categories') async categories() {
    return ok(await this.service.categories());
  }
  @Get('products') async products(
    @Query('categoryId') category?: string,
    @Query('keyword') keyword?: string,
    @Query('page') pv = '1',
    @Query('pageSize') psv = '20',
  ) {
    const all = await this.service.listProducts(category, keyword),
      page = Math.max(1, Number(pv) || 1),
      pageSize = Math.min(50, Math.max(1, Number(psv) || 20));
    return ok({
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
    });
  }
  @Get('products/:id') async product(@Param('id') id: string) {
    return ok(await this.service.product(id));
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
    return ok(await this.service.checkout(req.user.id, dto));
  }
  @Post('orders')
  @ApiOperation({ summary: '创建待支付测试订单' })
  async createOrder(@Req() req: AuthRequest, @Body() dto: CreateOrderDto) {
    return ok(await this.service.createOrder(req.user.id, dto), '下单成功');
  }
  @Get('orders') async orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('page') pv = '1',
    @Query('pageSize') psv = '20',
  ) {
    const all = await this.service.orders(req.user.id, status),
      page = Math.max(1, Number(pv) || 1),
      pageSize = Math.min(50, Math.max(1, Number(psv) || 20));
    return ok({
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
    });
  }
  @Get('orders/:id') async order(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.order(req.user.id, id));
  }
  @Post('orders/:id/pay') async pay(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.pay(req.user.id, id), '测试支付成功');
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
  @Get('addresses') async addresses(@Req() req: AuthRequest) {
    return ok(await this.service.addresses(req.user.id, req.user.campusId));
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
  @Get('campuses/current/buildings') async buildings(@Req() req: AuthRequest) {
    return ok(await this.service.buildings(req.user.campusId));
  }
  @Get('coupons') async coupons(@Req() req: AuthRequest) {
    return ok(await this.service.coupons(req.user.id, req.user.campusId));
  }
  @Post('coupons/:couponId/claim') async claimCoupon(
    @Req() req: AuthRequest,
    @Param('couponId') couponId: string,
  ) {
    return ok(
      await this.service.claimCoupon(req.user.id, couponId),
      '领取成功',
    );
  }
  @Post('coupons/available') async availableCoupons(
    @Req() req: AuthRequest,
    @Body() dto: CreateOrderDto,
  ) {
    return ok(await this.service.availableCoupons(req.user.id, dto));
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
  @Get('notifications') async notifications(@Req() req: AuthRequest) {
    return ok(await this.service.notifications(req.user.id));
  }
  @Post('notifications/:id/read') async readNotification(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.readNotification(req.user.id, id));
  }
  @Post('notifications/read-all') async readAll(
    @Req() req: AuthRequest,
    @Body() body: { type?: string },
  ) {
    return ok(await this.service.readAllNotifications(req.user.id, body.type));
  }
  @Get('notifications/unread-count') async unread(@Req() req: AuthRequest) {
    return ok(await this.service.unreadNotificationCount(req.user.id));
  }
}
