import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** 条码选填（IKFQQ0）：空/缺省落 null（schema String?），填了才校验 8-14 位数字；
 *  空串在 Transform 归一为 undefined，避免库内存空串撞复合唯一索引。 */
export class BarcodeDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsString()
  @Matches(/^\d{8,14}$/, { message: '条码必须是 8-14 位数字' })
  barcode?: string;
}

/** 条码查询（录入弹窗带价查资料）必须有条码，不参与选填化（IKFQQ0）。 */
export class LookupBarcodeDto {
  @IsString()
  @Matches(/^\d{8,14}$/, { message: '条码必须是 8-14 位数字' })
  barcode!: string;
}

/** 校区从官方商品库导入（IKAJSO）：官方库商品 id 数组，批量多选。 */
export class ImportProductsDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  productIds!: string[];
}

export class CreateProductDto extends BarcodeDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @IsString() categoryId!: string;
  /** IKC1AC：官方行=批发价格，校区行=实际售价。 */
  @Type(() => Number) @IsNumber() @Min(0) price!: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) originalPrice?: number;
  /** 进货价（IKC1AC）：仅官方库建档接受，校区出口一律剔除。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) costPrice?: number;
  /** 批发价格（IKC1AC）：仅官方库建档接受，缺省取 price。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) wholesalePrice?: number;
  @Type(() => Number) @IsInt() @Min(0) stock!: number;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() image?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) weight?: number;
  /** 详情多图（IK9SNS）：COS URL 数组，顺序即详情页轮播顺序。 */
  @IsOptional()
  @IsArray()
  @Matches(/^https?:\/\//, {
    each: true,
    message: '图片地址必须是 http(s) URL',
  })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(9)
  images?: string[];
  /** 库位（IK9U40 / IKA0VG）：库位管理字典里的区域名。 */
  @IsOptional() @IsString() @MaxLength(20) location?: string;
  /** 库位编号（IKA0VG）：区域内具体位置，规则人工控制，可不填。 */
  @IsOptional() @IsString() @MaxLength(20) locationCode?: string;
  /** 单位属性（IKFOPU）：零售单位空 = 展示处不显示单位文字。 */
  @IsOptional() @IsString() @MaxLength(6) retailUnit?: string;
  @IsOptional() @IsString() @MaxLength(6) wholesaleUnit?: string;
  /** 每件含量：批发单位包含的零售单位数，1~999，无件概念填 1。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(999) unitsPerCase?: number;
  /** 商品介绍（IKAHAU）：纯文本多行 ≤2000 字，空 = C 端不渲染区块。 */
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
/** 商品改价/改库存/换头图（IK9RWX）：image 走 COS 上传后的公网 URL。
 *  资料可编辑（IKAHAT）：名称/副标题/分类/原价/标签/重量并入 PATCH。 */
