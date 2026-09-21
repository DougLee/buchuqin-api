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
import { RbacService, matchUrl } from './rbac/rbac.service';
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
  UpdateProductPriceDto,
  UpdateRecruitIdcardDto,
  CreateAdminMenuDto,
  UpdateAdminMenuDto,
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
// RBAC 蛋词体系（2026-09-19 拍板 B）：AdminAuthGuard = JWT 验签 + AdminAccount
// 实时校验（状态/会话版本）+ 有效权限装载（request.rbac）+ **URL 判权**——
// method+path 与角色菜单 perms 模式（'METHOD /admin/x/:seg'）匹配，默认拒绝；
// 白名单（rbac/me、rbac/permmenu）登录即可读。控制器不再按权限码
// 判权；仅字段级分权（改价/身份证补录）在端点内用 requireUrl 复检。
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
  /** 字段级分权复检：按 URL 模式判权（超管通配）；未持有抛 403 */
  private requireUrl(req: AuthRequest, method: string, path: string) {
    if (!this.rbac.allow(this.ctx(req), method, path))
      throw new ForbiddenException('当前账号无该操作权限');
  }
  /** 字段级分权复检（非抛出版）：是否持有 URL 模式 */
  private allowUrl(req: AuthRequest, method: string, path: string): boolean {
    const ctx = (req as { rbac?: RbacContext }).rbac;
    return !!ctx && this.rbac.allow(ctx, method, path);
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
    if (!ctx.platform && target !== ctx.campusId)
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
    return ok(await this.service.categories(this.ctx(req).platform ? undefined : this.ctx(req).campusId));
  }
  @Post('categories') async createCategory(
    @Req() req: AuthRequest,
    @Body() body: CreateCategoryDto,
  ) {
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
    @Query('categoryId') categoryId?: string,
  ) {
    return ok(
      paginate(
        await this.service.promotions(req.user.campusId, state, categoryId),
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
    return ok(await this.service.featured(req.user.campusId));
  }
  @Put('featured')
  @ApiOperation({
    summary: '保存推荐位（全量有序商品 id，事务清位重设；越界 id 静默剔除）',
  })
  async saveFeatured(@Req() req: AuthRequest, @Body() body: SaveFeaturedDto) {
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
    return ok(
      await this.service.updatePromotion(id, body, req.user.id, req.user.campusId),
    );
  }
  @Post('products/barcode/lookup') async lookupBarcode(
    @Req() req: AuthRequest,
    @Body() body: LookupBarcodeDto,
    @Query('view') view?: string,
  ) {
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
    // guard 已按 PATCH /admin/products/:id 模式放行（官方库=official.write /
    // 本校区=products.write）；字段级分权复检：本校区视角夹带价格字段须另持
    // products.price 模式（PATCH /admin/products/:id/price，蛋词拆分端点同源）
    if (body.stock !== undefined) {
      this.requireUrl(req, 'POST', '/admin/inventory/stocktake');
      const ctx = this.ctx(req);
      if (!ctx.super && this.productCampus(req, view) !== ctx.campusId &&
          !matchUrl(ctx.platformPatterns ?? [], 'POST', '/admin/inventory/stocktake'))
        throw new ForbiddenException('无该校区库存调整权限');
    }
    const officialUpdate = this.productCampus(req, view) === OFFICIAL_CAMPUS_ID;
    if (!officialUpdate) {
      if (body.status !== undefined)
        this.requireUrl(req, 'POST', '/admin/products/batch-status');
      const PRICE_FIELDS = ['price', 'originalPrice', 'costPrice', 'wholesalePrice'];
      const touchingPrice = PRICE_FIELDS.some(
        (f) => (body as Record<string, unknown>)[f] !== undefined,
      );
      if (touchingPrice)
        this.requireUrl(req, 'PATCH', '/admin/products/:id/price');
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
  /** 商品改价专用端点（蛋词体系字段级分权实体化）：只收价格字段（分整数），
   *  判权=按钮模式 PATCH /admin/products/:id/price（products.price 节点）。 */
  @Patch('products/:id/price')
  @ApiOperation({ summary: '商品改价（price/originalPrice/costPrice/wholesalePrice，分）' })
  async updateProductPrice(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateProductPriceDto,
    @Query('view') view?: string,
  ) {
    const PRICE_FIELDS = ['price', 'originalPrice', 'costPrice', 'wholesalePrice'];
    const touching = PRICE_FIELDS.some(
      (f) => (body as Record<string, unknown>)[f] !== undefined,
    );
    if (!touching) throw new BadRequestException('至少提交一个价格字段');
    return ok(
      await this.service.updateProduct(
        id,
        body as UpdateProductDto,
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
    // 直接入库=平台口径（IKD6FJ）：模式 POST /admin/inventory/stock-in 仅
    // inventory.inbound 节点持有（校区角色无此按钮，guard 一律 403）
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
    return ok(
      await this.service.restockBatches(this.ctx(req).platform, req.user.campusId),
    );
  }
  @Post('restock/batches') async createRestockBatch(
    @Req() req: AuthRequest,
    @Body() body: CreateRestockBatchDto,
  ) {
    // 建批/改批/关批=平台动作（restock.manage 平台码，校区授权拿不到）
    return ok(await this.service.createRestockBatch(body, req.user.id), '批次已创建');
  }
  @Patch('restock/batches/:id') async updateRestockBatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRestockBatchDto,
  ) {
    return ok(await this.service.updateRestockBatch(id, body, req.user.id), '批次已更新');
  }
  @Post('restock/batches/:id/close') async closeRestockBatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.closeRestockBatch(id, req.user.id), '批次已关闭');
  }
  /** 批次详情：总部看全校区单，校区只看本校区单。 */
  @Get('restock/batches/:id') async restockBatchDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
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
    return ok(await this.service.shipRestockOrder(id, body ?? ({} as ShipRestockOrderDto), req.user.id), '已发货，等待校区确认到货');
  }
  /** 校区确认到货：按发货数全额入账（收货校区本人操作）。 */
  @Post('restock/orders/:id/receipt') async confirmRestockReceipt(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      await this.service.confirmRestockReceipt(id, req.user.id, req.user.campusId),
      '到货已确认，库存已入账',
    );
  }
  @Get('restock/orders/:id/shipment') async restockShipmentDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
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
    return ok(
      await this.service.battleMapBuilding(req.user.campusId, buildingId),
    );
  }

  @Get('battle-map/rooms/:roomId') async battleMapRoom(
    @Req() req: AuthRequest,
    @Param('roomId') roomId: string,
  ) {
    return ok(await this.service.battleMapRoom(req.user.campusId, roomId));
  }

  // ==================== 采购单（IKFOQ1）：独立板块「采购管理」====================
  // 全链总部动作（hq/admin）：生成聚合/验收入库/关闭重开；权限 purchase section。
  @Get('purchase/orders') async purchaseOrders(@Req() req: AuthRequest) {
    // 采购=平台码（purchase.read/write），校区授权天然拿不到，无需再判平台
    return ok(await this.service.purchaseOrders());
  }
  @Get('purchase/orders/:id') async purchaseOrderDetail(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.purchaseOrderDetail(id));
  }
  /** 一键聚合生成（grilling #2）：行=批次全部已确认订货单按商品求和。 */
  @Post('restock/batches/:batchId/purchase-order') async createPurchaseOrder(
    @Req() req: AuthRequest,
    @Param('batchId') batchId: string,
    @Body() body: CreatePurchaseOrderDto,
  ) {
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
    return ok(
      await this.service.closePurchaseOrder(id, body, req.user.id),
      '采购单已关闭，欠收作废',
    );
  }
  @Post('purchase/orders/:id/reopen') async reopenPurchaseOrder(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
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
    return ok(await this.service.orderStatusCounts(await this.campusScope(req, campus)));
  }
  /** 新订单水位线（IKHFWV）：今日已支付累计数+最新单摘要——前端 30s 轮询提醒 */
  @Get('orders/new-order-watch')
  @ApiOperation({ summary: '新订单水位线（30s 轮询用；累计口径防漏报）' })
  async newOrderWatch(
    @Req() req: AuthRequest,
    @Query('campus') campus?: string,
  ) {
    return ok(await this.service.newOrderWatch(await this.campusScope(req, campus)));
  }
  @Get('orders/:id') async order(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.order(id, req.user.campusId));
  }
  @Post('orders/:id/actions/:action') async orderAction(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    // 仓库出库（IKA0UQ）落在库存板块：仓储角色对 orders 只读但可出库。
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
    return ok(
      await this.service.reprintReceipt(id, req.user.id, req.user.campusId),
      '小票已发送打印',
    );
  }
  /* ---------- 校区打印机绑定（IKBW0Q）：校区自主绑定/管理小票机 ---------- */
  @Get('printers')
  @ApiOperation({ summary: '本校区打印机列表（一校区一台，IKBW0Q）' })
  async printers(@Req() req: AuthRequest) {
    return ok(await this.service.printers(req.user.campusId));
  }
  @Post('printers')
  @ApiOperation({ summary: '绑定/换绑打印机（SN+KEY，先绑芯烨云账号再落库）' })
  async bindPrinter(
    @Req() req: AuthRequest,
    @Body() body: BindPrinterDto,
  ) {
    return ok(
      await this.service.bindPrinter(body, req.user.id, req.user.campusId),
      '打印机已绑定',
    );
  }
  @Delete('printers/:id')
  @ApiOperation({ summary: '解绑打印机（删本校区绑定记录）' })
  async unbindPrinter(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(
      await this.service.unbindPrinter(id, req.user.id, req.user.campusId),
      '打印机已解绑',
    );
  }
  @Post('printers/:id/test-print')
  @ApiOperation({ summary: '测试打印（连通性验证，出一张测试小票）' })
  async testPrintPrinter(@Req() req: AuthRequest, @Param('id') id: string) {
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
    return ok(await this.service.userStats(await this.campusScope(req, campus)));
  }
  @Get('users/:id/orders')
  @ApiOperation({ summary: '单个用户订单流水（IKAJSW 详情抽屉）' })
  async userOrders(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.userOrders(id, await this.campusScope(req)));
  }
  @Get('users/:id/phone')
  @ApiOperation({
    summary: '查看用户明文手机号（列表恒脱敏，按需单查+审计留痕）',
  })
  async revealUserPhone(@Req() req: AuthRequest, @Param('id') id: string) {
    // 敏感分权：明文手机号单列权限码（users.read 只给脱敏视图）
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
    return ok(await this.service.wechatGroups(req.user.campusId));
  }
  @Post('wechat-groups')
  @ApiOperation({ summary: '新增/替换楼栋群或校级大群二维码' })
  async upsertWechatGroup(
    @Req() req: AuthRequest,
    @Body() body: UpsertWechatGroupDto,
  ) {
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
    return ok(await this.service.wheel(req.user.campusId));
  }
  @Put('wheel')
  @ApiOperation({ summary: '保存转盘配置（8 奖位 + 活动开关）' })
  async upsertWheel(
    @Req() req: AuthRequest,
    @Body() body: UpsertWheelDto,
  ) {
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
    return ok(
      await this.service.deleteWechatGroup(id, req.user.id, req.user.campusId),
      '群码已删除',
    );
  }
  /* ---------- 库位管理（IKA0VG）：随库存板块权限走 ---------- */
  @Get('locations') async locations(@Req() req: AuthRequest) {
    return ok(await this.service.locations(req.user.campusId));
  }
  @Post('locations')
  async createLocation(
    @Req() req: AuthRequest,
    @Body() body: CreateLocationDto,
  ) {
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
    if (body.campusId !== undefined)
      body.campusId = await this.assertCampusAllowed(req, body.campusId);
    return ok(
      await this.service.updateStaff(id, body, req.user.id, this.ctx(req).platform ? undefined : this.ctx(req).campusId),
    );
  }
  @Delete('staff/:id') async deleteStaff(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      await this.service.deleteStaff(id, req.user.id, this.ctx(req).platform ? undefined : this.ctx(req).campusId),
      '员工已删除',
    );
  }
  @Get('delivery-config')
  @ApiOperation({
    summary: '配送费/起送门槛配置（IK9SO6，单位分）',
    description: '即时达/次日达配送费与起送门槛，business 端 cart/checkout 按此生效。',
  })
  async deliveryConfig(@Req() req: AuthRequest) {
    return ok(await this.service.deliveryConfig(req.user.campusId));
  }
  @Patch('delivery-config')
  async updateDeliveryConfig(
    @Req() req: AuthRequest,
    @Body() body: UpdateDeliveryConfigDto,
  ) {
    // 本校区配送配置（campuses.config.write 校区码）；校区本体增改走 campuses.manage
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
    return ok(
      paginate(await this.service.rooms(id, req.user.campusId), page, pageSize, keyword),
    );
  }
  @Post('buildings/:id/rooms') async createRoom(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: CreateRoomDto,
  ) {
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
    return ok(
      await this.service.confirmSettlement(id, req.user.id, req.user.campusId),
      '账单已确认',
    );
  }
  @Post('settlements/:id/pay') async paySettlement(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(
      await this.service.paySettlement(id, req.user.id, req.user.campusId),
      '账单已支付',
    );
  }
  @Get('campuses') async campuses(
    @Req() req: AuthRequest,
    @Query('keyword') keyword?: string,
  ) {
    return ok(filterByKeyword(await this.service.campuses(this.ctx(req).platform ? undefined : this.ctx(req).campusId), keyword));
  }
  /* ---------- 校区本体管理（IKAJSL）：新校区接入 ---------- */
  @Post('campuses')
  @ApiOperation({ summary: '新建校区（平台级权限 campuses.manage）' })
  async createCampus(@Req() req: AuthRequest, @Body() body: CreateCampusDto) {
    // 本体增改=平台级动作（campuses.manage 平台码；旧手写 hq/admin 角色判断退役）
    return ok(await this.service.createCampus(body, req.user.id), '校区已创建');
  }
  @Patch('campuses/:id')
  @ApiOperation({ summary: '修改校区信息/启停（平台级权限 campuses.manage）' })
  async updateCampus(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateCampusDto,
  ) {
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
    return ok(
      await this.service.updateCoupon(id, body, req.user.id, req.user.campusId),
    );
  }
  /** 优惠券删除（IKDES1）：仅限从未发放；已发记录拒绝（走暂停） */
  @Delete('coupons/:id') async deleteCoupon(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
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
    const created = await this.rbac.createAccount(
      { id: req.user.id, username: this.ctx(req).username }, body,
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
    const actor = { id: req.user.id, username: this.ctx(req).username };
    await this.rbac.updateAccount(actor, id, body);
    return ok({ id }, '账号已更新');
  }
  @Delete('accounts/:id')
  @ApiOperation({ summary: '删除后台账号；不可删自己/最后一个有效超管' })
  async deleteAccount(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(
      await this.rbac.deleteAccount({ id: req.user.id, username: this.ctx(req).username }, id),
      '账号已删除',
    );
  }

  /* ---------- RBAC（蛋词体系 2026-09-19）：permmenu / 菜单管理 / 角色管理 / 审计 ----------
   * rbac/me、rbac/permmenu 为守卫白名单（登录即可读）；
   * 其余端点判权=URL 模式（registry rbac-roles/accounts/rbac-audit 等节点）。 */
  @Get('rbac/me')
  @ApiOperation({
    summary: '当前账号有效权限（perms 模式串+菜单树+可切校区+授权版本）',
    description: '前端菜单/路由/按钮统一以此为准；切校区后重新拉取。守卫白名单：登录即可读。',
  })
  async rbacMe(@Req() req: AuthRequest) {
    const ctx = this.ctx(req);
    const account = await this.service.findAccount(ctx.accountId);
    if (!account) throw new ForbiddenException('账号不存在');
    return ok(await this.rbac.buildMeResponse(account));
  }
  /** 蛋词同款 permmenu 契约：{perms, menus, roles, ...}——与 rbac/me 同源负载，
   *  供前端按蛋词风格对接（登录可读=白名单）。 */
  @Get('rbac/permmenu')
  @ApiOperation({
    summary: '当前账号 perms+menus（蛋词契约；超管 perms=["*"]）',
    description: '守卫白名单：登录即可读。menus 为树扁平行（parentId 输出父节点 code），前端按 parentId 组树。',
  })
  async rbacPermmenu(@Req() req: AuthRequest) {
    const ctx = this.ctx(req);
    const account = await this.service.findAccount(ctx.accountId);
    if (!account) throw new ForbiddenException('账号不存在');
    return ok(await this.rbac.buildMeResponse(account));
  }
  @Get('rbac/catalog')
  rbacCatalog() { return ok(this.rbac.catalog()); }

  @Get('rbac/permissions')
  @ApiOperation({ summary: '权限目录（type=2 按钮行：code/name/perms 模式，只读）' })
  async rbacPermissions(@Req() req: AuthRequest) {
    return ok(await this.rbac.listPermissions());
  }
  @Get('rbac/menus')
  @ApiOperation({
    summary: '菜单树目录（扁平行：code/parentId/id/name/type/perms/path/icon/orderNum/isShow）',
    description: '超级管理员配置角色和菜单时读取；导航读取 permmenu。',
  })
  async rbacMenus() {
    return ok(await this.rbac.listMenus());
  }
  /* ---------- 菜单管理（自建节点；判权=rbac.menus.write 按钮模式） ---------- */
  @Post('rbac/menus')
  @ApiOperation({ summary: '建自建菜单节点（builtin=false；code 后端生成）' })
  async rbacCreateMenu(
    @Req() req: AuthRequest,
    @Body() body: CreateAdminMenuDto,
  ) {
    const menu = await this.rbac.createMenu(
      { username: this.ctx(req).username },
      body,
    );
    return ok({ id: menu.id, code: menu.code }, '菜单节点已创建');
  }
  @Patch('rbac/menus/:id')
  @ApiOperation({
    summary: '修改菜单节点的结构、注册视图、接口权限与显示配置',
  })
  async rbacUpdateMenu(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAdminMenuDto,
  ) {
    const menu = await this.rbac.updateMenu(
      { username: this.ctx(req).username },
      id,
      body,
    );
    return ok({ id: menu.id, code: menu.code }, '菜单节点已更新');
  }
  @Delete('rbac/menus/:id')
  @ApiOperation({
    summary: '删自建菜单节点（builtin 拒绝；子树递归删非 builtin；role_menu 引用级联清）',
  })
  async rbacDeleteMenu(@Req() req: AuthRequest, @Param('id') id: string) {
    return ok(
      await this.rbac.deleteMenu({ username: this.ctx(req).username }, id),
      '菜单节点已删除',
    );
  }
  @Get('rbac/roles')
  @ApiOperation({ summary: '角色列表（含勾选菜单节点 code 集与关联账号数）' })
  async rbacRoles(@Req() req: AuthRequest) {
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
        menuCodes: r.adminRoleMenus.map((m) => m.menu.code),
      })),
    );
  }
  @Post('rbac/roles')
  @ApiOperation({ summary: '新建角色（code+name+勾选菜单节点 code 集）' })
  async rbacCreateRole(
    @Req() req: AuthRequest,
    @Body() body: { code: string; name: string; remark?: string; menuCodes?: string[] },
  ) {
    if (!body.code?.trim() || !body.name?.trim())
      throw new BadRequestException('角色编码与名称必填');
    const role = await this.rbac.createRole(
      { username: this.ctx(req).username },
      { code: body.code, name: body.name, remark: body.remark, menuCodes: body.menuCodes ?? [] },
    );
    return ok({ id: role.id, code: role.code }, '角色已创建');
  }
  @Patch('rbac/roles/:id')
  @ApiOperation({ summary: '编辑角色（名称/备注/启停/勾选菜单全量重设；内置超管不可编辑）' })
  async rbacUpdateRole(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { name?: string; remark?: string; status?: 'active' | 'disabled'; menuCodes?: string[] },
  ) {
    await this.rbac.updateRole({ username: this.ctx(req).username }, id, body);
    return ok({ id }, '角色已更新');
  }
  @Delete('rbac/roles/:id')
  @ApiOperation({ summary: '删除角色（有账号引用须先撤权；内置不可删）' })
  async rbacDeleteRole(@Req() req: AuthRequest, @Param('id') id: string) {
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
    const rows = await this.rbac.listRbacAudit(
      Math.max(1, Number(page) || 1),
      Math.min(100, Math.max(1, Number(pageSize) || 50)),
    );
    return ok({ items: rows, total: rows.length });
  }
  @Get('rbac/accounts/:id/preview')
  @ApiOperation({ summary: '账号有效权限预览（账号管理抽屉用）' })
  async rbacPreview(@Req() req: AuthRequest, @Param('id') id: string) {
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
    return ok(
      await this.service.recruitStatusCounts(await this.campusScope(req, campus)),
    );
  }
  /** 资料补录（IKEAGE → 蛋词字段级分权）：guard 已按 PATCH /admin/recruit-applications/:id
   *  模式（recruit.note 节点）放行；端点内复检——夹带身份证字段须另持
   *  POST /admin/recruit-applications/:id/idcard 模式（recruit.idcard.write）。 */
  @Patch('recruit-applications/:id')
  async updateRecruitApplication(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRecruitApplicationDto,
  ) {
    const touchingIdcard =
      body.idCardNo !== undefined || body.idCardImages !== undefined;
    const touchingNote = body.staffRemark !== undefined;
    if (touchingIdcard)
      this.requireUrl(req, 'POST', '/admin/recruit-applications/:id/idcard');
    if (touchingNote || !touchingIdcard)
      this.requireUrl(req, 'PATCH', '/admin/recruit-applications/:id');
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
    if (!this.allowUrl(req, 'PATCH', '/admin/recruit-applications/:id'))
      delete (safe as Record<string, unknown>).staffRemark;
    return ok(safe);
  }
  /** 身份证补录专用端点（蛋词字段级分权实体化）：判权=按钮模式
   *  POST /admin/recruit-applications/:id/idcard（recruit.idcard.write 节点）。 */
  @Post('recruit-applications/:id/idcard')
  @ApiOperation({ summary: '补录候选人身份证号/照片（响应脱敏同 PATCH）' })
  async updateRecruitIdcard(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateRecruitIdcardDto,
  ) {
    if (body.idCardNo === undefined && body.idCardImages === undefined)
      throw new BadRequestException('至少提交一个证件字段');
    const updated = await this.service.updateRecruitApplication(
      id,
      { idCardNo: body.idCardNo, idCardImages: body.idCardImages },
      req.user.id,
      await this.campusScope(req),
    );
    // 响应白名单：证件字段不回显
    const { idCardNo, idCardImages, staffRemark, ...safe } = updated as Record<string, unknown>;
    void idCardNo;
    void idCardImages;
    void staffRemark;
    return ok(safe);
  }
  /** 身份证/运营备注专用读取（蛋词体系）：判权=GET .../:id/idcard 模式
   *  （recruit.idcard.read 节点）；身份证照片回 5 分钟签名 URL；每次访问落敏感审计。
   *  行为变化（2026-09-19）：纯备注角色（recruit.note）不再能经本端点读备注——
   *  备注回显保留在 PATCH 响应中。 */
  @Get('recruit-applications/:id/idcard')
  @ApiOperation({ summary: '读取候选人身份证与运营备注（权限+审计留痕）' })
  async recruitIdcard(@Req() req: AuthRequest, @Param('id') id: string) {
    const data = await this.service.recruitIdcard(
      id,
      await this.campusScope(req),
    );
    // 备注仅对 note 模式持有者回显（证件字段已由 guard 的 idcard.read 模式把关）
    if (!this.allowUrl(req, 'PATCH', '/admin/recruit-applications/:id'))
      (data as Record<string, unknown>).staffRemark = '';
    await this.rbac.auditSensitiveAccess(
      this.ctx(req).username,
      'rbac.sensitive.idcard-read',
      id,
      this.ctx(req).campusId,
    );
    return ok(data);
  }
  /** 待联系 → 面试中（IKEAGE）。 */
  @Post('recruit-applications/:id/transition')
  async recruitTransition(@Req() req: AuthRequest, @Param('id') id: string) {
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
