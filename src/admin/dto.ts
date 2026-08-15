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
  @IsOptional() @IsIn(['building-manager', 'fulltime-rider', 'parttime-rider'])
  role?: string;
  @IsOptional() @IsString() @MaxLength(20) staffNo?: string;
  @IsOptional() @IsString() buildingId?: string | null;
  @IsOptional() @IsIn(STAFF_STATUSES) status?: string;
}
