import { Type } from 'class-transformer';
import {
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
