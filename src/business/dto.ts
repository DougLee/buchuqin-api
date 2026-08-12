import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
export class CartItemDto {
  @IsString() productId!: string;
  @IsInt() @Min(0) quantity!: number;
}
export class UpdateCartDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}
export class CreateOrderDto {
  @IsString() addressId!: string;
  @IsIn(['instant', 'scheduled']) deliveryMode!: 'instant' | 'scheduled';
  @IsOptional() @IsString() deliverySlot?: string;
  @IsOptional() @IsString() couponId?: string;
  @IsOptional() @IsString() @MaxLength(60) remark?: string;
}
export class CreateAddressDto {
  @IsString() buildingName!: string;
  @IsInt() @Min(1) floor!: number;
  @IsString() room!: string;
  @IsString() contactName!: string;
  @IsString() @Matches(/^1\d{10}$/) phone!: string;
  @IsOptional() isDefault?: boolean;
}
export class UpdateAddressDto {
  @IsOptional() @IsString() buildingName?: string;
  @IsOptional() @IsInt() @Min(1) floor?: number;
  @IsOptional() @IsString() room?: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() @Matches(/^1\d{10}$/) phone?: string;
}
export class CartQuantityDto {
  @IsInt() @Min(0) quantity!: number;
}
export class AddCartItemDto extends CartQuantityDto {
  @IsString() productId!: string;
}
export class CancelReasonDto {
  @IsOptional() @IsString() reasonCode?: string;
  @IsOptional() @IsString() @MaxLength(120) reason?: string;
}
export class SwitchCampusDto {
  @IsString() campusId!: string;
}
export class CreateAfterSalesDto {
  @IsIn(['quality', 'missing', 'damaged']) type!:
    'quality' | 'missing' | 'damaged';
  @IsString() @MaxLength(300) description!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) images!: string[];
}
