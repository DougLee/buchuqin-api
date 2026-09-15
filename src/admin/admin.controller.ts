import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';
import { filterByKeyword, paginate } from '../common/pagination';
import { AdminService } from './admin.service';
import {
  canAdmin,
  isHqScope,
  type AdminAccess,
  type AdminSection,
} from './permissions';
import {
  AdjustStockDto,
  BatchProductStatusDto,
  BindPrinterDto,
  CreateAccountDto,
  LookupBarcodeDto,
  UpsertWechatGroupDto,
  UpsertWheelDto,
  CreateBannerDto,
  CreateBuildingDto,
  CreateCampusDto,
  CreatePromotionDto,
  CreateCategoryDto,
  CreateCommissionRuleDto,
  CreateCouponDto,
  CreateDispatchInvitationDto,
  CreateProductDto,
  ImportProductsDto,
  UpdateProductDto,
  CreateRoomDto,
  CreateStaffDto,
  IssueCouponDto,
  StockInDto,
  StocktakeDto,
  CreateRestockBatchDto,
  UpdateRestockBatchDto,
  SaveRestockOrderDto,
  AuditRestockOrderDto,
  CreatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  ClosePurchaseOrderDto,
  UpdateAccountDto,
  UpdateBannerDto,
  UpdateRecruitApplicationDto,
  RejectRecruitApplicationDto,
  UpdateBuildingDto,
  UpdateCampusDto,
  UpdatePromotionDto,
  UpdateCategoryDto,
  UpdateCommissionRuleDto,
  UpdateCouponDto,
  UpdateDeliveryConfigDto,
  UpdateLocationDto,
  CreateLocationDto,
  UpdateOrderStatusDto,
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
  /**
   * 多校区数据范围（IKAJSL → IKCHEW）：校区角色固定本校区（JWT campusId）；
   * 平台视角角色（hq/admin）跨校区，可用 ?campus= 选定单校区查看。
   * 返回空串表示"不限定校区"（service 侧跳过 campusId 过滤）。
   */
  private campusScope(req: AuthRequest, campus?: string): string {
    return isHqScope(req.user.role) ? campus?.trim() ?? '' : req.user.campusId;
  }
  /**
   * Banner 数据范围（IKBW0A）：校区自管——一律限定操作者本校区（多校区账号
   * 经切换校区换 token）。原 hq/admin 跨校区投放（IKAJSL、2026-08-26 决策）
   * 随「总部去掉投放功能」废止；hq 已移出 banners 权限矩阵。
   */
  private bannerScope(req: AuthRequest): string {
    return req.user.campusId;
  }
  /**
   * 商品板块数据范围（IKAJSM → IKCHEW 双视角）：hq 固定官方商品库伪校区；
   * admin 平台超管双视角——?view=official 官方库 / ?view=campus 本校区
   * （默认 official 与 hq 同口径）；校区角色固定本校区（官方库只读，经 import
   * 拉取落地）。非法 view 值按默认处理，不报错。
   */
  private productCampus(req: AuthRequest, view?: string, campus?: string): string {
    if (req.user.role === 'hq') {
      // IKFOPY：校区上下文操作（库存选品/入库/盘点）可显式指定校区（含总部仓）；
      // 不传回落官方库（商品管理主视角不变）
      return campus?.trim() || OFFICIAL_CAMPUS_ID;
    }
    if (req.user.role === 'admin') {
      return view === 'campus'
        ? campus?.trim() || req.user.campusId
        : OFFICIAL_CAMPUS_ID;
    }
    return req.user.campusId;
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
  async dashboard(
    @Req() req: AuthRequest,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'dashboard');
    return ok(await this.service.dashboard(this.campusScope(req, campus)));
  }
  @Get('products')
  @ApiOperation({
    summary: '商品列表（?page&pageSize 统一分页包裹；?status 逗号状态过滤 IKB3K9）',
  })
  async products(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('view') view?: string,
    @Query('categoryId') categoryId?: string,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'products');
    return ok(
      paginate(
        await this.service.products(
          this.productCampus(req, view, campus),
          status && status !== 'all'
            ? status.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
          // IKD6FG：分类筛选（官方库/本校区商品共用端点）
          categoryId || undefined,
        ),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  /** 商品状态计数（IKB3K9 Tab 角标）：口径同列表（含售罄映射），平台视角=官方库。 */
  @Get('products/status-counts')
  @ApiOperation({ summary: '商品状态计数（列表状态 Tab 角标用）' })
  async productStatusCounts(
    @Req() req: AuthRequest,
    @Query('view') view?: string,
  ) {
    this.authorize(req, 'products');
    return ok(
      await this.service.productStatusCounts(this.productCampus(req, view)),
    );
  }
  /** 官方库浏览（IKAJSO 导入弹窗）：校区角色只读官方库行，用于搜索+多选导入；
   *  2026-09-09 去重：操作者本校区已导入的官方商品不再进候选池（JWT 本校区口径）。 */
  @Get('products/official-library')
  @ApiOperation({
    summary:
      '官方商品库列表（校区导入弹窗用，只读；IKC1AB 仅含总部放行的可售商品；本校区已导入商品自动排除）',
  })
  async officialLibrary(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'products');
    return ok(
      paginate(
        // IKC1AB：导入候选池只见总部放行（可售）的商品；
        // 2026-09-09 去重：排除操作者本校区（JWT campusId）已导入的官方商品
        await this.service.products(
          OFFICIAL_CAMPUS_ID,
          ['on-sale'],
          undefined,
          req.user.campusId,
        ),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Get('categories')
  @ApiOperation({ summary: '商品类别列表（全局字典，带每类商品数）' })
  async categories(@Req() req: AuthRequest) {
    this.authorize(req, 'categories');
    return ok(await this.service.categories());
  }
  @Post('categories') async createCategory(
    @Req() req: AuthRequest,
    @Body() body: CreateCategoryDto,
  ) {
    this.authorize(req, 'categories', 'write');
    return ok(
      await this.service.createCategory(body, req.user.id, req.user.campusId),
      '类别已创建',
    );
  }
  @Patch('categories/:id') async updateCategory(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    this.authorize(req, 'categories', 'write');
    return ok(
      await this.service.updateCategory(
        id,
        body,
        req.user.id,
        req.user.campusId,
      ),
    );
  }
  @Delete('categories/:id') async deleteCategory(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'categories', 'write');
    return ok(
      await this.service.deleteCategory(id, req.user.id, req.user.campusId),
      '类别已删除',
    );
  }
  /** Banner 管理（IK9RX2 → IKAJSL 归总部；2026-08-26 admin 同步开放）：
   *  body.campusId 空 = 全部校区投放；hq/admin 均为跨校区视角。 */
  @Get('banners')
  @ApiOperation({
    summary:
      'Banner 列表（校区自管 IKBW0A，本校区范围；?placement 过滤，?page&pageSize 统一分页包裹）',
  })
  async banners(
    @Req() req: AuthRequest,
    @Query('placement') placement?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'banners');
    return ok(
      paginate(
        // IKB5PB：placement=pay-success 供「支付广告位」独立菜单；
        // IKB5PA：status 过滤（启用/隐藏 Tab）
        await this.service.banners(this.bannerScope(req), placement, status),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('banners') async createBanner(
    @Req() req: AuthRequest,
    @Body() body: CreateBannerDto,
  ) {
    this.authorize(req, 'banners', 'write');
    return ok(
      await this.service.createBanner(
        body,
        req.user.id,
        this.bannerScope(req),
      ),
      'Banner 已创建',
    );
  }
  @Patch('banners/:id') async updateBanner(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateBannerDto,
  ) {
    this.authorize(req, 'banners', 'write');
    return ok(
      await this.service.updateBanner(
        id,
        body,
        req.user.id,
        this.bannerScope(req),
      ),
    );
  }
  @Delete('banners/:id') async deleteBanner(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'banners', 'write');
    return ok(
      await this.service.deleteBanner(id, req.user.id, this.bannerScope(req)),
      'Banner 已删除',
    );
  }
  /** 促销活动管理（ADR-0006 / IKAHFF）：营销活动板块权限，全量审计；无删除。 */
  @Get('promotions')
  @ApiOperation({
    summary:
      '促销活动列表（校园维度经商品，?state=live/upcoming/ended/disabled 过滤 IKB5PA，?page&pageSize）',
  })
  async promotions(
    @Req() req: AuthRequest,
    @Query('state') state?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    // 全量断链审计（2026-09-05）：前端搜索框一直发 keyword，但此处漏接漏传
    // paginate，秒杀页搜索为死控件（其余列表端点均有）
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'marketing');
    return ok(
      paginate(
        await this.service.promotions(req.user.campusId, state),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  /** 营销地图（IKD6FI）：楼栋×楼层×寝室下单聚合（近 N 天已支付） */
  @Get('marketing/map')
  @ApiOperation({ summary: '营销地图：楼栋各楼层寝室下单情况' })
  async marketingMap(
    @Req() req: AuthRequest,
    @Query('buildingId') buildingId?: string,
    @Query('days') days?: string,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'marketing');
    if (!buildingId) throw new BadRequestException('请选择楼栋');
    const scope = this.campusScope(req, campus);
    if (!scope)
      throw new BadRequestException('请先选择要查看的校区（?campus=）');
    return ok(
      await this.service.marketingMap(
        buildingId,
        scope,
        Number(days) || 30,
      ),
    );
  }
  @Post('promotions') async createPromotion(
    @Req() req: AuthRequest,
    @Body() body: CreatePromotionDto,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.createPromotion(body, req.user.id, req.user.campusId),
      '促销活动已创建',
    );
  }
  @Patch('promotions/:id') async updatePromotion(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdatePromotionDto,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.updatePromotion(id, body, req.user.id, req.user.campusId),
    );
  }
  @Post('products/barcode/lookup') async lookupBarcode(
    @Req() req: AuthRequest,
    @Body() body: LookupBarcodeDto,
    @Query('view') view?: string,
  ) {
    this.authorize(req, 'products');
    return ok(
      await this.service.lookupBarcode(
        body.barcode,
        this.productCampus(req, view),
      ),
    );
  }
  /** 批量放行/回收（IKCKX4）：官方库视角批量放行回收，本校区视角批量上下架。
   *  作用域随 productCampus(req, view)，越界 id 静默忽略、返回实际更新数。 */
  @Post('products/batch-status') async batchProductStatus(
    @Req() req: AuthRequest,
    @Body() body: BatchProductStatusDto,
    @Query('view') view?: string,
  ) {
    this.authorize(req, 'products', 'write');
    return ok(
      await this.service.batchUpdateProductStatus(
        body.ids,
        body.status,
        req.user.id,
        this.productCampus(req, view),
      ),
      '批量操作已完成',
    );
  }
  /** IKB3K9：手动自建与官方库导入并存（修订 IKAJSM 单一口径）——
   *  平台视角建档落官方库；校区/admin 本校区视角可自建落本校区。 */
  @Post('products') async createProduct(
    @Req() req: AuthRequest,
    @Body() body: CreateProductDto,
    @Query('view') view?: string,
  ) {
    this.authorize(req, 'products', 'write');
    return ok(
      await this.service.createProduct(
        body,
        req.user.id,
        this.productCampus(req, view),
      ),
      '商品已创建',
    );
  }
  @Patch('products/:id') async updateProduct(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateProductDto,
    @Query('view') view?: string,
  ) {
    this.authorize(req, 'products', 'write');
    return ok(
      await this.service.updateProduct(
        id,
        body,
        req.user.id,
        this.productCampus(req, view),
      ),
    );
  }
  /** 校区从官方库导入商品（IKAJSO）：本地售价/上下架/库存自管。
   *  IKFOQ0：hq/admin 可带 ?campus=campus-hq 铺货到总部仓（订货锁库存的前提）。 */
  @Post('products/import') async importProducts(
    @Req() req: AuthRequest,
    @Body() body: ImportProductsDto,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'products', 'write');
    if (isHqScope(req.user.role)) {
      const target = campus?.trim();
      if (target !== HQ_CAMPUS_ID)
        throw new ForbiddenException('总部账号仅可铺货至总部仓（?campus=campus-hq）');
      return ok(
        await this.service.importProducts(body.productIds, req.user.id, target),
      );
    }
    return ok(
      await this.service.importProducts(
        body.productIds,
        req.user.id,
        req.user.campusId,
      ),
    );
  }
  /** 一键拉取上游资料（IKAJSO）：仅同步非售价/上下架/库存字段。 */
  @Post('products/:id/pull-upstream') async pullUpstream(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'products', 'write');
    if (req.user.role === 'hq')
      throw new ForbiddenException('官方商品库即商品源头，无需拉取上游');
    return ok(
      await this.service.pullUpstream(id, req.user.id, req.user.campusId),
      '已同步官方库最新资料',
    );
  }
  @Get('inventory')
  @ApiOperation({ summary: '库存列表（?page&pageSize 统一分页包裹）' })
  async inventory(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'inventory');
    return ok(
      paginate(
        await this.service.inventory(
          // IKFOPY：campusScope 化——平台视角可聚焦总部仓/任一校区
          this.campusScope(req, campus),
          // IKD6FG：分类筛选（库存按类别盘点）
          categoryId || undefined,
        ),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('inventory/stock-in') async stockIn(
    @Req() req: AuthRequest,
    @Body() body: StockInDto,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'inventory', 'write');
    // 采购申请-审核制（IKD6FJ）：校区走采购申请，直接入库仅限平台视角角色
    if (!isHqScope(req.user.role))
      throw new ForbiddenException(
        '采购已改为申请-审核制，请提交采购申请，由总部审核后入库',
      );
    const campusId = this.campusScope(req, campus);
    // IKFOPY：平台视角 campusId 不来自账号，必须显式指定仓库（含总部仓）
    if (!campusId)
      throw new BadRequestException('请先选择入库仓库（校区或总部仓）');
    return ok(await this.service.stockIn(body, req.user.id, campusId), '入库完成');
  }
  /** 盘点校准（IKD6FJ）：提交实际清点数量，系统自动算差额落账 */
  @Post('inventory/stocktake') async stocktake(
    @Req() req: AuthRequest,
    @Body() body: StocktakeDto,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'inventory', 'write');
    const campusId = this.campusScope(req, campus);
    if (!campusId)
      throw new BadRequestException('请先选择盘点仓库（校区或总部仓）');
    return ok(
      await this.service.stocktake(body, req.user.id, campusId),
      '盘点已提交',
    );
  }
  // ==================== 订货批次（IKFOQ0）：独立板块「订货管理」====================

  /** 批次列表：阶段由时间窗推导；校区角色附带本校区单况统计。 */
  @Get('restock/batches') async restockBatches(@Req() req: AuthRequest) {
    this.authorize(req, 'restock', 'read');
    return ok(
      await this.service.restockBatches(isHqScope(req.user.role), req.user.campusId),
    );
  }
  @Post('restock/batches') async createRestockBatch(
    @Req() req: AuthRequest,
    @Body() body: CreateRestockBatchDto,
  ) {
    this.authorize(req, 'restock', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以创建订货批次');
    return ok(await this.service.createRestockBatch(body, req.user.id), '批次已创建');
  }
  @Patch('restock/batches/:id') async updateRestockBatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRestockBatchDto,
  ) {
    this.authorize(req, 'restock', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以修改订货批次');
    return ok(await this.service.updateRestockBatch(id, body, req.user.id), '批次已更新');
  }
  @Post('restock/batches/:id/close') async closeRestockBatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'restock', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以关闭订货批次');
    return ok(await this.service.closeRestockBatch(id, req.user.id), '批次已关闭');
  }
  /** 批次详情：总部看全校区单，校区只看本校区单。 */
  @Get('restock/batches/:id') async restockBatchDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'restock', 'read');
    return ok(
      await this.service.restockBatchDetail(
        id,
        isHqScope(req.user.role),
        req.user.campusId,
      ),
    );
  }
  /** 校区保存本批次订货单（upsert，草稿/驳回态可改）。 */
  @Put('restock/batches/:batchId/order') async saveRestockOrder(
    @Req() req: AuthRequest,
    @Param('batchId') batchId: string,
    @Body() body: SaveRestockOrderDto,
  ) {
    this.authorize(req, 'restock', 'write');
    if (isHqScope(req.user.role))
      throw new ForbiddenException('订货由校区发起，总部账号请走审核');
    if (!req.user.campusId)
      throw new BadRequestException('账号未绑定校区，无法订货');
    return ok(
      await this.service.saveRestockOrder(batchId, body, req.user.id, req.user.campusId),
      '订货单已保存',
    );
  }
  /** 校区提交订货单（窗口内）。 */
  @Post('restock/batches/:batchId/order/submit') async submitRestockOrder(
    @Req() req: AuthRequest,
    @Param('batchId') batchId: string,
  ) {
    this.authorize(req, 'restock', 'write');
    if (isHqScope(req.user.role))
      throw new ForbiddenException('订货由校区发起，总部账号请走审核');
    if (!req.user.campusId)
      throw new BadRequestException('账号未绑定校区，无法订货');
    return ok(
      await this.service.submitRestockOrder(batchId, req.user.id, req.user.campusId),
      '订货单已提交，等待总部审核',
    );
  }
  /** 校区撤回（已提交未审核）。 */
  @Post('restock/batches/:batchId/order/withdraw') async withdrawRestockOrder(
    @Req() req: AuthRequest,
    @Param('batchId') batchId: string,
  ) {
    this.authorize(req, 'restock', 'write');
    if (isHqScope(req.user.role))
      throw new ForbiddenException('订货由校区发起，总部账号请走审核');
    if (!req.user.campusId)
      throw new BadRequestException('账号未绑定校区，无法订货');
    return ok(
      await this.service.withdrawRestockOrder(batchId, req.user.id, req.user.campusId),
      '订货单已撤回草稿',
    );
  }
  /** 订货单列表（?batchId&status 过滤）。 */
  @Get('restock/orders') async restockOrders(
    @Req() req: AuthRequest,
    @Query('batchId') batchId?: string,
    @Query('status') status?: string,
  ) {
    this.authorize(req, 'restock', 'read');
    return ok(
      await this.service.restockOrders(isHqScope(req.user.role), req.user.campusId, {
        batchId,
        status,
      }),
    );
  }
  @Get('restock/orders/:id') async restockOrderDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'restock', 'read');
    return ok(
      await this.service.restockOrderDetail(
        id,
        isHqScope(req.user.role),
        req.user.campusId,
      ),
    );
  }
  /** 总部审核：confirm 锁总部仓库存（不足阻断），reject 驳回，revoke 撤销放锁。 */
  @Post('restock/orders/:id/audit') async auditRestockOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: AuditRestockOrderDto,
  ) {
    this.authorize(req, 'restock', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以审核订货单');
    return ok(
      await this.service.auditRestockOrder(id, body, req.user.id),
      body.action === 'confirm'
        ? '已确认并锁定总部仓库存'
        : body.action === 'reject'
          ? '已驳回'
          : '已撤销确认，锁定库存已释放',
    );
  }

  // ==================== 采购单（IKFOQ1）：独立板块「采购管理」====================
  // 全链总部动作（hq/admin）：生成聚合/验收入库/关闭重开；权限 purchase section。
  @Get('purchase/orders') async purchaseOrders(@Req() req: AuthRequest) {
    this.authorize(req, 'purchase');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('采购管理仅总部可用');
    return ok(await this.service.purchaseOrders());
  }
  @Get('purchase/orders/:id') async purchaseOrderDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'purchase');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('采购管理仅总部可用');
    return ok(await this.service.purchaseOrderDetail(id));
  }
  /** 一键聚合生成（grilling #2）：行=批次全部已确认订货单按商品求和。 */
  @Post('restock/batches/:batchId/purchase-order') async createPurchaseOrder(
    @Req() req: AuthRequest,
    @Param('batchId') batchId: string,
    @Body() body: CreatePurchaseOrderDto,
  ) {
    this.authorize(req, 'purchase', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以生成采购单');
    return ok(
      await this.service.createPurchaseOrder(batchId, body, req.user.id),
      '采购单已生成',
    );
  }
  /** 验收入库（grilling #3/#4）：快捷全收+坏品出库+双流水，单事务。 */
  @Post('purchase/orders/:id/receive') async receivePurchaseOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: ReceivePurchaseOrderDto,
  ) {
    this.authorize(req, 'purchase', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以验收');
    return ok(
      await this.service.receivePurchaseOrder(id, body, req.user.id),
      '验收完成，库存已更新',
    );
  }
  @Post('purchase/orders/:id/close') async closePurchaseOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: ClosePurchaseOrderDto,
  ) {
    this.authorize(req, 'purchase', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以关闭采购单');
    return ok(
      await this.service.closePurchaseOrder(id, body, req.user.id),
      '采购单已关闭，欠收作废',
    );
  }
  @Post('purchase/orders/:id/reopen') async reopenPurchaseOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'purchase', 'write');
    if (!isHqScope(req.user.role))
      throw new ForbiddenException('只有总部可以重开采购单');
    return ok(
      await this.service.reopenPurchaseOrder(id, req.user.id),
      '采购单已重开，可继续验收',
    );
  }
  @Post('inventory/adjust') async adjustStock(
    @Req() req: AuthRequest,
    @Body() body: AdjustStockDto,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'inventory', 'write');
    const campusId = this.campusScope(req, campus);
    if (!campusId)
      throw new BadRequestException('请先选择调整仓库（校区或总部仓）');
    return ok(
      await this.service.adjustStock(body, req.user.id, campusId),
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
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'inventory');
    return ok(
      paginate(
        await this.service.inventoryTxns(productId, this.campusScope(req, campus)),
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
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('deliveryMode') deliveryMode?: string,
  ) {
    this.authorize(req, 'orders');
    return ok(
      paginate(
        await this.service.orders(
          status,
          this.campusScope(req, campus),
          // IKD6FG：配送方式筛选（instant/scheduled）
          deliveryMode || undefined,
        ),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  // 路由顺序：必须声明在 orders/:id 之前，否则 status-counts 会被当成订单 id
  @Get('orders/status-counts')
  @ApiOperation({ summary: '订单状态计数（IKAJSP：列表 Tab 角标；hq ?campus 可选）' })
  async orderStatusCounts(
    @Req() req: AuthRequest,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'orders');
    return ok(await this.service.orderStatusCounts(this.campusScope(req, campus)));
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
    // 仓库出库（IKA0UQ）落在库存板块：仓储角色对 orders 只读但可出库。
    this.authorize(req, action === 'outbound' ? 'inventory' : 'orders', 'write');
    return ok(
      await this.service.orderAction(
        id,
        action,
        req.user.id,
        req.user.campusId,
      ),
    );
  }
  /** 手动改订单状态（IKA0UT）：12 态白名单 + 原因进审计日志。 */
  @Post('orders/:id/status')
  async updateOrderStatus(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateOrderStatusDto,
  ) {
    this.authorize(req, 'orders', 'write');
    return ok(
      await this.service.updateOrderStatus(
        id,
        body,
        req.user.id,
        req.user.campusId,
      ),
      '订单状态已更新',
    );
  }
  /** 补打小票（IKBT6N）：芯烨云重推订单小票，写审计日志。 */
  @Post('orders/:id/print-receipt')
  async printReceipt(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'orders', 'write');
    return ok(
      await this.service.reprintReceipt(id, req.user.id, req.user.campusId),
      '小票已发送打印',
    );
  }
  /* ---------- 校区打印机绑定（IKBW0Q）：校区自主绑定/管理小票机 ---------- */
  @Get('printers')
  @ApiOperation({ summary: '本校区打印机列表（一校区一台，IKBW0Q）' })
  async printers(@Req() req: AuthRequest) {
    this.authorize(req, 'printers');
    return ok(await this.service.printers(req.user.campusId));
  }
  @Post('printers')
  @ApiOperation({ summary: '绑定/换绑打印机（SN+KEY，先绑芯烨云账号再落库）' })
  async bindPrinter(
    @Req() req: AuthRequest,
    @Body() body: BindPrinterDto,
  ) {
    this.authorize(req, 'printers', 'write');
    return ok(
      await this.service.bindPrinter(body, req.user.id, req.user.campusId),
      '打印机已绑定',
    );
  }
  @Delete('printers/:id')
  @ApiOperation({ summary: '解绑打印机（删本校区绑定记录）' })
  async unbindPrinter(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'printers', 'write');
    return ok(
      await this.service.unbindPrinter(id, req.user.id, req.user.campusId),
      '打印机已解绑',
    );
  }
  @Post('printers/:id/test-print')
  @ApiOperation({ summary: '测试打印（连通性验证，出一张测试小票）' })
  async testPrintPrinter(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'printers', 'write');
    return ok(
      await this.service.testPrintPrinter(id, req.user.id, req.user.campusId),
      '测试小票已发送打印',
    );
  }
  /* ---------- C 端用户管理（IKAJSW）：运营域只读 ---------- */
  // 路由顺序：静态段（stats）须在 users/:id/... 之前
  @Get('users/stats')
  @ApiOperation({ summary: 'C 端用户统计（IKAJSW；hq ?campus 可选）' })
  async userStats(
    @Req() req: AuthRequest,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'users');
    return ok(await this.service.userStats(this.campusScope(req, campus)));
  }
  @Get('users/:id/orders')
  @ApiOperation({ summary: '单个用户订单流水（IKAJSW 详情抽屉）' })
  async userOrders(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'users');
    return ok(await this.service.userOrders(id, this.campusScope(req)));
  }
  @Get('users/:id/phone')
  @ApiOperation({
    summary: '查看用户明文手机号（列表恒脱敏，按需单查+审计留痕）',
  })
  async revealUserPhone(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'users');
    return ok(
      await this.service.revealUserPhone(
        id,
        req.user.id,
        this.campusScope(req),
      ),
    );
  }
  @Get('users')
  @ApiOperation({
    summary: 'C 端用户列表（楼栋/注册时间/关键词筛选；hq ?campus 可选）',
  })
  async users(
    @Req() req: AuthRequest,
    @Query('buildingId') buildingId?: string,
    @Query('campus') campus?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    this.authorize(req, 'users');
    return ok(
      await this.service.users(this.campusScope(req, campus), {
        buildingId: buildingId || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        keyword: keyword?.trim() || undefined,
        page: Math.max(1, Number(page) || 1),
        pageSize: Math.min(100, Math.max(1, Number(pageSize) || 20)),
      }),
    );
  }
  /* ---------- 微信群二维码（IKAJSY）：组织营销域 ---------- */
  @Get('wechat-groups')
  @ApiOperation({ summary: '群码列表（IKAJSY）' })
  async wechatGroups(@Req() req: AuthRequest) {
    this.authorize(req, 'wechat-groups');
    return ok(await this.service.wechatGroups(req.user.campusId));
  }
  @Post('wechat-groups')
  @ApiOperation({ summary: '新增/替换楼栋群或校级大群二维码' })
  async upsertWechatGroup(
    @Req() req: AuthRequest,
    @Body() body: UpsertWechatGroupDto,
  ) {
    this.authorize(req, 'wechat-groups', 'write');
    return ok(
      await this.service.upsertWechatGroup(
        body,
        req.user.id,
        req.user.campusId,
      ),
      '群码已保存',
    );
  }

  /* ---------- 抽奖大转盘（IKD6FC）：营销域 ---------- */
  @Get('wheel')
  @ApiOperation({ summary: '转盘配置（IKD6FC，含奖位与概率预览）' })
  async wheel(@Req() req: AuthRequest) {
    this.authorize(req, 'marketing');
    return ok(await this.service.wheel(req.user.campusId));
  }
  @Put('wheel')
  @ApiOperation({ summary: '保存转盘配置（8 奖位 + 活动开关）' })
  async upsertWheel(
    @Req() req: AuthRequest,
    @Body() body: UpsertWheelDto,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.upsertWheel(body, req.user.id, req.user.campusId),
      '转盘配置已保存',
    );
  }
  @Delete('wechat-groups/:id')
  @ApiOperation({ summary: '删除群码' })
  async deleteWechatGroup(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'wechat-groups', 'write');
    return ok(
      await this.service.deleteWechatGroup(id, req.user.id, req.user.campusId),
      '群码已删除',
    );
  }
  /* ---------- 库位管理（IKA0VG）：随库存板块权限走 ---------- */
  @Get('locations') async locations(@Req() req: AuthRequest) {
    this.authorize(req, 'inventory');
    return ok(await this.service.locations(req.user.campusId));
  }
  @Post('locations')
  async createLocation(
    @Req() req: AuthRequest,
    @Body() body: CreateLocationDto,
  ) {
    this.authorize(req, 'inventory', 'write');
    return ok(
      await this.service.createLocation(body, req.user.id, req.user.campusId),
      '库位已创建',
    );
  }
  @Patch('locations/:id')
  async updateLocation(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateLocationDto,
  ) {
    this.authorize(req, 'inventory', 'write');
    return ok(
      await this.service.updateLocation(
        id,
        body,
        req.user.id,
        req.user.campusId,
      ),
      '库位已更新',
    );
  }
  @Delete('locations/:id')
  async deleteLocation(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'inventory', 'write');
    await this.service.deleteLocation(id, req.user.id, req.user.campusId);
    return ok({ id }, '库位已删除');
  }
  @Get('staff')
  @ApiOperation({ summary: '员工列表（?page&pageSize 统一分页包裹）' })
  async staff(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
    @Query('role') role?: string,
  ) {
    this.authorize(req, 'staff');
    return ok(
      // IKB5PA：status 过滤（在线/暂停/离线 Tab）；IKD6FG：角色筛选
      paginate(
        await this.service.staff(req.user.campusId, status, role || undefined),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Get('leave-requests')
  @ApiOperation({ summary: '请假列表（?page&pageSize 统一分页包裹）' })
  async leaveRequests(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'staff');
    return ok(
      paginate(
        // IKB5PA：status 过滤（请假审核状态 Tab）
        await this.service.leaveRequests(req.user.campusId, status),
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
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'staff');
    return ok(
      paginate(
        // IKB5PA：status 过滤（邀请响应状态 Tab）
        await this.service.dispatchInvitations(req.user.campusId, status),
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
  @Get('delivery-config')
  @ApiOperation({
    summary: '配送费/起送门槛配置（IK9SO6，单位分）',
    description: '即时达/次日达配送费与起送门槛，business 端 cart/checkout 按此生效。',
  })
  async deliveryConfig(@Req() req: AuthRequest) {
    this.authorize(req, 'campuses');
    return ok(await this.service.deliveryConfig(req.user.campusId));
  }
  @Patch('delivery-config')
  async updateDeliveryConfig(
    @Req() req: AuthRequest,
    @Body() body: UpdateDeliveryConfigDto,
  ) {
    this.authorize(req, 'campuses', 'write');
    return ok(
      await this.service.updateDeliveryConfig(
        body,
        req.user.id,
        req.user.campusId,
      ),
      '配送配置已更新',
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
    this.authorize(req, 'buildings');
    return ok(
      paginate(await this.service.buildings(req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('buildings') async createBuilding(
    @Req() req: AuthRequest,
    @Body() body: CreateBuildingDto,
  ) {
    this.authorize(req, 'buildings', 'write');
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
    this.authorize(req, 'buildings', 'write');
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
    this.authorize(req, 'buildings', 'write');
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
    this.authorize(req, 'buildings');
    return ok(
      paginate(await this.service.rooms(id, req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('buildings/:id/rooms') async createRoom(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: CreateRoomDto,
  ) {
    this.authorize(req, 'buildings', 'write');
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
    this.authorize(req, 'buildings', 'write');
    return ok(
      await this.service.deleteRoom(id, roomId, req.user.id, req.user.campusId),
      '寝室已删除',
    );
  }
  /** 寝室导入模板（IKD6FH）：xlsx 两列（楼层/寝室号）+ 示例行 */
  @Get('buildings/:id/rooms/template')
  @ApiOperation({ summary: '寝室导入模板下载（xlsx）' })
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async roomTemplate(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    this.authorize(req, 'buildings', 'write');
    const { filename, buffer } = await this.service.roomTemplate(
      id,
      req.user.campusId,
    );
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="rooms-template.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
  }
  /** 寝室批量导入（IKD6FH）：解析模板 xlsx，已存在寝室自动跳过 */
  @Post('buildings/:id/rooms/import')
  @ApiOperation({ summary: '寝室批量导入（xlsx 模板）' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async importRooms(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    this.authorize(req, 'buildings', 'write');
    if (!file) throw new BadRequestException('请选择要导入的 xlsx 文件');
    return ok(
      await this.service.importRooms(
        id,
        req.user.campusId,
        file.buffer,
        req.user.id,
      ),
    );
  }
  @Get('after-sales')
  @ApiOperation({ summary: '售后列表（?page&pageSize 统一分页包裹）' })
  async afterSales(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'after-sales');
    return ok(
      paginate(
        // IKB5PA：status 过滤（售后状态 Tab）
        await this.service.afterSales(req.user.campusId, status),
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
  @Get('campuses') async campuses(
    @Req() req: AuthRequest,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'dashboard');
    return ok(filterByKeyword(await this.service.campuses(), keyword));
  }
  /* ---------- 校区本体管理（IKAJSL）：新校区接入 ---------- */
  @Post('campuses')
  @ApiOperation({ summary: '新建校区（总部/平台超管）' })
  async createCampus(@Req() req: AuthRequest, @Body() body: CreateCampusDto) {
    // 本体增改是平台级动作，不进矩阵单列板块。IKBWRT（2026-08-29 道哥定版）：
    // admin 平台超管全菜单操作权限，与 hq 同权建改校区（对齐 IKBFJ4 账号同权）；
    // operations 等职能角色仍只管楼栋域。
    if (req.user.role !== 'hq' && req.user.role !== 'admin')
      throw new ForbiddenException('仅总部/平台超管账号可新增校区');
    return ok(await this.service.createCampus(body, req.user.id), '校区已创建');
  }
  @Patch('campuses/:id')
  @ApiOperation({ summary: '修改校区信息/启停（总部/平台超管）' })
  async updateCampus(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCampusDto,
  ) {
    if (req.user.role !== 'hq' && req.user.role !== 'admin')
      throw new ForbiddenException('仅总部/平台超管账号可修改校区');
    return ok(
      await this.service.updateCampus(id, body, req.user.id),
      '校区已更新',
    );
  }
  @Get('coupons')
  @ApiOperation({ summary: '优惠券列表（?page&pageSize 统一分页包裹）' })
  async coupons(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'marketing');
    return ok(
      // IKB5PA：status 过滤（发放中/已暂停 Tab）
      paginate(
        await this.service.coupons(req.user.campusId, status),
        page,
        pageSize,
        keyword,
      ),
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
  /** 优惠券删除（IKDES1）：仅限从未发放；已发记录拒绝（走暂停） */
  @Delete('coupons/:id') async deleteCoupon(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.deleteCoupon(id, req.user.id, req.user.campusId),
      '优惠券已删除',
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
  @ApiOperation({
    summary: '审计日志（?page&pageSize 统一分页包裹；hq ?campus 可选）',
  })
  async audits(
    @Req() req: AuthRequest,
    @Query('campus') campus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'audit');
    return ok(
      paginate(
        await this.service.auditLogs(this.campusScope(req, campus)),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  /* ---------- 后台账号管理（IK9KWO）：accounts 板块仅 hq/admin ----------
     IKBFJ4（2026-08-27）：平台超管 admin 与 hq 同权——列表全量、可建/改/删任意角色；
     保护规则（最后一名 admin/hq、不可删自己）不变。 */
  @Get('accounts')
  @ApiOperation({
    summary: '后台账号列表（hq/admin 全量带 campusName/campusNames）',
  })
  async accounts(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.authorize(req, 'accounts');
    // IKAJSL→IKBFJ4：平台角色跨校区查全部；其余视角（现无入口）按校区
    const platform = req.user.role === 'hq' || req.user.role === 'admin';
    return ok(
      paginate(
        await this.service.accounts(platform ? undefined : req.user.campusId),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('accounts')
  @ApiOperation({
    summary: '新建后台账号（hq/admin 可建总部或任意校区账号）',
  })
  async createAccount(@Req() req: AuthRequest, @Body() body: CreateAccountDto) {
    this.authorize(req, 'accounts', 'write');
    return ok(
      await this.service.createAccount(
        body,
        req.user.id,
        req.user.campusId,
        req.user.role,
      ),
      '账号已创建',
    );
  }
  @Patch('accounts/:id')
  @ApiOperation({
    summary: '改昵称/角色或重置密码；最后一个 admin/hq 不可降级删除',
  })
  async updateAccount(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAccountDto,
  ) {
    this.authorize(req, 'accounts', 'write');
    return ok(
      await this.service.updateAccount(
        id,
        body,
        req.user.id,
        req.user.campusId,
        req.user.role,
      ),
    );
  }
  @Delete('accounts/:id')
  @ApiOperation({ summary: '删除后台账号；不可删自己/最后一个 admin 或 hq' })
  async deleteAccount(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'accounts', 'write');
    return ok(
      await this.service.deleteAccount(
        id,
        req.user.id,
        req.user.campusId,
        req.user.role,
      ),
      '账号已删除',
    );
  }

  /* ---------- 楼长招募（IKEAGE 2026-09-09）：报名列表 → 面试审批 → 实习楼长 ---------- */
  @Get('recruit-applications')
  @ApiOperation({
    summary:
      '楼长招募报名列表（?status Tab 过滤、?campus 跨校区视角、?keyword 姓名/手机号；统一分页包裹）',
  })
  async recruitApplications(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('campus') campus?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    this.authorize(req, 'recruit');
    return ok(
      paginate(
        await this.service.recruitApplications(
          this.campusScope(req, campus),
          status,
          keyword,
        ),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  /** 状态 Tab 计数（IKEAGE）：pending/interviewing/approved/rejected。 */
  @Get('recruit-applications/status-counts')
  async recruitStatusCounts(
    @Req() req: AuthRequest,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'recruit');
    return ok(
      await this.service.recruitStatusCounts(this.campusScope(req, campus)),
    );
  }
  /** 资料补录（IKEAGE）：身份证号/照片/运营备注，随时可补不占状态机。 */
  @Patch('recruit-applications/:id')
  async updateRecruitApplication(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRecruitApplicationDto,
  ) {
    this.authorize(req, 'recruit', 'write');
    return ok(
      await this.service.updateRecruitApplication(
        id,
        body,
        req.user.id,
        this.campusScope(req),
      ),
    );
  }
  /** 待联系 → 面试中（IKEAGE）。 */
  @Post('recruit-applications/:id/transition')
  async recruitTransition(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'recruit', 'write');
    return ok(
      await this.service.recruitTransition(
        id,
        req.user.id,
        this.campusScope(req),
      ),
      '已进入面试',
    );
  }
  /** 拒绝报名（IKEAGE）：原因 C 端进度页可见。 */
  @Post('recruit-applications/:id/reject')
  async recruitReject(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: RejectRecruitApplicationDto,
  ) {
    this.authorize(req, 'recruit', 'write');
    return ok(
      await this.service.recruitReject(
        id,
        body.reason,
        req.user.id,
        this.campusScope(req),
      ),
      '已拒绝',
    );
  }
  /** 审批通过（IKEAGE）：事务创建实习楼长（工号 IBM-xxx 自动生成）并关联。 */
  @Post('recruit-applications/:id/approve')
  async recruitApprove(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req, 'recruit', 'write');
    return ok(
      await this.service.recruitApprove(
        id,
        req.user.id,
        this.campusScope(req),
      ),
      '已通过并创建实习楼长',
    );
  }
}
