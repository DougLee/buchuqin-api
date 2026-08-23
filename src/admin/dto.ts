import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class BarcodeDto {
  @IsString()
  @Matches(/^\d{8,14}$/, { message: '条码必须是 8-14 位数字' })
  barcode!: string;
}

export class CreateProductDto extends BarcodeDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @IsString() categoryId!: string;
  @Type(() => Number) @IsNumber() @Min(0) price!: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) originalPrice?: number;
  @Type(() => Number) @IsInt() @Min(0) stock!: number;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() image?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) weight?: number;
  /** 详情多图（IK9SNS）：COS URL 数组，顺序即详情页轮播顺序。 */
  @IsOptional()
  @IsArray()
  @Matches(/^https?:\/\//, { each: true, message: '图片地址必须是 http(s) URL' })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(9)
  images?: string[];
  /** 库位（IK9U40 / IKA0VG）：库位管理字典里的区域名。 */
  @IsOptional() @IsString() @MaxLength(20) location?: string;
  /** 库位编号（IKA0VG）：区域内具体位置，规则人工控制，可不填。 */
  @IsOptional() @IsString() @MaxLength(20) locationCode?: string;
  /** 商品介绍（IKAHAU）：纯文本多行 ≤2000 字，空 = C 端不渲染区块。 */
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
/** 商品改价/改库存/换头图（IK9RWX）：image 走 COS 上传后的公网 URL。
 *  资料可编辑（IKAHAT）：名称/副标题/分类/原价/标签/重量并入 PATCH。 */
export class UpdateProductDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) stock?: number;
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
  @Matches(/^https?:\/\//, { each: true, message: '图片地址必须是 http(s) URL' })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(9)
  images?: string[];
  /** 库位（IKA0VG）：字典区域名 + 编号手填。 */
  @IsOptional() @IsString() @MaxLength(20) location?: string;
  @IsOptional() @IsString() @MaxLength(20) locationCode?: string;
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
  /** 展示位置（IKA57F）：缺省 home 首页轮播。 */
  @IsOptional() @IsIn(['home', 'pay-success']) placement?: 'home' | 'pay-success';
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
}
export class UpdateBannerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) title?: string;
  @IsOptional() @IsString() @MaxLength(50) subtitle?: string;
  @IsOptional() @IsString() @MaxLength(20) badge?: string;
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
  @IsOptional() @IsIn(['home', 'pay-success']) placement?: 'home' | 'pay-success';
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  @IsOptional() @IsIn(['active', 'hidden']) status?: 'active' | 'hidden';
}
/** 配送费/起送门槛配置（IK9SO6）：金额单位分。 */
export class UpdateDeliveryConfigDto {
  @Type(() => Number) @IsInt() @Min(0) deliveryFeeInstant!: number;
  @Type(() => Number) @IsInt() @Min(0) deliveryFeeScheduled!: number;
  @Type(() => Number) @IsInt() @Min(0) deliveryThreshold!: number;
}
export class CreateCouponDto {
  @IsString() @MaxLength(40) name!: string;
  @Type(() => Number) @IsNumber() @Min(0.01) amount!: number;
  @Type(() => Number) @IsNumber() @Min(0) threshold!: number;
  @Type(() => Number) @IsInt() @Min(1) total!: number;
  @IsString() expiresAt!: string;
}
export class UpdateCouponDto {
  @IsIn(['active', 'paused']) status!: 'active' | 'paused';
}
export class IssueCouponDto {
  @IsArray() @IsString({ each: true }) userIds!: string[];
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
export class CreateStaffDto {
  @IsString() @MaxLength(20) name!: string;
  @IsIn(['building-manager', 'fulltime-rider', 'parttime-rider']) role!: string;
  @IsString() @MaxLength(20) staffNo!: string;
  @IsOptional() @IsString() buildingId?: string;
  @IsOptional() @IsIn(STAFF_STATUSES) status?: string;
}
export class UpdateStaffDto {
  @IsOptional() @IsString() @MaxLength(20) name?: string;
  @IsOptional()
  @IsIn(['building-manager', 'fulltime-rider', 'parttime-rider'])
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

/** 后台账号管理（IK9KWO）：仅 admin 可增删改；角色口径同 permissions.ts。 */
export const ADMIN_ACCOUNT_ROLES = [
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
}
export class UpdateAccountDto {
  @IsOptional() @IsString() @MaxLength(30) nickname?: string;
  @IsOptional() @IsIn(ADMIN_ACCOUNT_ROLES) role?: string;
  /** 重置密码（超管操作，无需旧密码）。 */
  @IsOptional() @IsString() @MinLength(8, { message: '密码至少 8 位' })
  password?: string;
}
/** 商品类别（全局字典）：名称 + 排序 + 类别图，删除时有关联商品拒绝。 */
export class CreateCategoryDto {
  @IsString() @MinLength(1) @MaxLength(20) name!: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  /** 类别图（IK9RX0）：COS 上传后的公网 URL，空 = 无图。 */
  @IsOptional()
  @Matches(/^https?:\/\//, { message: '类别图必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(20) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
  @IsOptional()
  @Matches(/^https?:\/\//, { message: '类别图必须是 http(s) URL' })
  @MaxLength(500)
  image?: string;
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
