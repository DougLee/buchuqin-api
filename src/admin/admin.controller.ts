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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { filterByKeyword, paginate } from '../common/pagination';
import { AdminService } from './admin.service';
import { canAdmin, type AdminAccess, type AdminSection } from './permissions';
import {
  AdjustStockDto,
  BarcodeDto,
  CreateAccountDto,
  CreateBuildingDto,
  CreateCommissionRuleDto,
  CreateCouponDto,
  CreateDispatchInvitationDto,
  CreateProductDto,
  CreateRoomDto,
  CreateStaffDto,
  IssueCouponDto,
  StockInDto,
  UpdateAccountDto,
  UpdateBuildingDto,
  UpdateCommissionRuleDto,
  UpdateCouponDto,
  UpdateStaffDto,
} from './dto';

@ApiTags('PC 管理后台 MVP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}
  /**
   * RBAC（IK9JHR）：按 ADR-0004 签字矩阵校验 角色×板块×读写，
   * 矩阵定义在 ./permissions.ts，改权限只改那张表。
   */
  private authorize(
    req: AuthRequest,
    section: AdminSection,
    access: AdminAccess = 'read',
  ) {
    if (!canAdmin(req.user.role, section, access))
      throw new ForbiddenException('当前角色无权访问该板块');
  }
  @Get('dashboard')
  @ApiOperation({
    summary: '运营看板（PRD §8.4 口径）',
    description:
      'KPI 口径（返回体含 caliber 字段逐一说明）：今日订单=createdAt>=今日0点的有效单（排除待支付/已取消）；' +
      '今日支付金额=paidAt 为今日的有效单（退款额单独统计）；新用户=createdAt>=今日0点；' +
      '准时率=送达时间与支付时间同日（当日达口径，estimatedArrival 为展示文案不可机读）；' +
      '履约超时=支付后超 90 分钟未送达；waitingHandover/lastMile 按 timeline 最后节点是否完成区分。',
  })
  async dashboard(@Req() req: AuthRequest) {
    this.authorize(req, 'dashboard');
    return ok(await this.service.dashboard(req.user.campusId));
  }
  @Get('products')
  @ApiOperation({ summary: '商品列表（?page&pageSize 统一分页包裹）' })
  async products(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'products');
    return ok(
      paginate(await this.service.products(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('products/barcode/lookup') async lookupBarcode(
    @Req() req: AuthRequest,
    @Body() body: BarcodeDto,
  ) {
    this.authorize(req, 'products');
    return ok(
      await this.service.lookupBarcode(body.barcode, req.user.campusId),
    );
  }
  @Post('products') async createProduct(
    @Req() req: AuthRequest,
    @Body() body: CreateProductDto,
  ) {
    this.authorize(req, 'products', 'write');
    return ok(
      await this.service.createProduct(body, req.user.id, req.user.campusId),
      '商品已创建',
    );
  }
  @Patch('products/:id') async updateProduct(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { price?: number; stock?: number },
  ) {
    this.authorize(req, 'products', 'write');
    return ok(
      await this.service.updateProduct(
        id,
        body,
        req.user.id,
        req.user.campusId,
      ),
    );
  }
  @Get('inventory')
  @ApiOperation({ summary: '库存列表（?page&pageSize 统一分页包裹）' })
  async inventory(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'inventory');
    return ok(
      paginate(await this.service.inventory(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('inventory/stock-in') async stockIn(
    @Req() req: AuthRequest,
    @Body() body: StockInDto,
  ) {
    this.authorize(req, 'inventory', 'write');
    return ok(
      await this.service.stockIn(body, req.user.id, req.user.campusId),
      '入库完成',
    );
  }
  @Post('inventory/adjust') async adjustStock(
    @Req() req: AuthRequest,
    @Body() body: AdjustStockDto,
  ) {
    this.authorize(req, 'inventory', 'write');
    return ok(
      await this.service.adjustStock(body, req.user.id, req.user.campusId),
      '库存已调整',
    );
  }
  @Get('inventory/txns')
  @ApiOperation({ summary: '出入库流水（?page&pageSize 统一分页包裹）' })
  async inventoryTxns(
    @Req() req: AuthRequest,
    @Query('productId') productId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'inventory');
    return ok(
      paginate(
        await this.service.inventoryTxns(productId, req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Get('orders')
  @ApiOperation({
    summary: '订单列表（?status 过滤保留；?page&pageSize 统一分页包裹）',
  })
  async orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'orders');
    return ok(
      paginate(
        await this.service.orders(status, req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Get('orders/:id') async order(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'orders');
    return ok(await this.service.order(id, req.user.campusId));
  }
  @Post('orders/:id/actions/:action') async orderAction(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    this.authorize(req, 'orders', 'write');
    return ok(
      await this.service.orderAction(
        id,
        action,
        req.user.id,
        req.user.campusId,
      ),
    );
  }
  @Get('staff')
  @ApiOperation({ summary: '员工列表（?page&pageSize 统一分页包裹）' })
  async staff(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'staff');
    return ok(
      paginate(await this.service.staff(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Get('leave-requests')
  @ApiOperation({ summary: '请假列表（?page&pageSize 统一分页包裹）' })
  async leaveRequests(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'staff');
    return ok(
      paginate(
        await this.service.leaveRequests(req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Get('dispatch-invitations')
  @ApiOperation({ summary: '调配邀请列表（?page&pageSize 统一分页包裹）' })
  async dispatchInvitations(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'staff');
    return ok(
      paginate(
        await this.service.dispatchInvitations(req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('dispatch-invitations') async createDispatchInvitation(
    @Req() req: AuthRequest,
    @Body() body: CreateDispatchInvitationDto,
  ) {
    this.authorize(req, 'staff', 'write');
    return ok(
      await this.service.createDispatchInvitation(
        body,
        req.user.id,
        req.user.campusId,
      ),
      '调配邀请已发出',
    );
  }
  @Post('dispatch-invitations/:id/cancel') async cancelDispatchInvitation(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'staff', 'write');
    return ok(
      await this.service.cancelDispatchInvitation(
        id,
        req.user.id,
        req.user.campusId,
      ),
      '调配邀请已取消',
    );
  }
  @Post('staff') async createStaff(
    @Req() req: AuthRequest,
    @Body() body: CreateStaffDto,
  ) {
    this.authorize(req, 'staff', 'write');
    return ok(
      await this.service.createStaff(body, req.user.id, req.user.campusId),
      '员工已创建',
    );
  }
  @Patch('staff/:id') async updateStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateStaffDto,
  ) {
    this.authorize(req, 'staff', 'write');
    return ok(
      await this.service.updateStaff(id, body, req.user.id, req.user.campusId),
    );
  }
  @Delete('staff/:id') async deleteStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'staff', 'write');
    return ok(
      await this.service.deleteStaff(id, req.user.id, req.user.campusId),
      '员工已删除',
    );
  }
  @Get('buildings')
  @ApiOperation({ summary: '楼栋列表（?page&pageSize 统一分页包裹）' })
  async buildings(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'campuses');
    return ok(
      paginate(await this.service.buildings(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('buildings') async createBuilding(
    @Req() req: AuthRequest,
    @Body() body: CreateBuildingDto,
  ) {
    this.authorize(req, 'campuses', 'write');
    return ok(
      await this.service.createBuilding(body, req.user.id, req.user.campusId),
      '楼栋已创建',
    );
  }
  @Patch('buildings/:id') async updateBuilding(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateBuildingDto,
  ) {
    this.authorize(req, 'campuses', 'write');
    return ok(
      await this.service.updateBuilding(
        id,
        body,
        req.user.id,
        req.user.campusId,
      ),
    );
  }
  @Delete('buildings/:id') async deleteBuilding(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'campuses', 'write');
    return ok(
      await this.service.deleteBuilding(id, req.user.id, req.user.campusId),
      '楼栋已删除',
    );
  }
  @Get('buildings/:id/rooms')
  @ApiOperation({ summary: '楼栋寝室列表（?page&pageSize 统一分页包裹）' })
  async rooms(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'campuses');
    return ok(
      paginate(await this.service.rooms(id, req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('buildings/:id/rooms') async createRoom(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: CreateRoomDto,
  ) {
    this.authorize(req, 'campuses', 'write');
    return ok(
      await this.service.createRoom(id, body, req.user.id, req.user.campusId),
      '寝室已创建',
    );
  }
  @Delete('buildings/:id/rooms/:roomId') async deleteRoom(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
  ) {
    this.authorize(req, 'campuses', 'write');
    return ok(
      await this.service.deleteRoom(id, roomId, req.user.id, req.user.campusId),
      '寝室已删除',
    );
  }
  @Get('after-sales')
  @ApiOperation({ summary: '售后列表（?page&pageSize 统一分页包裹）' })
  async afterSales(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'after-sales');
    return ok(
      paginate(
        await this.service.afterSales(req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Get('commission-rules')
  @ApiOperation({ summary: '提成规则列表（?page&pageSize 统一分页包裹）' })
  async commissionRules(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'finance');
    return ok(
      paginate(
        await this.service.commissionRules(req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('commission-rules') async createCommissionRule(
    @Req() req: AuthRequest,
    @Body() body: CreateCommissionRuleDto,
  ) {
    this.authorize(req, 'finance', 'write');
    return ok(
      await this.service.createCommissionRule(
        body,
        req.user.id,
        req.user.campusId,
      ),
      '提成规则已创建',
    );
  }
  @Patch('commission-rules/:id') async updateCommissionRule(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCommissionRuleDto,
  ) {
    this.authorize(req, 'finance', 'write');
    return ok(
      await this.service.updateCommissionRule(
        id,
        body,
        req.user.id,
        req.user.campusId,
      ),
      '提成规则已更新',
    );
  }
  @Get('settlements')
  @ApiOperation({
    summary: '月度结算账单（?month 过滤保留；?page&pageSize 统一分页包裹）',
  })
  async settlements(
    @Req() req: AuthRequest,
    @Query('month') month?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'finance');
    return ok(
      paginate(
        await this.service.settlements(req.user.campusId, month),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('settlements/:id/confirm') async confirmSettlement(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'finance', 'write');
    return ok(
      await this.service.confirmSettlement(id, req.user.id, req.user.campusId),
      '账单已确认',
    );
  }
  @Post('settlements/:id/pay') async paySettlement(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'finance', 'write');
    return ok(
      await this.service.paySettlement(id, req.user.id, req.user.campusId),
      '账单已支付',
    );
  }
  @Get('campuses') async campuses(@Req() req: AuthRequest) {
    this.authorize(req, 'dashboard');
    return ok(filterByKeyword(await this.service.campuses(), keyword));
  }
  @Get('coupons')
  @ApiOperation({ summary: '优惠券列表（?page&pageSize 统一分页包裹）' })
  async coupons(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'marketing');
    return ok(
      paginate(await this.service.coupons(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Get('users')
  @ApiOperation({ summary: '用户列表（?page&pageSize 统一分页包裹）' })
  async users(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'marketing');
    return ok(
      paginate(await this.service.users(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('coupons') async createCoupon(
    @Req() req: AuthRequest,
    @Body() body: CreateCouponDto,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.createCoupon(body, req.user.id, req.user.campusId),
      '优惠券已创建',
    );
  }
  @Patch('coupons/:id') async updateCoupon(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCouponDto,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.updateCoupon(id, body, req.user.id, req.user.campusId),
    );
  }
  @Post('coupons/:id/issue') async issueCoupon(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: IssueCouponDto,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.issueCoupon(id, body, req.user.id, req.user.campusId),
      '发放完成',
    );
  }
  @Get('audit-logs')
  @ApiOperation({ summary: '审计日志（?page&pageSize 统一分页包裹）' })
  async audits(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'audit');
    return ok(
      paginate(await this.service.auditLogs(req.user.campusId), page, pageSize, keyword),
    );
  }
  /* ---------- 后台账号管理（IK9KWO）：accounts 板块仅 admin ---------- */
  @Get('accounts')
  @ApiOperation({ summary: '后台账号列表（不含密码散列，统一分页包裹）' })
  async accounts(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'accounts');
    return ok(paginate(await this.service.accounts(), page, pageSize, keyword));
  }
  @Post('accounts')
  @ApiOperation({ summary: '新建后台账号（用户名唯一，密码 ≥8 位）' })
  async createAccount(@Req() req: AuthRequest, @Body() body: CreateAccountDto) {
    this.authorize(req, 'accounts', 'write');
    return ok(
      await this.service.createAccount(body, req.user.id, req.user.campusId),
      '账号已创建',
    );
  }
  @Patch('accounts/:id')
  @ApiOperation({ summary: '改昵称/角色或重置密码；最后一个 admin 不可降级' })
  async updateAccount(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAccountDto,
  ) {
    this.authorize(req, 'accounts', 'write');
    return ok(
      await this.service.updateAccount(id, body, req.user.id, req.user.campusId),
    );
  }
  @Delete('accounts/:id')
  @ApiOperation({ summary: '删除后台账号；不可删自己/最后一个 admin' })
  async deleteAccount(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'accounts', 'write');
    return ok(
      await this.service.deleteAccount(id, req.user.id, req.user.campusId),
      '账号已删除',
    );
  }
}