export class UpdateProductDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) stock?: number;
  /** 上下架（IKC1AB）：hq 官方库放行/回收、校区自管本地上架。 */
  @IsOptional() @IsIn(['on-sale', 'off-sale']) status?: 'on-sale' | 'off-sale';
  /** 进货价（IKC1AC）：仅官方库行接受（service 校验 campus）。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) costPrice?: number;
  /** 批发价格（IKC1AC）：仅官方库行接受（service 校验 campus）。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) wholesalePrice?: number;
  /** 资料字段（IKAHAT）：全部可选（PATCH 语义），空白 name 由 service 拒绝。 */
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) originalPrice?: number;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) weight?: number;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional()
  @Matches(/^https?:\/\//, { message: '图片地址必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
  /** 详情多图（IK9SNS）：整组提交覆盖，空数组清空回退单图。 */
  @IsOptional()
  @IsArray()
  @Matches(/^https?:\/\//, {
    each: true,
    message: '图片地址必须是 http(s) URL',
  })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(9)
  images?: string[];
  /** 库位（IKA0VG）：字典区域名 + 编号手填。 */
  @IsOptional() @IsString() @MaxLength(20) location?: string;
  @IsOptional() @IsString() @MaxLength(20) locationCode?: string;
  /** 单位属性（IKFOPU）：PATCH 语义可选；校区同步行由 service 剔除（只读）。 */
  @IsOptional() @IsString() @MaxLength(6) retailUnit?: string;
  @IsOptional() @IsString() @MaxLength(6) wholesaleUnit?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(999) unitsPerCase?: number;
  /** 商品介绍（IKAHAU）：整段覆盖，空串清空。 */
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
/** 首页 Banner（IK9RX2）：后台可管；color 为预置主题键（green/orange/dark）或自定义 hex。 */
export class CreateBannerDto {
  @IsString() @MinLength(1) @MaxLength(30) title!: string;
  @IsOptional() @IsString() @MaxLength(50) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(20) badge?: string;
  @IsString()
  @Matches(/^(green|orange|dark|#[0-9a-fA-F]{6})$/, {
    message: '主题色必须是 green/orange/dark 或 #RRGGBB',
  })
  color!: string;
  /** Banner 背景图：COS 上传后的公网 URL，空 = 纯色主题帧。 */
  @IsOptional()
  @Matches(/^https?:\/\//, { message: '图片地址必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
  /** 图文详情（IK9SNN）：多行文本，https:// 开头的行渲染为图片；空 = 不可点。 */
  @IsOptional() @IsString() @MaxLength(5000) content?: string;
  /** 详情长图（IKC1AD）：点击 Banner 进详情页通铺展示的主口径；空 = 不可点。 */
  @IsOptional() @IsString() @MaxLength(500) detailImage?: string;
  /** 展示位置（IKA57F）：缺省 home 首页轮播。 */
  @IsOptional() @IsIn(['home', 'pay-success']) placement?:
    'home' | 'pay-success';
  /** 点击跳转（IKE9YC）：none 无 / page 站内页面；跳转优先于图文详情。 */
  @IsOptional() @IsIn(['none', 'page']) linkType?: 'none' | 'page';
  /** 站内页面路径（支持带参，如 pages/coupons/index、pages/product/detail?id=x）。 */
  @IsOptional() @IsString() @MaxLength(200) linkUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  /** 投放校区（IKAJSL Banner 归总部）：空串 = 全部校区；仅 hq 操作者生效。 */
  @IsOptional() @IsString() campusId?: string;
}
export class UpdateBannerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) title?: string;
  @IsOptional() @IsString() @MaxLength(50) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(20) badge?: string;
  /** 详情长图（IKC1AD）：空串语义清空（Banner 回到不可点）。 */
  @IsOptional() @IsString() @MaxLength(500) detailImage?: string;
  @IsOptional()
  @IsString()
  @Matches(/^(green|orange|dark|#[0-9a-fA-F]{6})$/, {
    message: '主题色必须是 green/orange/dark 或 #RRGGBB',
  })
  color?: string;
  @IsOptional()
  @Matches(/^https?:\/\//, { message: '图片地址必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
  /** 图文详情（IK9SNN）：空串语义清空（Banner 回到不可点）。 */
  @IsOptional() @IsString() @MaxLength(5000) content?: string;
  /** 展示位置（IKA57F）：undefined 跳过更新。 */
  @IsOptional() @IsIn(['home', 'pay-success']) placement?:
    'home' | 'pay-success';
  /** 点击跳转（IKE9YC）：undefined 跳过；跳转优先于图文详情。 */
  @IsOptional() @IsIn(['none', 'page']) linkType?: 'none' | 'page';
  /** 站内页面路径：空串语义清空。 */
  @IsOptional() @IsString() @MaxLength(200) linkUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  @IsOptional() @IsIn(['active', 'hidden']) status?: 'active' | 'hidden';
}
/** 促销活动（ADR-0006 / IKAHFF）：type 区分秒杀/临期，price 为促销价（分），
 *  必须低于商品现价；同商品时间窗重叠由 service 拒绝（同期唯一生效）。 */
