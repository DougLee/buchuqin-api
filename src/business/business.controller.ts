import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { MockStore } from '../mock/mock.store';
import { BusinessService } from './business.service';
import {
  CreateAddressDto,
  AddCartItemDto,
  CartQuantityDto,
  CreateAfterSalesDto,
  CreateOrderDto,
  UpdateCartDto,
  UpdateAddressDto,
} from './dto';
@ApiTags('用户端 MVP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class BusinessController {
  constructor(
    private readonly service: BusinessService,
    private readonly store: MockStore,
  ) {}
  @Get('home') home() {
    return ok(this.service.home());
  }
  @Get('campus/current') campus() {
    return ok(this.store.campus);
  }
  @Get('categories') categories() {
    return ok(this.store.categories);
  }
  @Get('products') products(
    @Query('categoryId') category?: string,
    @Query('keyword') keyword?: string,
    @Query('page') pageValue = '1',
    @Query('pageSize') pageSizeValue = '20',
  ) {
    const all = this.service.listProducts(category, keyword);
    const page = Math.max(1, Number(pageValue) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(pageSizeValue) || 20));
    return ok({
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
    });
  }
  @Get('products/:id') product(@Param('id') id: string) {
    return ok(this.service.product(id));
  }
  @Get('cart') cart(@Req() req: AuthRequest) {
    return ok(this.service.cart(req.user.id));
  }
  @Put('cart') updateCart(@Req() req: AuthRequest, @Body() dto: UpdateCartDto) {
    return ok(this.service.updateCart(req.user.id, dto));
  }
  @Post('cart/items') addCartItem(
    @Req() req: AuthRequest,
    @Body() dto: AddCartItemDto,
  ) {
    const current = this.service
      .cart(req.user.id)
      .items.find((item) => item.product.id === dto.productId);
    return ok(
      this.service.setCartItem(
        req.user.id,
        dto.productId,
        (current?.quantity ?? 0) + dto.quantity,
      ),
    );
  }
  @Patch('cart/items/:productId') updateCartItem(
    @Req() req: AuthRequest,
    @Param('productId') productId: string,
    @Body() dto: CartQuantityDto,
  ) {
    return ok(this.service.setCartItem(req.user.id, productId, dto.quantity));
  }
  @Delete('cart/items/:productId') deleteCartItem(
    @Req() req: AuthRequest,
    @Param('productId') productId: string,
  ) {
    return ok(this.service.setCartItem(req.user.id, productId, 0));
  }
  @Delete('cart') clearCart(@Req() req: AuthRequest) {
    return ok(this.service.clearCart(req.user.id));
  }
  @Post('orders/checkout') checkout(
    @Req() req: AuthRequest,
    @Body() dto: CreateOrderDto,
  ) {
    return ok(this.service.checkout(req.user.id, dto));
  }
  @Post('orders')
  @ApiOperation({ summary: '创建待支付 Mock 订单' })
  createOrder(@Req() req: AuthRequest, @Body() dto: CreateOrderDto) {
    return ok(this.service.createOrder(req.user.id, dto), '下单成功');
  }
  @Get('orders') orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('page') pageValue = '1',
    @Query('pageSize') pageSizeValue = '20',
  ) {
    const all = this.service.orders(req.user.id, status);
    const page = Math.max(1, Number(pageValue) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(pageSizeValue) || 20));
    return ok({
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
    });
  }
  @Get('orders/:id') order(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(this.service.order(req.user.id, id));
  }
  @Post('orders/:id/pay') pay(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.pay(req.user.id, id), '模拟支付成功');
  }
  @Post('orders/:id/cancel') cancel(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.cancel(req.user.id, id), '订单已取消');
  }
  @Post('orders/:id/mock-advance') advance(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.advance(req.user.id, id), '履约状态已推进');
  }
  @Post('orders/:id/confirm-receipt') confirmReceipt(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.confirmReceipt(req.user.id, id), '已确认收货');
  }
  @Get('addresses') addresses(@Req() req: AuthRequest) {
    return ok(this.service.addresses(req.user.id, req.user.campusId));
  }
  @Post('addresses') addAddress(
    @Req() req: AuthRequest,
    @Body() dto: CreateAddressDto,
  ) {
    return ok(
      this.service.addAddress(req.user.id, req.user.campusId, dto),
      '地址已保存',
    );
  }
  @Patch('addresses/:id') updateAddress(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return ok(
      this.service.updateAddress(req.user.id, req.user.campusId, id, dto),
    );
  }
  @Delete('addresses/:id') deleteAddress(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.deleteAddress(req.user.id, req.user.campusId, id));
  }
  @Put('addresses/:id/default') defaultAddress(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      this.service.setDefaultAddress(req.user.id, req.user.campusId, id),
    );
  }
  @Get('campuses/current/buildings') buildings() {
    return ok([
      {
        id: 'west-5',
        name: '西区 5 栋',
        minFloor: 1,
        maxFloor: 7,
        available: true,
      },
      {
        id: 'west-6',
        name: '西区 6 栋',
        minFloor: 1,
        maxFloor: 7,
        available: true,
      },
      {
        id: 'west-7',
        name: '西区 7 栋',
        minFloor: 1,
        maxFloor: 7,
        available: true,
      },
    ]);
  }
  @Get('coupons') coupons() {
    return ok(this.store.coupons);
  }
  @Post('coupons/available') availableCoupons(
    @Req() req: AuthRequest,
    @Body() dto: CreateOrderDto,
  ) {
    return ok(this.service.availableCoupons(req.user.id, dto));
  }
  @Get('delivery/slots') slots() {
    return ok(this.store.deliverySlots);
  }
  @Post('orders/:id/after-sales') createAfterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: CreateAfterSalesDto,
  ) {
    return ok(
      this.service.createAfterSales(req.user.id, id, dto),
      '售后申请已提交',
    );
  }
  @Get('after-sales') afterSales(@Req() req: AuthRequest) {
    return ok(this.service.afterSales(req.user.id));
  }
  @Get('after-sales/:id') afterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.afterSale(req.user.id, id));
  }
  @Post('after-sales/:id/cancel') cancelAfterSale(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.cancelAfterSale(req.user.id, id));
  }
  @Get('refunds') refunds(@Req() req: AuthRequest) {
    return ok(this.service.refunds(req.user.id));
  }
  @Get('refunds/:id') refund(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(this.service.refund(req.user.id, id));
  }
  @Get('notifications') notifications(@Req() req: AuthRequest) {
    return ok(this.service.notifications(req.user.id));
  }
  @Post('notifications/:id/read') readNotification(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.readNotification(req.user.id, id));
  }
  @Post('notifications/read-all') readAllNotifications(
    @Req() req: AuthRequest,
    @Body() body: { type?: string },
  ) {
    return ok(this.service.readAllNotifications(req.user.id, body.type));
  }
  @Get('notifications/unread-count') unreadNotificationCount(
    @Req() req: AuthRequest,
  ) {
    return ok(this.service.unreadNotificationCount(req.user.id));
  }
}
