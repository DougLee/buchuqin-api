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
import { CreateAddressDto, CreateOrderDto, UpdateCartDto } from './dto';
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
  ) {
    return ok(this.service.listProducts(category, keyword));
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
  @ApiOperation({ summary: '创建 Mock 订单并模拟支付成功' })
  createOrder(@Req() req: AuthRequest, @Body() dto: CreateOrderDto) {
    return ok(this.service.createOrder(req.user.id, dto), '下单成功');
  }
  @Get('orders') orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
  ) {
    return ok(this.service.orders(req.user.id, status));
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
  @Get('addresses') addresses() {
    return ok(this.store.addresses);
  }
  @Post('addresses') addAddress(@Body() dto: CreateAddressDto) {
    return ok(this.service.addAddress(dto), '地址已保存');
  }
  @Get('coupons') coupons() {
    return ok(this.store.coupons);
  }
  @Get('delivery/slots') slots() {
    return ok([
      { id: '17', label: '17:00-18:00', available: true },
      { id: '20', label: '20:00-21:00', available: true },
      { id: '21', label: '21:00-22:00', available: false },
    ]);
  }
}
