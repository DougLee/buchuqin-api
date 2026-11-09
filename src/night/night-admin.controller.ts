import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { AdminAuthGuard } from '../admin/rbac/admin-auth.guard';
import { RbacService, type RbacContext } from '../admin/rbac/rbac.service';
import { ok } from '../common/api-response';
import { paginate } from '../common/pagination';
import { NightAdminService } from './night-admin.service';
import { NightInventoryService } from './night-inventory.service';
import {
  NightCatalogCreateDto,
  NightCatalogUpdateDto,
  NightConfigDto,
  NightDepositDeductDto,
  NightDepositRefundDto,
  NightProductUpdateDto,
  NightRefundDto,
  NightSettleDto,
  NightStockAdjustDto,
  NightStoreCreateDto,
  NightStoreProductAttachDto,
  NightStoreUpdateDto,
  NightCatalogImportDto,
  NightReviewDto,
  NightReasonDto,
} from './night.dto';

/**
 * 后台夜宵接口（IKSW1F）：/admin/night/*。
 * 鉴权与现有 admin 控制器同链路（AdminAuthGuard URL 判权，超管通配；
 * 非 super 账号需在「角色管理-菜单」登记对应 perms 模式后授权）。
 * campusScope 语义复刻 AdminController 私有方法（平台聚焦/校区锁定）。
 */
@ApiTags('后台-夜宵店')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/night')
export class NightAdminController {
  constructor(
    private readonly service: NightAdminService,
    private readonly rbac: RbacService,
    private readonly inventory: NightInventoryService,
  ) {}

  /** 本请求 RBAC 上下文（守卫已装载） */
  private ctx(req: AuthRequest): RbacContext {
    const ctx = (req as { rbac?: RbacContext }).rbac;
    if (!ctx) throw new ForbiddenException('未授权的访问');
    return ctx;
  }

  /** campusScope（复刻 AdminController 同名私有方法语义）。 */
  private async campusScope(
    req: AuthRequest,
    campus?: string,
  ): Promise<string> {
    const ctx = this.ctx(req);
    const c =
      (campus ?? (req.query?.campus as string | undefined))?.trim() ?? '';
    if (ctx.orgLevel === 'org' && ctx.organizationId)
      return this.rbac.resolveCampusInScope(ctx, c);
    if (ctx.platform) {
      if (c && !(await this.rbac.knownCampusIds()).has(c))
        throw new BadRequestException('目标校区不存在');
      return c;
    }
    if (c && c !== ctx.campusId) {
      if (!ctx.campuses.includes(c))
        throw new ForbiddenException('未授权在该校区操作');
      return c;
    }
    return ctx.campusId;
  }

  /* ---------- 店铺管理 ---------- */

  @Post('stores')
  @ApiOperation({ summary: '建店（校区+楼栋+佣金比例+绑定楼长）' })
  async createStore(
    @Req() req: AuthRequest,
    @Body() body: NightStoreCreateDto,
  ) {
    if (!body.campusId) body.campusId = await this.campusScope(req);
    else await this.campusScope(req, body.campusId);
    return ok(
      await this.service.createStore(req.user.id, body),
      '夜宵店已创建',
    );
  }

  @Patch('stores/:id')
  @ApiOperation({ summary: '编辑店铺（停业/换楼长/调佣金比例）' })
  async updateStore(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightStoreUpdateDto,
  ) {
    await this.guardStoreCampus(req, id);
    return ok(await this.service.updateStore(req.user.id, id, body), '已更新');
  }

  @Get('stores')
  @ApiOperation({ summary: '店铺列表（含今日订单/销售额/押金/营业状态）' })
  async stores(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const rows = await this.service.stores(
      await this.campusScope(req, campus),
      status,
    );
    return ok(paginate(rows, page, pageSize));
  }

  @Get('stores/:id')
  @ApiOperation({ summary: '店铺详情（商品+押金流水+佣金汇总）' })
  async storeDetail(@Req() req: AuthRequest, @Param('id') id: string) {
    await this.guardStoreCampus(req, id);
    return ok(await this.service.storeDetail(id));
  }

  /* ---------- 夜主档 ---------- */

  @Post('catalog')
  @ApiOperation({ summary: '创建夜主档商品（Product nightCatalog 行）' })
  async createCatalog(
    @Req() req: AuthRequest,
    @Body() body: NightCatalogCreateDto,
  ) {
    if (!body.campusId) body.campusId = await this.campusScope(req);
    else await this.campusScope(req, body.campusId);
    return ok(
      await this.service.createCatalogProduct(req.user.id, body),
      '夜主档商品已创建',
    );
  }