export class CreatePromotionDto {
  @IsString() productId!: string;
  @IsIn(['seckill', 'clearance']) type!: 'seckill' | 'clearance';
  @Type(() => Number) @IsInt() @Min(1) price!: number;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}
export class UpdatePromotionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) price?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  /** active/disabled：进行中停用立即生效（C 端读时回落）。 */
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
}
/** 配送费/起送门槛配置（IK9SO6）：金额单位分。 */
export class UpdateDeliveryConfigDto {
  @Type(() => Number) @IsInt() @Min(0) deliveryFeeInstant!: number;
  @Type(() => Number) @IsInt() @Min(0) deliveryFeeScheduled!: number;
  @Type(() => Number) @IsInt() @Min(0) deliveryThreshold!: number;
}
export class CreateCouponDto {
  @IsString() @MaxLength(40) name!: string;
  // IKDCVO：partner 异业券不参与下单，amount/threshold 须传 0 → Min(0)
  // 放行；platform 金额券的正数约束按 kind 在 service 校验。
  @Type(() => Number) @IsNumber() @Min(0) amount!: number;
  @Type(() => Number) @IsNumber() @Min(0) threshold!: number;
  /** IKDEN2：不传 = 不限量（null）；传则 ≥1 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) total?: number;
  // 不传 = 长期有效（IKDCVO）。
  @IsOptional() @IsString() expiresAt?: string;
  @IsOptional() @IsIn(['platform', 'partner']) kind?: string;
  @IsOptional() @IsIn(['manual', 'lottery', 'signup']) trigger?: string;
  @IsOptional() @IsString() @MaxLength(60) remark?: string;
  /** 支付后推荐（道哥 2026-09-08）：支付成功页领券卡展示 */
  @IsOptional() @IsBoolean() featuredAfterPay?: boolean;
}
/**
 * 优惠券编辑（IKDERC）：全字段可选，至少传一个。
 * 已发放（claimed>0）时面额/门槛锁定（资金口径）；总量不得小于已发数，
 * null=转不限量；expiresAt null=转长期。kind/trigger 不开放编辑。
 */
