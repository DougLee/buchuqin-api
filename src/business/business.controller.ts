import {
  Body,
  Controller,
  Get,
  Param,
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
  CreateAfterSalesDto,
  CreateOrderDto,
  UpdateCartDto,
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
  @Get('coupons') coupons() {
    return ok(this.store.coupons);
  }
  @Get('delivery/slots') slots() {
    return ok(this.store.deliverySlots);
  }
  @Post('orders/:id/after-sales') afterSale(
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
  @Get('refunds') refunds(@Req() req: AuthRequest) {
    return ok(this.service.refunds(req.user.id));
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
}