  @Patch('catalog/:id')
  @ApiOperation({ summary: '编辑夜主档（名称/夜宵售价/上下架）' })
  async updateCatalog(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightCatalogUpdateDto,
  ) {
    await this.guardCatalogCampus(req, id);
    return ok(
      await this.service.updateCatalogProduct(req.user.id, id, body),
      '已更新',
    );
  }

  @Get('catalog')
  @ApiOperation({ summary: '夜主档列表（?keyword 过滤）' })
  async catalog(
    @Req() req: AuthRequest,
    @Query('keyword') keyword?: string,
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('stock') stock?: string,
    @Query('source') source?: string,
  ) {
    const campusId = await this.campusScope(req, campus);
    const rows = await this.inventory.catalog(campusId, keyword, {
      status,
      categoryId,
      stock,
      source,
    });
    return ok({
      ...paginate(rows, page, pageSize),
      categories: await this.inventory.catalogCategories(campusId),
    });
  }

  /* ---------- 楼栋商品 ---------- */

  @Get('store-products')
  async storeProducts(
    @Req() req: AuthRequest,
    @Query('storeId') storeId?: string,
    @Query('keyword') keyword?: string,
    @Query('saleAllowed') saleAllowed?: string,
    @Query('onShelf') onShelf?: string,
    @Query('stock') stock?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (storeId) await this.guardStoreCampus(req, storeId);
    return ok(
      paginate(
        await this.inventory.campusProducts(await this.campusScope(req), {
          storeId,
          keyword,
          saleAllowed,
          onShelf,
          stock,
          categoryId,
        }),
        page,
        pageSize,
      ),
    );
  }

  @Get('catalog/candidates')
  @ApiOperation({
    summary:
      '夜宵导入候选（IKTVVJ：官方库全部可售行，含历史行；排除组织行与本校区夜主档已导入）',
  })
  async catalogCandidates(
    @Req() req: AuthRequest,
    @Query('keyword') keyword?: string,
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const campusId = await this.campusScope(req, campus);
    return ok(
      paginate(
        await this.inventory.catalogCandidates(keyword, campusId),
        page,
        pageSize,
      ),
    );
  }

  @Post('catalog/import')
  async importCatalog(
    @Req() req: AuthRequest,
    @Body() body: NightCatalogImportDto,
  ) {
    const campusId = await this.campusScope(req, body.campusId);
    return ok(
      await this.inventory.importCatalog(
        req.user.id,
        campusId,
        body.productIds,
      ),
    );
  }