export class UpdateCouponDto {
  @IsOptional() @IsIn(['active', 'paused']) status?: 'active' | 'paused';
  /** 支付后推荐（道哥 2026-09-08）：支付成功页领券卡展示。 */
  @IsOptional() @IsBoolean() featuredAfterPay?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(60) remark?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number)
  @IsInt() @Min(0)
  amount?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number)
  @IsInt() @Min(0)
  threshold?: number | null;
  /** null = 转不限量（IKDEN2 口径） */
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number)
  @IsInt() @Min(1)
  total?: number | null;
  /** null = 转长期有效；传 ISO 日期串改固定日期 */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString()
  expiresAt?: string | null;
}
/** 批量放行/回收（IKCKX4）：官方库放行回收、校区批量上下架共用 */
export class BatchProductStatusDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
  @IsIn(['on-sale', 'off-sale']) status!: 'on-sale' | 'off-sale';
}
export class IssueCouponDto {
  /** IKD6FI：userIds 与定向条件（phones/buildingId/floor/roomNos）至少给一种，并集去重 */
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
  /** 按绑定手机号指定用户（邮箱/昵称不可靠，需求指定手机号口径） */
  @IsOptional() @IsArray() @IsString({ each: true })
  @ArrayMaxSize(500)
  phones?: string[];
  /** 按寝室地址定向：楼栋必填，楼层/寝室号可选收窄 */
  @IsOptional() @IsString() buildingId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) floor?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) roomNos?: string[];
}
/** 盘点校准（IKD6FJ）：提交实际清点数量，系统自动算差额落账。 */
export class StocktakeDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() @Min(0) countedQty!: number;
  @IsOptional() @IsString() @MaxLength(120) reason?: string;
}
/** 采购申请（IKD6FJ）：校区提交 → hq 审核 → 通过后入库。 */
export class CreatePurchaseRequestDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() @MaxLength(120) reason?: string;
}
export class AuditPurchaseRequestDto {
  @IsIn(['approved', 'rejected']) action!: 'approved' | 'rejected';
  @IsOptional() @IsString() @MaxLength(120) note?: string;
}
/** 订货批次（IKFOQ0）：总部创建，窗口内校区按件订货。 */
export class CreateRestockBatchDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsDateString() startAt!: string;
  @IsDateString() endAt!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) productIds!: string[];
}
export class UpdateRestockBatchDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsDateString() endAt?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(2000) productIds?: string[];
}
/** 订货行：按批发单位（件）计，换算按官方行 unitsPerCase 快照。 */
export class RestockOrderItemDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() @Min(1) cases!: number;
  @IsOptional() @IsString() @MaxLength(60) remark?: string;
}
/** 保存订货单：items 全量替换（草稿/驳回态可改）。 */
export class SaveRestockOrderDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true })
  @Type(() => RestockOrderItemDto)
  items!: RestockOrderItemDto[];
}
/** 订货审核（IKFOQ0）：confirm 锁总部仓库存，revoke 释放。 */
export class AuditRestockOrderDto {
  @IsIn(['confirm', 'reject', 'revoke']) action!: 'confirm' | 'reject' | 'revoke';
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
export class CreateBuildingDto {
  @IsString() @MaxLength(30) name!: string;
  @Type(() => Number) @IsInt() @Min(1) floors!: number;
  @IsBoolean() hasElevator!: boolean;
  @IsIn(['male', 'female', 'mixed']) gender!: 'male' | 'female' | 'mixed';
}
export class UpdateBuildingDto {
  @IsOptional() @IsString() @MaxLength(30) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) floors?: number;
  @IsOptional() @IsBoolean() hasElevator?: boolean;
  @IsOptional() @IsIn(['male', 'female', 'mixed']) gender?: string;
}
export class CreateRoomDto {
  @Type(() => Number) @IsInt() @Min(1) floor!: number;
  @IsString() @MaxLength(10) roomNo!: string;
}
const STAFF_STATUSES = ['online', 'paused', 'offline'] as const;
/** 楼长系含实习楼长（2026-09-14 道哥放开后台手建，此前仅招募审批可产出）。 */
const STAFF_ROLES = [
  'building-manager',
  'intern-building-manager',
  'fulltime-rider',
  'parttime-rider',
] as const;
export class CreateStaffDto {
  @IsString() @MaxLength(20) name!: string;
  @IsIn(STAFF_ROLES) role!: string;
  @IsString() @MaxLength(20) staffNo!: string;
  @IsOptional() @IsString() buildingId?: string;
  @IsOptional() @IsIn(STAFF_STATUSES) status?: string;
}
export class UpdateStaffDto {
  @IsOptional() @IsString() @MaxLength(20) name?: string;
  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: string;
  @IsOptional() @IsString() @MaxLength(20) staffNo?: string;
  @IsOptional() @IsString() buildingId?: string | null;
  @IsOptional() @IsIn(STAFF_STATUSES) status?: string;
}
export class StockInDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() @Min(1) quantity!: number;
  @IsString() @MaxLength(120) reason!: string;
}
export class AdjustStockDto {
  @IsString() productId!: string;
  @Type(() => Number) @IsInt() delta!: number;
  @IsString() @MaxLength(120) reason!: string;
}
/** 提成规则（IK8W5L）：四维（楼栋/楼层/重量档/模式）组合 → 单价。 */
export class CreateCommissionRuleDto {
  @IsOptional() @IsString() buildingId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) floor?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) weightFrom?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) weightTo?: number;
  @IsOptional() @IsIn(['instant', 'scheduled']) mode?: string;
  @Type(() => Number) @IsNumber() @Min(0.01) price!: number;
  @IsOptional() @IsString() effectiveAt?: string;
}
export class UpdateCommissionRuleDto {
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01) price?: number;
}
/** 调配邀请（IK8W5Y）：平台邀请楼长代管请假楼长的楼栋。 */
export class CreateDispatchInvitationDto {
  @IsString() targetStaffId!: string;
  @IsString() buildingId!: string;
  @IsString() startAt!: string;
  @IsString() endAt!: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) reward?: number;
}

