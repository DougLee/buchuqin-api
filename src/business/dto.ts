import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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
  @IsString() phone!: string;
}
export class CreateAfterSalesDto {
  @IsIn(['quality', 'missing', 'damaged']) type!:
    'quality' | 'missing' | 'damaged';
  @IsString() @MaxLength(300) description!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) images!: string[];
}
