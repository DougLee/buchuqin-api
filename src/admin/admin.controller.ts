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
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';
import { filterByKeyword, paginate } from '../common/pagination';
import { AdminService } from './admin.service';
import { AdminAuthGuard } from './rbac/admin-auth.guard';
import { RbacService } from './rbac/rbac.service';
import { SECTION_ACCESS_CODE, MENU_CATALOG } from './rbac/registry';
import type { RbacContext } from './rbac/rbac.service';
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
  SaveFeaturedDto,
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
  ShipRestockOrderDto,
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
// RBAC V1（2026-09-19）：AdminAuthGuard = JWT 验签 + AdminAccount 实时校验
//（状态/会话版本）+ 有效权限装载（request.rbac）；每端点经 authorize/requirePerm
// 按权限码判权，默认拒绝。旧 5 角色静态矩阵（permissions.ts）已退役为迁移基线。
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly service: AdminService,
    private readonly rbac: RbacService,
  ) {}
  /** 本请求 RBAC 上下文（守卫已装载；单元测试可注入伪造） */
  private ctx(req: AuthRequest): RbacContext {
    const ctx = (req as { rbac?: RbacContext }).rbac;
    if (!ctx) throw new ForbiddenException('未授权的访问');
    return ctx;
  }
  /** 权限码判定（超管通配）；未持有抛 403 */
  private requirePerm(req: AuthRequest, code: string) {
    const ctx = this.ctx(req);
    if (!this.rbac.has(ctx, code))
      throw new ForbiddenException('当前账号无该操作权限');
  }
  /** 权限码判定（非抛出版） */
  private hasPerm(req: AuthRequest, code: string): boolean {
    const ctx = (req as { rbac?: RbacContext }).rbac;
    return !!ctx && this.rbac.has(ctx, code);
  }
  /**
   * 兼容层：旧板块×读写调用面 → 权限码（映射表 rbac/registry.ts SECTION_ACCESS_CODE）。
   * 细粒度端点（改价/上下架/入库/盘点/出库/身份证/账单/提成规则/库位/配送配置等）
   * 已直接改用 requirePerm(具体码)。
   */
  private authorize(
    req: AuthRequest,
    section: string,
    access: 'read' | 'write' = 'read',
  ) {
    const mapped = SECTION_ACCESS_CODE[section]?.[access];
    if (!mapped) throw new ForbiddenException(`未登记的板块权限: ${section}.${access}`);
    this.requirePerm(req, mapped);
  }
  /**
   * 多校区数据范围（RBAC V1）：平台级授权 → ?campus= 可选聚焦（需真实存在的
   * 校区，服务端校验，空=跨校区全量）；校区级授权 → 恒定本上下文校区（参数被
   * 忽略，杜绝越校区查询）。
   */
  private async campusScope(req: AuthRequest, campus?: string): Promise<string> {
    const ctx = this.ctx(req);
    if (ctx.platform) {
      const c = campus?.trim() ?? '';
      if (c && !(await this.rbac.knownCampusIds()).has(c))
        throw new BadRequestException('目标校区不存在');
      return c;
    }
    return ctx.campusId;
  }
  /** 校区级写入目标校验：目标校区必须在授权范围内（平台级=存在即可；校区级=已授权校区） */
  private async assertCampusAllowed(req: AuthRequest, campusId?: string): Promise<string> {
    const ctx = this.ctx(req);
    const target = campusId?.trim() || ctx.campusId;
    if (!target) throw new BadRequestException('未指定校区');
    if (!(await this.rbac.knownCampusIds()).has(target))
      throw new BadRequestException('校区不存在');
    if (!ctx.platform && target !== ctx.campusId && !ctx.campuses.includes(target))
      throw new ForbiddenException('未授权在该校区操作');
    return target;
  }
  /**
   * Banner 数据范围（IKBW0A）：校区自管——一律限定操作者本校区（多校区账号
   * 经切换校区换 token）。
   */
  private bannerScope(req: AuthRequest): string {
    return this.ctx(req).campusId;
  }
  /**
   * 商品板块数据范围（RBAC V1 双视角）：平台级授权（总部长/超管）默认官方库，
   * ?view=campus 切本校区（可显式 ?campus=）；校区级授权固定本校区。
   * 旧 hq/admin 分支语义由 platform 授权等价承接。
   */
  private productCampus(req: AuthRequest, view?: string, campus?: string): string {
    const ctx = this.ctx(req);
    if (ctx.platform) {
      return view === 'campus'
        ? campus?.trim() || ctx.campusId || OFFICIAL_CAMPUS_ID
        : OFFICIAL_CAMPUS_ID;
    }
    return ctx.campusId;
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
    return ok(await this.service.dashboard(await this.campusScope(req, campus)));
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
  /** 首页推荐位（IKH0EK 2026-09-19 道哥定版）：手动优先+销量补齐；本校区维度 */
  @Get('featured')
  @ApiOperation({ summary: '首页推荐位列表（本校区，featuredSort 升序）' })
  async featured(@Req() req: AuthRequest) {
    this.authorize(req, 'marketing');
    return ok(await this.service.featured(req.user.campusId));
  }
  @Put('featured')
  @ApiOperation({
    summary: '保存推荐位（全量有序商品 id，事务清位重设；越界 id 静默剔除）',
  })
  async saveFeatured(@Req() req: AuthRequest, @Body() body: SaveFeaturedDto) {
    this.authorize(req, 'marketing', 'write');
    return ok(
      await this.service.saveFeatured(body.productIds, req.user.campusId),
      '推荐位已保存',
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
    const scope = await this.campusScope(req, campus);
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
    // 官方库视角批量放行/回收=平台码；本校区视角批量上下架=products.status
    const official = this.productCampus(req, view) === OFFICIAL_CAMPUS_ID;
    this.requirePerm(req, official ? 'products.official.write' : 'products.status');
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
    // 官方库视角建档=平台码；本校区视角=products.write
    const officialCreate = this.productCampus(req, view) === OFFICIAL_CAMPUS_ID;
    this.requirePerm(req, officialCreate ? 'products.official.write' : 'products.write');
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
    // 官方库视角编辑=平台码；本校区=products.write；价格字段另需 products.price
    //（RBAC V1 字段级分权：普通编辑不得夹带改价）
    const officialUpdate = this.productCampus(req, view) === OFFICIAL_CAMPUS_ID;
    this.requirePerm(req, officialUpdate ? 'products.official.write' : 'products.write');
    if (!officialUpdate) {
      const PRICE_FIELDS = ['price', 'originalPrice', 'costPrice', 'wholesalePrice'];
      const touchingPrice = PRICE_FIELDS.some(
        (f) => (body as Record<string, unknown>)[f] !== undefined,
      );
      if (touchingPrice) this.requirePerm(req, 'products.price');
    }
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
   *  IKFOQ0：总部视角（hq / 未绑校区的 admin）可带 ?campus=campus-hq 铺货到
   *  总部仓（订货锁库存的前提）。
   *  IKGNQ 修复（2026-09-18 道哥）：admin 绑定实际校区后，导入与校区角色
   *  同语义——落自己绑定的校区，不再被 isHqScope 一刀切拦成「仅可铺货总部仓」。 */
  @Post('products/import') async importProducts(
    @Req() req: AuthRequest,
    @Body() body: ImportProductsDto,
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'products', 'write');
    const hqOnly = !req.user.campusId || req.user.campusId === HQ_CAMPUS_ID;
    if (this.ctx(req).platform && hqOnly) {
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
    // 平台级且无校区上下文（官方库视角）=商品源头，无需拉取
    if (this.ctx(req).platform && (!req.user.campusId || req.user.campusId === HQ_CAMPUS_ID))
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
          // IKFOPY：campusScope 化——平台视角可聚焦总部仓/任一校区。
          // 缺省落地（修复空串炸 P2025）：admin 用本校区归属，hq 无归属缺省总部仓
          await this.campusScope(req, campus) ||
            req.user.campusId ||
            HQ_CAMPUS_ID,
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
    // 直接入库=平台口径（IKD6FJ，inventory.inbound）：校区走订货/采购申请
    if (!this.hasPerm(req, 'inventory.inbound'))
      throw new ForbiddenException(
        '采购已改为申请-审核制，请提交采购申请，由总部审核后入库',
      );
    const campusId = await this.campusScope(req, campus);
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
    this.requirePerm(req, 'inventory.adjust');
    const campusId = await this.campusScope(req, campus);
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
      await this.service.restockBatches(this.ctx(req).platform, req.user.campusId),
    );
  }
  @Post('restock/batches') async createRestockBatch(
    @Req() req: AuthRequest,
    @Body() body: CreateRestockBatchDto,
  ) {
    // 建批/改批/关批=平台动作（restock.manage 平台码，校区授权拿不到）
    this.requirePerm(req, 'restock.manage');
    return ok(await this.service.createRestockBatch(body, req.user.id), '批次已创建');
  }
  @Patch('restock/batches/:id') async updateRestockBatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRestockBatchDto,
  ) {
    this.requirePerm(req, 'restock.manage');
    return ok(await this.service.updateRestockBatch(id, body, req.user.id), '批次已更新');
  }
  @Post('restock/batches/:id/close') async closeRestockBatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.requirePerm(req, 'restock.manage');
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
        this.ctx(req).platform,
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
    this.requirePerm(req, 'restock.order');
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
    this.requirePerm(req, 'restock.order');
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
    this.requirePerm(req, 'restock.order');
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
      await this.service.restockOrders(this.ctx(req).platform, req.user.campusId, {
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
        this.ctx(req).platform,
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
    // 审单=平台动作（restock.manage）
    this.requirePerm(req, 'restock.manage');
    return ok(
      await this.service.auditRestockOrder(id, body, req.user.id),
      body.action === 'confirm'
        ? '已确认并锁定总部仓库存'
        : body.action === 'reject'
          ? '已驳回'
          : '已撤销确认，锁定库存已释放',
    );
  }

  // ==================== 分拨发货（IKFOQ2）：发货/到货/发货单查看 ====================
  /** 总部发货：整单发（锁转实扣），库存不足拦截。 */
  @Post('restock/orders/:id/ship') async shipRestockOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: ShipRestockOrderDto,
  ) {
    // 发货=平台动作（restock.manage）
    this.requirePerm(req, 'restock.manage');
    return ok(await this.service.shipRestockOrder(id, body ?? ({} as ShipRestockOrderDto), req.user.id), '已发货，等待校区确认到货');
  }
  /** 校区确认到货：按发货数全额入账（收货校区本人操作）。 */
  @Post('restock/orders/:id/receipt') async confirmRestockReceipt(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'restock', 'write');
    return ok(
      await this.service.confirmRestockReceipt(id, req.user.id, req.user.campusId),
      '到货已确认，库存已入账',
    );
  }
  @Get('restock/orders/:id/shipment') async restockShipmentDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'restock', 'read');
    return ok(
      await this.service.restockShipmentDetail(
        id,
        this.ctx(req).platform,
        req.user.campusId,
      ),
    );
  }

  // ==================== 总部经营日报（IKFOPR）：发货单实时聚合 ====================
  @Get('reports/hq-daily') async hqDailyReport(
    @Req() req: AuthRequest,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('campusId') campusId?: string,
  ) {
    // 总部日报=平台动作（purchase.read 平台码，校区授权拿不到）
    this.requirePerm(req, 'purchase.read');
    // 缺省=昨日（T+1 口径）
    const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 86400 * 1000)
      .toISOString()
      .slice(0, 10);
    return ok(
      await this.service.hqDailyReport(
        start || yesterday,
        end || yesterday,
        campusId || undefined,
      ),
    );
  }

  // ==================== 校区经营日报（IKFOPS）：C 端订单实时聚合 ====================
  // 平台视角（hq/admin）可跨校区筛选；校区角色锁本校区 + 楼栋筛选
  @Get('reports/campus-daily') async campusDailyReport(
    @Req() req: AuthRequest,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('campusId') campusId?: string,
    @Query('buildingId') buildingId?: string,
  ) {
    this.authorize(req, 'campus-report');
    const hqScope = this.ctx(req).platform;
    if (!hqScope && !req.user.campusId)
      throw new ForbiddenException('账号未绑定校区');
    // 缺省=昨日（T+1 口径）
    const yesterday = new Date(Date.now() + 8 * 3600 * 1000 - 86400 * 1000)
      .toISOString()
      .slice(0, 10);
    return ok(
      await this.service.campusDailyReport(start || yesterday, end || yesterday, {
        campusId: campusId || undefined,
        buildingId: buildingId || undefined,
        hqScope,
        userCampusId: req.user.campusId,
      }),
    );
  }

  // ==================== 营销作战地图（IKFOQ3）：寝室级下单覆盖 ====================
  // 权限复用 buildings 键（admin/operations）；校区跟顶栏上下文，
  // service 校验楼栋归属防串校区
  @Get('battle-map/buildings/:buildingId') async battleMapBuilding(
    @Req() req: AuthRequest,
    @Param('buildingId') buildingId: string,
  ) {
    this.authorize(req, 'buildings');
    return ok(
      await this.service.battleMapBuilding(req.user.campusId, buildingId),
    );
  }

  @Get('battle-map/rooms/:roomId') async battleMapRoom(
    @Req() req: AuthRequest,
    @Param('roomId') roomId: string,
  ) {
    this.authorize(req, 'buildings');
    return ok(await this.service.battleMapRoom(req.user.campusId, roomId));
  }

  // ==================== 采购单（IKFOQ1）：独立板块「采购管理」====================
  // 全链总部动作（hq/admin）：生成聚合/验收入库/关闭重开；权限 purchase section。
  @Get('purchase/orders') async purchaseOrders(@Req() req: AuthRequest) {
    // 采购=平台码（purchase.read/write），校区授权天然拿不到，无需再判平台
    this.requirePerm(req, 'purchase.read');
    return ok(await this.service.purchaseOrders());
  }
  @Get('purchase/orders/:id') async purchaseOrderDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.requirePerm(req, 'purchase.read');
    return ok(await this.service.purchaseOrderDetail(id));
  }
  /** 一键聚合生成（grilling #2）：行=批次全部已确认订货单按商品求和。 */
  @Post('restock/batches/:batchId/purchase-order') async createPurchaseOrder(
    @Req() req: AuthRequest,
    @Param('batchId') batchId: string,
    @Body() body: CreatePurchaseOrderDto,
  ) {
    this.requirePerm(req, 'purchase.write');
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
    this.requirePerm(req, 'purchase.write');
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
    this.requirePerm(req, 'purchase.write');
    return ok(
      await this.service.closePurchaseOrder(id, body, req.user.id),
      '采购单已关闭，欠收作废',
    );
  }
  @Post('purchase/orders/:id/reopen') async reopenPurchaseOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.requirePerm(req, 'purchase.write');
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
    this.requirePerm(req, 'inventory.adjust');
    const campusId = await this.campusScope(req, campus);
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
        await this.service.inventoryTxns(productId, await this.campusScope(req, campus)),
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
          await this.campusScope(req, campus),
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
    return ok(await this.service.orderStatusCounts(await this.campusScope(req, campus)));
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
    this.requirePerm(req, action === 'outbound' ? 'inventory.outbound' : 'orders.write');
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
    return ok(await this.service.userStats(await this.campusScope(req, campus)));
  }
  @Get('users/:id/orders')
  @ApiOperation({ summary: '单个用户订单流水（IKAJSW 详情抽屉）' })
  async userOrders(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'users');
    return ok(await this.service.userOrders(id, await this.campusScope(req)));
  }
  @Get('users/:id/phone')
  @ApiOperation({
    summary: '查看用户明文手机号（列表恒脱敏，按需单查+审计留痕）',
  })
  async revealUserPhone(@Req() req: AuthRequest, @Param('id') id: string) {
    // 敏感分权：明文手机号单列权限码（users.read 只给脱敏视图）
    this.requirePerm(req, 'users.phone.reveal');
    return ok(
      await this.service.revealUserPhone(
        id,
        req.user.id,
        await this.campusScope(req),
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
      await this.service.users(await this.campusScope(req, campus), {
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
    this.requirePerm(req, 'locations.read');
    return ok(await this.service.locations(req.user.campusId));
  }
  @Post('locations')
  async createLocation(
    @Req() req: AuthRequest,
    @Body() body: CreateLocationDto,
  ) {
    this.requirePerm(req, 'locations.write');
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
    this.requirePerm(req, 'locations.write');
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
    this.requirePerm(req, 'locations.write');
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
    // RBAC V1：目标校区必须在授权范围内（修复旧 resolveStaffCampus 只验存在不验授权）
    body.campusId = await this.assertCampusAllowed(req, body.campusId);
    return ok(
      await this.service.createStaff(body, req.user.id, body.campusId),
      '员工已创建',
    );
  }
  @Patch('staff/:id') async updateStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateStaffDto,
  ) {
    this.authorize(req, 'staff', 'write');
    if (body.campusId !== undefined)
      body.campusId = await this.assertCampusAllowed(req, body.campusId);
    return ok(
      await this.service.updateStaff(id, body, req.user.id),
    );
  }
  @Delete('staff/:id') async deleteStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.authorize(req, 'staff', 'write');
    return ok(
      await this.service.deleteStaff(id, req.user.id),
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
    // 本校区配送配置（campuses.config.write 校区码）；校区本体增改走 campuses.manage
    this.requirePerm(req, 'campuses.config.write');
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
    @Query('campus') campus?: string,
  ) {
    this.authorize(req, 'buildings');
    return ok(
      // IKGVOO 员工服务范围：可传目标校区拉对应楼栋（员工建到哪个校区就绑哪个校区的楼），
      // 缺省回落账号绑定校区
      paginate(
        // RBAC V1：目标校区经授权校验（校区级忽略参数恒本校区；平台级验存在）
        await this.service.buildings(
          (await this.campusScope(req, campus)) || req.user.campusId,
        ),
        page,
        pageSize,
        keyword,
      ),
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
    this.requirePerm(req, 'finance.rules.write');
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
    this.requirePerm(req, 'finance.rules.write');
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
    this.requirePerm(req, 'finance.confirm');
    return ok(
      await this.service.confirmSettlement(id, req.user.id, req.user.campusId),
      '账单已确认',
    );
  }
  @Post('settlements/:id/pay') async paySettlement(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    this.requirePerm(req, 'finance.pay');
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
  @ApiOperation({ summary: '新建校区（平台级权限 campuses.manage）' })
  async createCampus(@Req() req: AuthRequest, @Body() body: CreateCampusDto) {
    // 本体增改=平台级动作（campuses.manage 平台码；旧手写 hq/admin 角色判断退役）
    this.requirePerm(req, 'campuses.manage');
    return ok(await this.service.createCampus(body, req.user.id), '校区已创建');
  }
  @Patch('campuses/:id')
  @ApiOperation({ summary: '修改校区信息/启停（平台级权限 campuses.manage）' })
  async updateCampus(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCampusDto,
  ) {
    this.requirePerm(req, 'campuses.manage');
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
        await this.service.auditLogs(await this.campusScope(req, campus)),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  /* ---------- 后台账号管理（IK9KWO → RBAC V1）：仅超管（rbac.accounts.* 平台码） ---------- */
  @Get('accounts')
  @ApiOperation({
    summary: '后台账号列表（全量，附状态与 RBAC 角色授权明细）',
  })
  async accounts(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    this.requirePerm(req, 'rbac.accounts.read');
    return ok(
      paginate(
        await this.service.accounts(),
        page,
        pageSize,
        keyword,
      ),
    );
  }
  @Post('accounts')
  @ApiOperation({
    summary: '新建后台账号（含初始授权 grants=[{roleCode,scope,campusId}]）',
  })
  async createAccount(@Req() req: AuthRequest, @Body() body: CreateAccountDto) {
    this.requirePerm(req, 'rbac.accounts.write');
    const created = await this.service.createAccount(body, req.user.id);
    if (body.grants?.length)
      await this.rbac.setAccountRoles(
        { id: req.user.id, username: this.ctx(req).username },
        created.id,
        body.grants,
      );
    return ok(created, '账号已创建');
  }
  @Patch('accounts/:id')
  @ApiOperation({
    summary: '改昵称/重置密码/停启用/全量重设授权（rbac.accounts.write）',
  })
  async updateAccount(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAccountDto,
  ) {
    this.requirePerm(req, 'rbac.accounts.write');
    const actor = { id: req.user.id, username: this.ctx(req).username };
    let after: { id: string; username: string; nickname?: string; status?: string } | null = null;
    if (body.nickname !== undefined || body.password !== undefined) {
      after = await this.service.updateAccount(id, { nickname: body.nickname }, req.user.id);
    }
    if (body.password) {
      await this.rbac.resetAccountPassword(actor, id, body.password);
      after = { ...(after ?? { id, username: '' }), id };
    }
    if (body.status) {
      await this.rbac.setAccountStatus(actor, id, body.status);
    }
    if (body.grants) {
      await this.rbac.setAccountRoles(actor, id, body.grants);
    }
    if (!after && !body.status && !body.grants)
      throw new BadRequestException('没有可更新的字段');
    return ok({ id }, '账号已更新');
  }
  @Delete('accounts/:id')
  @ApiOperation({ summary: '删除后台账号；不可删自己/最后一个有效超管' })
  async deleteAccount(@Req() req: AuthRequest, @Param('id') id: string) {
    this.requirePerm(req, 'rbac.accounts.write');
    return ok(
      await this.service.deleteAccount(id, req.user.id),
      '账号已删除',
    );
  }

  /* ---------- RBAC V1（2026-09-19）：有效权限 / 角色管理 / 权限目录 / 审计 ---------- */
  @Get('rbac/me')
  @ApiOperation({
    summary: '当前账号有效权限（角色来源+权限码+可切校区+授权版本）',
    description: '前端菜单/路由/按钮统一以此为准；切校区后重新拉取。',
  })
  async rbacMe(@Req() req: AuthRequest) {
    // 任意后台账号可读自己的上下文（不设权限码——这就是权限读取入口）
    const ctx = this.ctx(req);
    const account = await this.service.findAccount(ctx.accountId);
    if (!account) throw new ForbiddenException('账号不存在');
    return ok(await this.rbac.buildMeResponse(account));
  }
  @Get('rbac/permissions')
  @ApiOperation({ summary: '权限目录（代码登记只读同步；分组+含义+范围）' })
  async rbacPermissions(@Req() req: AuthRequest) {
    this.requirePerm(req, 'rbac.permissions.read');
    return ok(await this.rbac.listPermissions());
  }
  @Get('rbac/menus')
  @ApiOperation({
    summary: '菜单目录（两层模型第一层：key/名称/分组）',
    description: '静态非敏感目录：角色勾选页与侧栏名称渲染共用（名称以库为准，改菜单名不发前端版）。登录即可读，不设权限码。',
  })
  async rbacMenus() {
    return ok(MENU_CATALOG);
  }
  @Get('rbac/roles')
  @ApiOperation({ summary: '角色列表（含权限集、可见菜单与关联账号数）' })
  async rbacRoles(@Req() req: AuthRequest) {
    this.requirePerm(req, 'rbac.roles.read');
    const roles = await this.rbac.listRoles();
    return ok(
      roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        remark: r.remark,
        status: r.status,
        builtin: r.builtin,
        accountCount: r._count.accounts,
        permissions: r.permissions.map((p) => p.permission.code),
        menus: r.menus ?? [],
      })),
    );
  }
  @Post('rbac/roles')
  @ApiOperation({ summary: '新建角色（code+name+菜单+权限码集）' })
  async rbacCreateRole(
    @Req() req: AuthRequest,
    @Body() body: { code: string; name: string; remark?: string; permissionCodes?: string[]; menus?: string[] },
  ) {
    this.requirePerm(req, 'rbac.roles.write');
    const role = await this.rbac.createRole(
      { username: this.ctx(req).username },
      { code: body.code, name: body.name, remark: body.remark, permissionCodes: body.permissionCodes ?? [], menus: body.menus },
    );
    return ok({ id: role.id, code: role.code }, '角色已创建');
  }
  @Patch('rbac/roles/:id')
  @ApiOperation({ summary: '编辑角色（名称/备注/启停/菜单/权限集全量重设；内置超管不可编辑）' })
  async rbacUpdateRole(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { name?: string; remark?: string; status?: 'active' | 'disabled'; permissionCodes?: string[]; menus?: string[] },
  ) {
    this.requirePerm(req, 'rbac.roles.write');
    await this.rbac.updateRole({ username: this.ctx(req).username }, id, body);
    return ok({ id }, '角色已更新');
  }
  @Delete('rbac/roles/:id')
  @ApiOperation({ summary: '删除角色（有账号引用须先撤权；内置不可删）' })
  async rbacDeleteRole(@Req() req: AuthRequest, @Param('id') id: string) {
    this.requirePerm(req, 'rbac.roles.write');
    await this.rbac.deleteRole({ username: this.ctx(req).username }, id);
    return ok({ id }, '角色已删除');
  }
  @Get('rbac/audit')
  @ApiOperation({ summary: '权限审计（授权/撤权/角色变更/敏感访问）' })
  async rbacAudit(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    this.requirePerm(req, 'rbac.audit.read');
    const rows = await this.rbac.listRbacAudit(
      Math.max(1, Number(page) || 1),
      Math.min(100, Math.max(1, Number(pageSize) || 50)),
    );
    return ok({ items: rows, total: rows.length });
  }
  @Get('rbac/accounts/:id/preview')
  @ApiOperation({ summary: '账号有效权限预览（账号管理抽屉用）' })
  async rbacPreview(@Req() req: AuthRequest, @Param('id') id: string) {
    this.requirePerm(req, 'rbac.accounts.read');
    return ok(await this.rbac.previewAccount(id));
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
          await this.campusScope(req, campus),
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
      await this.service.recruitStatusCounts(await this.campusScope(req, campus)),
    );
  }
  /** 资料补录（IKEAGE → RBAC V1 字段级分权）：身份证补录与运营备注各自独立权限码。 */
  @Patch('recruit-applications/:id')
  async updateRecruitApplication(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRecruitApplicationDto,
  ) {
    const touchingIdcard =
      body.idCardNo !== undefined || body.idCardImages !== undefined;
    const touchingNote = body.staffRemark !== undefined;
    if (touchingIdcard) this.requirePerm(req, 'recruit.idcard.write');
    if (touchingNote) this.requirePerm(req, 'recruit.note');
    if (!touchingIdcard && !touchingNote) this.requirePerm(req, 'recruit.note');
    const updated = await this.service.updateRecruitApplication(
      id,
      body,
      req.user.id,
      await this.campusScope(req),
    );
    // 响应白名单：证件字段不回显（刚写入的内容无需回传）；备注仅对持有者回显
    const { idCardNo, idCardImages, ...safe } = updated as Record<string, unknown>;
    void idCardNo;
    void idCardImages;
    if (!this.hasPerm(req, 'recruit.note')) delete (safe as Record<string, unknown>).staffRemark;
    return ok(safe);
  }
  /** 身份证/运营备注专用读取（RBAC V1）：recruit.idcard.read 或 recruit.note
   *  持有者可用；身份证照片回 5 分钟签名 URL；每次访问落敏感审计。 */
  @Get('recruit-applications/:id/idcard')
  @ApiOperation({ summary: '读取候选人身份证与运营备注（权限+审计留痕）' })
  async recruitIdcard(@Req() req: AuthRequest, @Param('id') id: string) {
    const canIdcard = this.hasPerm(req, 'recruit.idcard.read');
    const canNote = this.hasPerm(req, 'recruit.note');
    if (!canIdcard && !canNote)
      throw new ForbiddenException('当前账号无该操作权限');
    const data = await this.service.recruitIdcard(
      id,
      await this.campusScope(req),
    );
    if (!canIdcard) {
      (data as Record<string, unknown>).idCardNo = '';
      (data as Record<string, unknown>).idCardImages = [];
    }
    if (!canNote) (data as Record<string, unknown>).staffRemark = '';
    await this.rbac.auditSensitiveAccess(
      this.ctx(req).username,
      canIdcard ? 'rbac.sensitive.idcard-read' : 'rbac.sensitive.remark-read',
      id,
      this.ctx(req).campusId,
    );
    return ok(data);
  }
  /** 待联系 → 面试中（IKEAGE）。 */
  @Post('recruit-applications/:id/transition')
  async recruitTransition(@Req() req: AuthRequest, @Param('id') id: string) {
    this.requirePerm(req, 'recruit.interview');
    return ok(
      await this.service.recruitTransition(
        id,
        req.user.id,
        await this.campusScope(req),
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
    this.requirePerm(req, 'recruit.reject');
    return ok(
      await this.service.recruitReject(
        id,
        body.reason,
        req.user.id,
        await this.campusScope(req),
      ),
      '已拒绝',
    );
  }
  /** 审批通过（IKEAGE）：事务创建实习楼长（工号 IBM-xxx 自动生成）并关联。 */
  @Post('recruit-applications/:id/approve')
  async recruitApprove(@Req() req: AuthRequest, @Param('id') id: string) {
    this.requirePerm(req, 'recruit.approve');
    return ok(
      await this.service.recruitApprove(
        id,
        req.user.id,
        await this.campusScope(req),
      ),
      '已通过并创建实习楼长',
    );
  }
}
