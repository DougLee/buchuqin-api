import {
  Body,
  Controller,
  Delete,
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { OFFICIAL_CAMPUS_ID } from '../common/campus';
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
  BarcodeDto,
  BatchProductStatusDto,
  BindPrinterDto,
  CreateAccountDto,
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
  UpdateAccountDto,
  UpdateBannerDto,
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
  private productCampus(req: AuthRequest, view?: string): string {
    if (req.user.role === 'hq') return OFFICIAL_CAMPUS_ID;
    if (req.user.role === 'admin') {
      return view === 'campus' ? req.user.campusId : OFFICIAL_CAMPUS_ID;
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
  ) {
    this.authorize(req, 'products');
    return ok(
      paginate(
        await this.service.products(
          this.productCampus(req, view),
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
  /** 官方库浏览（IKAJSO 导入弹窗）：校区角色只读官方库行，用于搜索+多选导入。 */
  @Get('products/official-library')
  @ApiOperation({
    summary: '官方商品库列表（校区导入弹窗用，只读；IKC1AB 仅含总部放行的可售商品）',
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
        // IKC1AB：导入候选池只见总部放行（可售）的商品
        await this.service.products(OFFICIAL_CAMPUS_ID, ['on-sale']),
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
  ) {
    this.authorize(req, 'marketing');
    return ok(
      paginate(
        await this.service.promotions(req.user.campusId, state),
        page,
        pageSize,
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
    @Body() body: BarcodeDto,
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
  /** 校区从官方库导入商品（IKAJSO）：本地售价/上下架/库存自管。 */
  @Post('products/import') async importProducts(
    @Req() req: AuthRequest,
    @Body() body: ImportProductsDto,
  ) {
    this.authorize(req, 'products', 'write');
    if (req.user.role === 'hq')
      throw new ForbiddenException('总部账号请在官方商品库直接维护商品');
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
  ) {
    this.authorize(req, 'inventory');
    return ok(
      paginate(
        await this.service.inventory(
          req.user.campusId,
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
}