  @Get('stock-orders')
  async stockOrders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('storeId') storeId?: string,
    @Query('keyword') keyword?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (storeId) await this.guardStoreCampus(req, storeId);
    return ok(
      await this.inventory.campusStockOrders(
        await this.campusScope(req),
        status,
        storeId,
        { keyword, from, to },
      ),
    );
  }

  private async guardStockOrder(req: AuthRequest, id: string) {
    await this.guardStoreCampus(req, await this.inventory.stockOrderStore(id));
  }

  @Post('stock-orders/:id/review')
  async reviewStockOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightReviewDto,
  ) {
    await this.guardStockOrder(req, id);
    return ok(
      await this.inventory.reviewStockOrder(
        req.user.id,
        id,
        body.approved,
        body.reason,
      ),
    );
  }

  @Post('stock-orders/:id/ship')
  async shipStockOrder(@Req() req: AuthRequest, @Param('id') id: string) {
    await this.guardStockOrder(req, id);
    return ok(await this.inventory.shipStockOrder(req.user.id, id));
  }

  @Post('stock-orders/:id/cancel')
  async cancelStockOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightReasonDto,
  ) {
    await this.guardStockOrder(req, id);
    return ok(
      await this.inventory.cancelStockOrder(
        id,
        { operatorId: req.user.id },
        body.reason,
      ),
    );
  }

  @Get('inventory-reports')
  async inventoryReports(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('storeId') storeId?: string,
    @Query('keyword') keyword?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
  ) {
    if (storeId) await this.guardStoreCampus(req, storeId);
    return ok(
      await this.inventory.campusReports(
        await this.campusScope(req),
        status,
        storeId,
        { keyword, from, to, kind },
      ),
    );
  }

  @Post('inventory-reports/:id/review')
  async reviewInventoryReport(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightReviewDto,
  ) {
    await this.guardStoreCampus(req, await this.inventory.reportStore(id));
    return ok(
      await this.inventory.reviewReport(
        req.user.id,
        id,
        body.approved,
        body.reason,
      ),
    );
  }

  @Post('stores/:id/products')
  @ApiOperation({ summary: '给店铺配商品（夜主档勾选生成楼栋行）' })
  async attachProducts(
    @Req() req: AuthRequest,
    @Param('id') storeId: string,
    @Body() body: NightStoreProductAttachDto,
  ) {
    await this.guardStoreCampus(req, storeId);
    return ok(
      await this.service.attachStoreProducts(req.user.id, storeId, body),
      '商品已配置',
    );
  }

  @Patch('stores/:id/products/:productId')
  @ApiOperation({ summary: '楼栋商品管理（强制上下架 saleAllowed）' })
  async updateStoreProduct(
    @Req() req: AuthRequest,
    @Param('id') storeId: string,
    @Param('productId') productId: string,
    @Body() body: NightProductUpdateDto,
  ) {
    await this.guardStoreCampus(req, storeId);
    return ok(
      await this.service.updateStoreProduct(
        req.user.id,
        storeId,
        productId,
        body,
      ),
      '已更新',
    );
  }

  @Post('stores/:id/products/:productId/stock')
  @ApiOperation({ summary: '库存调整（delta+type+原因，一步生效写流水）' })
  async adjustStock(
    @Req() req: AuthRequest,
    @Param('id') storeId: string,
    @Param('productId') productId: string,
    @Body() body: NightStockAdjustDto,
  ) {
    await this.guardStoreCampus(req, storeId);
    return ok(
      await this.service.adjustStock(req.user.id, storeId, productId, body),
      '库存已调整',
    );
  }

  @Get('stores/:id/stock-txns')
  @ApiOperation({ summary: '库存流水（对账）' })
  async stockTxns(
    @Req() req: AuthRequest,
    @Param('id') storeId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.guardStoreCampus(req, storeId);
    return ok(await this.service.stockTxnsPage(storeId, page, pageSize));
  }

  /* ---------- 校区配置 ---------- */

  @Get('config')
  @ApiOperation({ summary: '校区夜宵配置读取' })
  async getConfig(@Req() req: AuthRequest, @Query('campus') campus?: string) {
    return ok(
      await this.service.getConfig(await this.campusScope(req, campus)),
    );
  }

  @Put('config')
  @ApiOperation({ summary: '校区夜宵配置写入（互斥缓冲校验+强警告二次确认）' })
  async saveConfig(@Req() req: AuthRequest, @Body() body: NightConfigDto) {
    if (!body.campusId) body.campusId = await this.campusScope(req);
    else await this.campusScope(req, body.campusId);
    return ok(await this.service.saveConfig(req.user.id, body), '配置已保存');
  }

  /* ---------- 订单 ---------- */

  @Get('orders')
  @ApiOperation({ summary: '夜宵订单列表（筛选店铺/状态/营业日）' })
  async ordersReq(
    @Req() req: AuthRequest,
    @Query('storeId') storeId?: string,
    @Query('status') status?: string,
    @Query('date') date?: string,
    @Query('keyword') keyword?: string,
    @Query('afterSaleStatus') afterSaleStatus?: string,
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const campusId = await this.campusScope(req, campus);
    if (storeId) await this.guardStoreCampus(req, storeId);
    return ok(await this.service.adminOrdersPage(campusId, {
      storeId,
      status,
      date,
      keyword,
      afterSaleStatus,
    }, page, pageSize));
  }

  @Get('orders/:id')
  @ApiOperation({ summary: '夜宵订单详情（含佣金流水）' })
  async orderDetail(@Req() req: AuthRequest, @Param('id') id: string) {
    const detail = await this.service.adminOrderDetail(id);
    await this.guardStoreCampus(req, detail.store!.id);
    return ok(detail);
  }

  @Post('orders/:id/refund')
  @ApiOperation({ summary: '后台退款（整单/部分/配送费/回库可选）' })
  async refund(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: NightRefundDto,
  ) {
    const detail = await this.service.adminOrderDetail(id);
    await this.guardStoreCampus(req, detail.store!.id);
    return ok(
      await this.service.adminRefund(req.user.id, id, body),
      '退款已发起',
    );
  }

  @Post('orders/:id/refund/sync')
  @ApiOperation({ summary: '核对原退款申请，不重复发起退款' })
  async syncRefund(@Req() req: AuthRequest, @Param('id') id: string) {
    const detail = await this.service.adminOrderDetail(id);
    await this.guardStoreCampus(req, detail.store!.id);
    return ok(await this.service.syncRefund(id));
  }

  @Post('orders/:id/after-sale/reject')
  @ApiOperation({ summary: '驳回售后申请并留痕，已完成订单恢复待结算资格' })
  async rejectAfterSale(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: NightReasonDto) {
    const detail = await this.service.adminOrderDetail(id);
    await this.guardStoreCampus(req, detail.store!.id);
    return ok(await this.service.rejectAfterSale(req.user.id, id, body.reason));
  }

  /* ---------- 券（夜宵 Tab：模板数据复用现有券管理） ---------- */

  @Get('coupons')
  @ApiOperation({ summary: '夜宵券列表（businessType=night 模板过滤）' })
  async coupons(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    // 夜宵券与白天券共用 Coupon 模板与写端点（POST /admin/coupons 传
    // businessType=night 创建）；本端点提供夜宵 Tab 的专用过滤读取
    const rows = await this.service.nightCoupons(
      await this.campusScope(req, campus),
      status,
    );
    return ok(paginate(rows, page, pageSize));
  }

  /* ---------- 账务 ---------- */

  @Get('settlements')
  @ApiOperation({ summary: '佣金批次列表（周账单）' })
  async settlements(@Req() req: AuthRequest, @Query('campus') campus?: string) {
    return ok(
      await this.service.settlements(await this.campusScope(req, campus)),
    );
  }

  @Post('settlements/settle')
  @ApiOperation({
    summary: '周账单出账（pending 佣金 → settled + settleBatch）',
  })
  async settle(@Req() req: AuthRequest, @Body() body: NightSettleDto) {
    const campusId = body.campusId
      ? await this.campusScope(req, body.campusId)
      : await this.campusScope(req);
    for (const storeId of body.storeIds ?? []) await this.guardStoreCampus(req, storeId);
    return ok(
      await this.service.settleBatch(campusId, body.storeIds),
      '出账完成',
    );
  }

  @Post('settlements/:batch/pay')
  @ApiOperation({ summary: '批次标记打款（财务线下打款留痕）' })
  async markPaid(
    @Req() req: AuthRequest,
    @Param('batch') batch: string,
    @Body() body: { remark?: string },
  ) {
    for (const campusId of await this.service.settlementCampusIds(batch)) await this.campusScope(req, campusId);
    return ok(
      await this.service.markBatchPaid(req.user.id, batch, body.remark ?? ''),
      '已标记打款',
    );
  }

  @Post('stores/:id/deposit/deduct')
  @ApiOperation({ summary: '押金判责扣除（写 deduct 流水，不得扣到负数）' })
  async deductDeposit(
    @Req() req: AuthRequest,
    @Param('id') storeId: string,
    @Body() body: NightDepositDeductDto,
  ) {
    await this.guardStoreCampus(req, storeId);
    return ok(
      await this.service.deductDeposit(req.user.id, storeId, body),
      '押金已扣除',
    );
  }

  @Post('stores/:id/deposit/refund')
  @ApiOperation({ summary: '押金退还（退出清算，原路退款分配）' })
  async refundDeposit(
    @Req() req: AuthRequest,
    @Param('id') storeId: string,
    @Body() body: NightDepositRefundDto,
  ) {
    await this.guardStoreCampus(req, storeId);
    return ok(
      await this.service.refundDeposit(req.user.id, storeId, body),
      '押金退还已发起',
    );
  }

  @Get('stores/:id/liquidation')
  @ApiOperation({ summary: '退出清算清单（库存/未完订单/佣金/押金）' })
  async liquidation(@Req() req: AuthRequest, @Param('id') storeId: string) {
    await this.guardStoreCampus(req, storeId);
    return ok(await this.service.liquidation(storeId));
  }

  @Get('stores/:id/deposit-refunds')
  async depositRefunds(@Req() req: AuthRequest, @Param('id') storeId: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    await this.guardStoreCampus(req, storeId);
    return ok(await this.service.depositRefunds(storeId, page, pageSize));
  }

  @Get('stores/:id/deposit-txns')
  async depositTransactions(@Req() req: AuthRequest, @Param('id') storeId: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('kind') kind?: string) {
    await this.guardStoreCampus(req, storeId);
    return ok(await this.service.depositTransactions(storeId, page, pageSize, kind));
  }

  @Post('stores/:id/deposit/refunds/:requestId/sync')
  async syncDepositRefund(@Req() req: AuthRequest, @Param('id') storeId: string, @Param('requestId') requestId: string) {
    await this.guardStoreCampus(req, storeId);
    return ok(await this.service.syncDepositRefund(storeId, requestId));
  }

  /* ---------- 店铺/主档归属校验（campusScope 落地到资源） ---------- */

  private async guardStoreCampus(req: AuthRequest, storeId: string) {
    const campusId = await this.service.storeCampus(storeId);
    await this.campusScope(req, campusId);
  }

  private async guardCatalogCampus(req: AuthRequest, productId: string) {
    const campusId = await this.service.catalogCampus(productId);
    await this.campusScope(req, campusId);
  }
}
