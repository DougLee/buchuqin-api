import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { AdminService } from './admin.service';
import {
  BarcodeDto,
  CreateBuildingDto,
  CreateCouponDto,
  CreateProductDto,
  CreateRoomDto,
  CreateStaffDto,
  IssueCouponDto,
  UpdateBuildingDto,
  UpdateCouponDto,
  UpdateStaffDto,
} from './dto';

@ApiTags('PC 管理后台 MVP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}
  private authorize(req: AuthRequest) {
    if (
      !['admin', 'operations', 'warehouse', 'finance'].includes(req.user.role)
    )
      throw new ForbiddenException('无后台访问权限');
  }
  @Get('dashboard') async dashboard(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.dashboard());
  }
  @Get('products') async products(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.products());
  }
  @Post('products/barcode/lookup') async lookupBarcode(
    @Req() req: AuthRequest,
    @Body() body: BarcodeDto,
  ) {
    this.authorize(req);
    return ok(await this.service.lookupBarcode(body.barcode));
  }
  @Post('products') async createProduct(
    @Req() req: AuthRequest,
    @Body() body: CreateProductDto,
  ) {
    this.authorize(req);
    return ok(
      await this.service.createProduct(body, req.user.id),
      '商品已创建',
    );
  }
  @Patch('products/:id') async updateProduct(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { price?: number; stock?: number },
  ) {
    this.authorize(req);
    return ok(await this.service.updateProduct(id, body, req.user.id));
  }
  @Get('inventory') async inventory(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.inventory());
  }
  @Get('orders') async orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
  ) {
    this.authorize(req);
    return ok(await this.service.orders(status));
  }
  @Get('orders/:id') async order(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req);
    return ok(await this.service.order(id));
  }
  @Post('orders/:id/actions/:action') async orderAction(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    this.authorize(req);
    return ok(await this.service.orderAction(id, action, req.user.id));
  }
  @Get('staff') async staff(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.staff());
  }
  @Post('staff') async createStaff(
    @Req() req: AuthRequest,
    @Body() body: CreateStaffDto,
  ) {
    this.authorize(req);
    return ok(await this.service.createStaff(body, req.user.id), '员工已创建');
  }
  @Patch('staff/:id') async updateStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateStaffDto,
  ) {
    this.authorize(req);
    return ok(await this.service.updateStaff(id, body, req.user.id));
  }
  @Delete('staff/:id') async deleteStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req);
    return ok(await this.service.deleteStaff(id, req.user.id), '员工已删除');
  }
  @Get('buildings') async buildings(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.buildings());
  }
  @Post('buildings') async createBuilding(
    @Req() req: AuthRequest,
    @Body() body: CreateBuildingDto,
  ) {
    this.authorize(req);
    return ok(
      await this.service.createBuilding(body, req.user.id),
      '楼栋已创建',
    );
  }
  @Patch('buildings/:id') async updateBuilding(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateBuildingDto,
  ) {
    this.authorize(req);
    return ok(await this.service.updateBuilding(id, body, req.user.id));
  }
  @Delete('buildings/:id') async deleteBuilding(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req);
    return ok(await this.service.deleteBuilding(id, req.user.id), '楼栋已删除');
  }
  @Get('buildings/:id/rooms') async rooms(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req);
    return ok(await this.service.rooms(id));
  }
  @Post('buildings/:id/rooms') async createRoom(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: CreateRoomDto,
  ) {
    this.authorize(req);
    return ok(await this.service.createRoom(id, body, req.user.id), '寝室已创建');
  }
  @Delete('buildings/:id/rooms/:roomId') async deleteRoom(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
  ) {
    this.authorize(req);
    return ok(
      await this.service.deleteRoom(id, roomId, req.user.id),
      '寝室已删除',
    );
  }
  @Get('after-sales') async afterSales(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.afterSales());
  }
  @Post('after-sales/:id/review') async review(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { approved: boolean },
  ) {
    this.authorize(req);
    return ok(
      await this.service.reviewAfterSale(id, body.approved, req.user.id),
    );
  }
  @Get('settlements') async settlements(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.settlements());
  }
  @Get('campuses') async campuses(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.campuses());
  }
  @Get('coupons') async coupons(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.coupons());
  }
  @Get('users') async users(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.users());
  }
  @Post('coupons') async createCoupon(
    @Req() req: AuthRequest,
    @Body() body: CreateCouponDto,
  ) {
    this.authorize(req);
    return ok(
      await this.service.createCoupon(body, req.user.id),
      '优惠券已创建',
    );
  }
  @Patch('coupons/:id') async updateCoupon(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCouponDto,
  ) {
    this.authorize(req);
    return ok(await this.service.updateCoupon(id, body, req.user.id));
  }
  @Post('coupons/:id/issue') async issueCoupon(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: IssueCouponDto,
  ) {
    this.authorize(req);
    return ok(await this.service.issueCoupon(id, body, req.user.id), '发放完成');
  }
  @Get('audit-logs') async audits(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(await this.service.auditLogs());
  }
}