/** 后台账号管理（IK9KWO）：仅 admin/hq 可增删改；角色口径同 permissions.ts。
 *  hq 仅总部长可用（IKAJSL），校区侧创建/授予 hq 由服务层守卫拒绝。 */
export const ADMIN_ACCOUNT_ROLES = [
  'hq',
  'admin',
  'operations',
  'warehouse',
  'finance',
] as const;
export class CreateAccountDto {
  @Matches(/^[a-zA-Z0-9_]{3,20}$/, {
    message: '用户名需为 3-20 位字母/数字/下划线',
  })
  username!: string;
  @IsString() @MinLength(8, { message: '密码至少 8 位' }) password!: string;
  @IsOptional() @IsString() @MaxLength(30) nickname?: string;
  @IsIn(ADMIN_ACCOUNT_ROLES) role!: string;
  /** 所属校区（IKAJSL）：仅 hq 操作者可用；空串 = 总部账号（role 须为 hq）。
   *  校区操作者传了也被忽略，强制落操作者本人校区。 */
  @IsOptional() @IsString() campusId?: string;
  /** 可运营校区全集（IKB3KG 方案A）：仅 hq 操作者生效；缺省=[campusId]。
   *  campusId=当前登录校区，本字段=顶栏可切换范围。 */
  @IsOptional() @IsArray() @IsString({ each: true }) campusIds?: string[];
}
export class UpdateAccountDto {
  @IsOptional() @IsString() @MaxLength(30) nickname?: string;
  @IsOptional() @IsIn(ADMIN_ACCOUNT_ROLES) role?: string;
  /** 重置密码（超管操作，无需旧密码）。 */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  password?: string;
  /** 重设可运营校区全集（IKB3KG 方案A）：仅 hq 操作者生效，整体替换授权行。 */
  @IsOptional() @IsArray() @IsString({ each: true }) campusIds?: string[];
}
/** 商品类别（全局字典）：名称 + 排序 + 类别图 + 可见性开关（IKC9M4），
 *  删除时有关联商品拒绝。 */
