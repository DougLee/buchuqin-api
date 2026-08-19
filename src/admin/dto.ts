import { Type } from 'class-transformer';
import {
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
/** 商品类别（全局字典）：名称 + 排序，删除时有关联商品拒绝。 */
export class CreateCategoryDto {
  @IsString() @MinLength(1) @MaxLength(20) name!: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(20) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() sort?: number;
}
