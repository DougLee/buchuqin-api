import {
  Body,
  Controller,
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
import { ok, type ApiResponse } from '../common/api-response';
import { NightRiderService } from './night-rider.service';
import { NightInventoryService } from './night-inventory.service';
import {
  NightShelfDto,
  NightStockOrderDto,
  NightDeliverDto,
  NightDepositPayDto,
  NightReceiveDto,
  NightReasonDto,
  NightReportDto,
} from './night.dto';

/**
 * 楼长端夜宵接口（IKSW1F）：/night-rider/night/*。
 * 走履约端 Staff JWT 鉴权（复刻 fulfillment 控制器模式）——楼长角色
 * （building-manager/实习楼长）；数据边界=本人绑定夜宵店。
 */
@ApiTags('楼长端-夜宵店')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('night-rider')
export class NightRiderController {
  constructor(
    private readonly service: NightRiderService,
    private readonly inventory: NightInventoryService,
  ) {}

  private auth(req: AuthRequest): string {
    if (
      !['building-manager', 'intern-building-manager'].includes(req.user.role)
    )
      throw new ForbiddenException('仅楼长可访问夜宵店功能');
    return req.user.id;
  }

  /* ---------- 押金 ---------- */

  @Get('night/deposit/tiers')
  @ApiOperation({ summary: '押金档位（当前余额/下一档/差额）' })
  async depositTiers(@Req() r: AuthRequest) {
    return ok(await this.service.depositTiers(this.auth(r)));
  }

  @Get('night/deposit')
  @ApiOperation({ summary: '押金详情（余额+流水）' })
  async depositDetail(@Req() r: AuthRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return ok(await this.service.depositDetail(this.auth(r), page, pageSize));
  }

  @Post('night/deposit/pay')
  @ApiOperation({ summary: '发起押金缴纳（微信支付，500 档递增补缴）' })
  async depositPay(@Req() r: AuthRequest, @Body() d: NightDepositPayDto) {
    return ok(
      await this.service.initiateDepositPay(this.auth(r), d.targetTier),
    );
  }

  @Get('night/deposit/pay-status')
  @ApiOperation({ summary: '押金支付结果查询（回调故障兜底）' })
  async depositPayStatus(
    @Req() r: AuthRequest,
    @Query('outTradeNo') outTradeNo?: string,
  ) {
    return ok(await this.service.depositPayStatus(this.auth(r), outTradeNo));
  }

  /* ---------- 备货 ---------- */

  @Get('night/stock/pool')
  @ApiOperation({ summary: '商品池（夜主档+本店库存/售价）' })
  async stockPool(@Req() r: AuthRequest) {
    return ok(await this.service.stockPool(this.auth(r)));
  }

  @Post('night/stock/orders')
  @ApiOperation({ summary: '提交备货申请，预占额度，待校区审核出库' })
  async createStockOrder(@Req() r: AuthRequest, @Body() d: NightStockOrderDto) {
    return ok(
      await this.service.createStockOrder(this.auth(r), d),
      '申请已提交，等待校区审核',
    );
  }

  @Get('night/stock/orders')
  @ApiOperation({ summary: '备货记录列表' })
  async stockOrders(
    @Req() r: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return ok(
      await this.service.stockOrdersPage(this.auth(r), status, page, pageSize),
    );
  }

  /* ---------- 工作台与营业管理 ---------- */

  @Post('night/stock/orders/:id/cancel')
  async cancelStock(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightReasonDto,
  ) {
    return ok(
      await this.inventory.cancelStockOrder(
        id,
        { staffId: this.auth(r) },
        body.reason,
      ),
    );
  }

  @Post('night/stock/orders/:id/receive')
  async receiveStock(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightReceiveDto,
  ) {
    return ok(
      await this.inventory.receiveStockOrder(this.auth(r), id, body.items),
      '实收库存已入账',
    );
  }

  @Get('night/inventory/reports')
  async inventoryReports(@Req() r: AuthRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const staffId = this.auth(r),
      store = await this.inventory.myStore(staffId);
    return ok(await this.inventory.reportsPage(store.id, staffId, page, pageSize));
  }

  @Post('night/inventory/reports')
  async submitInventoryReport(
    @Req() r: AuthRequest,
    @Body() body: NightReportDto,
  ) {
    return ok(
      await this.inventory.createReport(this.auth(r), body),
      '已提交校区审核',
    );
  }

  @Post('night/inventory/reports/:id/resubmit')
  async resubmitInventoryReport(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightReasonDto,
  ) {
    return ok(
      await this.inventory.resubmitShortage(
        this.auth(r),
        id,
        body.reason,
        body.photos,
      ),
    );
  }

  @Get('night/inventory/txns')
  async inventoryTransactions(
    @Req() r: AuthRequest,
    @Query('productId') productId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const store = await this.inventory.myStore(this.auth(r));
    return ok(await this.inventory.transactionsPage(store.id, productId, page, pageSize));
  }

  @Get('night/dashboard')
  @ApiOperation({ summary: '夜宵工作台（场次/押金/待接单/销售额/佣金两列）' })
  async dashboard(@Req() r: AuthRequest): Promise<ApiResponse<unknown>> {
    return ok(await this.service.dashboard(this.auth(r)));
  }

  @Post('night/store/open')
  @ApiOperation({
    summary: '开店（互斥/押金/可售商品校验，不满足返回具体原因）',
  })
  async open(@Req() r: AuthRequest) {
    return ok(await this.service.openStore(this.auth(r)), '开店成功');
  }

  @Post('night/store/pause')
  @ApiOperation({ summary: '暂停营业' })
  async pause(@Req() r: AuthRequest) {
    return ok(await this.service.pauseStore(this.auth(r)), '已暂停');
  }

  @Post('night/store/resume')
  @ApiOperation({ summary: '恢复营业' })
  async resume(@Req() r: AuthRequest) {
    return ok(await this.service.resumeStore(this.auth(r)), '已恢复营业');
  }

  @Post('night/store/close')
  @ApiOperation({ summary: '打烊（停止新单，已付订单继续履约）' })
  async close(@Req() r: AuthRequest) {
    return ok(await this.service.closeStore(this.auth(r)), '已打烊');
  }

  /* ---------- 商品 ---------- */

  @Get('night/products')
  @ApiOperation({ summary: '本店商品列表（含库存/上下架/可售状态）' })
  async products(@Req() r: AuthRequest) {
    return ok(await this.service.myProducts(this.auth(r)));
  }

  @Patch('night/products/:id/shelf')
  @ApiOperation({ summary: '上架/下架切换（恢复上架校验后台停售）' })
  async toggleShelf(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() d: NightShelfDto,
  ) {
    return ok(
      await this.service.toggleShelf(this.auth(r), id, d.onShelf),
      '已更新',
    );
  }

  /* ---------- 订单 ---------- */

  @Get('night/orders')
  @ApiOperation({ summary: '夜宵订单列表（本店，?status 过滤，todo=待办）' })
  async orders(
    @Req() r: AuthRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return ok(
      await this.service.storeOrdersPage(this.auth(r), status, page, pageSize),
    );
  }

  @Get('night/orders/:id')
  @ApiOperation({ summary: '本店订单详情' })
  async orderDetail(@Req() r: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.storeOrderDetail(this.auth(r), id));
  }

  @Post('night/orders/:id/accept')
  @ApiOperation({
    summary: '接单（pending-accept → delivering，校验本人店铺）',
  })
  async accept(@Req() r: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.accept(this.auth(r), id), '已接单');
  }

  @Post('night/orders/:id/deliver')
  @ApiOperation({ summary: '上传凭证并送达完成（delivering → completed）' })
  async deliver(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() d: NightDeliverDto,
  ) {
    return ok(await this.service.deliver(this.auth(r), id, d), '已送达完成');
  }

  /* ---------- 收入 ---------- */

  @Get('night/income')
  @ApiOperation({ summary: '收入（佣金/配送费两列流水+汇总+押金余额）' })
  async income(@Req() r: AuthRequest, @Query('month') month?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return ok(await this.service.income(this.auth(r), { month, status, page, pageSize }));
  }

  @Get('night/orders/:id/earning')
  @ApiOperation({ summary: '单单佣金明细（券扣减/基数/比例/佣金/配送费）' })
  async orderEarning(@Req() r: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.orderEarning(this.auth(r), id));
  }
}