export class CreateCategoryDto {
  @IsString() @MinLength(1) @MaxLength(20) name!: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  /** 类别图（IK9RX0）：COS 上传后的公网 URL，空 = 无图。 */
  @IsOptional()
  @Matches(/^https?:\/\//, { message: '类别图必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
  /** 在小程序显示（IKC9M4）：false = C 端全链路隐藏该类目及其商品。 */
  @IsOptional() @Type(() => Boolean) hidden?: boolean;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(20) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  // IKC1AA：允许空串 = 恢复默认图标（用户端回落本地哈希图标）；非空须为图片 URL
  @IsOptional()
  @Matches(/^$|^https?:\/\//, { message: '类别图必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
  /** 在小程序显示（IKC9M4）：false = C 端全链路隐藏该类目及其商品。 */
  @IsOptional() @Type(() => Boolean) hidden?: boolean;
}

/** 库位字典（IKA0VG）：人工维护库位区域列表，商品表单下拉选择。 */
export class CreateLocationDto {
  @IsString() @MinLength(1) @MaxLength(20) name!: string;
  @IsOptional() @IsString() @MaxLength(100) note?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
}
export class UpdateLocationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(20) name?: string;
  @IsOptional() @IsString() @MaxLength(100) note?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
}
/** 手动改订单状态（IKA0UT）：测试/上线初期兜底，原因进审计日志。 */
export class UpdateOrderStatusDto {
  @IsString() status!: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
/** 微信群二维码新增/替换（IKAJSY）：buildingId 空/缺省 = 校级大群。 */
export class UpsertWechatGroupDto {
  @IsOptional() @IsString() buildingId?: string;
  /** COS 上传后的公网 URL。 */
  @IsString() @MinLength(1) @MaxLength(500) image!: string;
}
/** 校区本体管理（IKAJSL）：仅总部长可建/改校区（新校区接入入口）。 */
export class CreateCampusDto {
  @IsString() @MinLength(2) @MaxLength(30) name!: string;
  @IsString() @MinLength(2) @MaxLength(15) shortName!: string;
  @IsString() @MinLength(2) @MaxLength(30) warehouseName!: string;
  @IsOptional() @IsString() @MaxLength(100) address?: string;
  /** 配送费/起送门槛（IK9SO6 分制）：可选，缺省用模型默认。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFeeInstant?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFeeScheduled?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) deliveryThreshold?: number;
  /** 楼长月度底薪（IKDOIU，分）：0 = 无底薪（纯提成+调整）。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  buildingManagerBaseSalary?: number;
}
export class UpdateCampusDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(30) name?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(15) shortName?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(30) warehouseName?: string;
  @IsOptional() @IsString() @MaxLength(100) address?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFeeInstant?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFeeScheduled?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) deliveryThreshold?: number;
  /** 楼长月度底薪（IKDOIU，分）：0 = 无底薪（纯提成+调整）。 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  buildingManagerBaseSalary?: number;
}

/** 校区打印机绑定（IKBW0Q）：SN 在机身底部标签/自检页。
 *  IKC3FF：芯烨云无按台密钥，绑定只凭 SN（归属校验在云端）。
 *  copies（IKCZOX）：小票联数 1=单联无联名；2=商家联+骑手联；3=再加用户联。 */
export class BindPrinterDto {
  @IsString() @MaxLength(40) name!: string;
  @IsString()
  @Matches(/^[A-Za-z0-9-]{5,40}$/, { message: 'SN 格式不正确' })
  sn!: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3])
  copies?: number;
  /** 联间发送间隔秒数（IKFFHO）：0=连续（单次 POST 拼联）；1-10 逐联推送。
   *  发送侧延迟——云打印无出纸回执，出纸间隔 ≈ N + 打印耗时。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  copiesGapSeconds?: number;
}

/** 转盘奖位（IKD6FC）：8 项，类型与字段约束在 service 校验。 */
export class WheelPrizeDto {
  @IsIn(['coupon', 'partner', 'none']) type!: 'coupon' | 'partner' | 'none';
  @IsString() @MaxLength(12) label!: string;
  @IsOptional() @IsString() couponId?: string;
  @IsOptional() @IsString() @MaxLength(40) bizTitle?: string;
  @IsOptional() @IsString() @MaxLength(500) bizImage?: string;
  @IsOptional() @IsString() @MaxLength(120) bizNote?: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000) weight!: number;
}

/** 转盘配置保存（IKD6FC）：upsert 单校区单配置。 */
export class UpsertWheelDto {
  @IsBoolean() active!: boolean;
  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => WheelPrizeDto)
  prizes!: WheelPrizeDto[];
}

/** 楼长招募资料补录（IKEAGE）：身份证等运营线下收集后代录（C 端不采集）。 */
export class UpdateRecruitApplicationDto {
  @IsOptional() @IsString() @MaxLength(30) idCardNo?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) idCardImages?: string[];
  /** 运营备注（面试评价等，admin 独立字段；候选人自我介绍在 note 不经此处） */
  @IsOptional() @IsString() @MaxLength(200) staffRemark?: string;
  /** @deprecated 兼容旧调用（实为运营备注误用），保存接口已切换 staffRemark */
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
/** 拒绝报名（IKEAGE）：原因 C 端进度页可见。 */
export class RejectRecruitApplicationDto {
  @IsString() @MaxLength(100) reason!: string;
}
