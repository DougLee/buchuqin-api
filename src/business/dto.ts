import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
export class CartItemDto {
  @IsString() productId!: string;
  @IsInt() @Min(0) quantity!: number;
  // IKHL6Y 秒杀双渠道：行身份——秒杀专区加购传 true（秒杀行，限购 1）；
  // 正常入口缺省 false（原价行，不限购）。秒杀价跟活动窗走，窗外回落原价
  @IsOptional() @IsBoolean() asSeckill?: boolean;
}
export class UpdateCartDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}
export class CreateOrderDto {
  // IKCIAG：C 端可达校验全部中文文案（无地址进结算页时原样弹英文默认信息）
  @IsString({ message: '请先选择寝室地址' }) addressId!: string;
  @IsIn(['instant', 'scheduled'], {
    message: '配送方式不正确，请重新选择',
  })
  deliveryMode!: 'instant' | 'scheduled';
  @IsOptional() @IsString() deliverySlot?: string;
  @IsOptional() @IsString({ message: '优惠券不可用' }) couponId?: string;
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: '备注最多 60 字' })
  remark?: string;
}
export class CreateAddressDto {
  @IsString({ message: '请填写楼栋名称' }) buildingName!: string;
  @IsInt({ message: '楼层必须是数字' }) @Min(1, { message: '楼层至少为 1' })
  floor!: number;
  @IsString({ message: '请填写寝室号' }) room!: string;
  @IsString({ message: '请填写联系人' }) contactName!: string;
  @IsString()
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone!: string;
  @IsOptional() isDefault?: boolean;
}
export class UpdateAddressDto {
  @IsOptional() @IsString({ message: '楼栋名称格式不正确' })
  buildingName?: string;
  @IsOptional()
  @IsInt({ message: '楼层必须是数字' })
  @Min(1, { message: '楼层至少为 1' })
  floor?: number;
  @IsOptional() @IsString({ message: '寝室号格式不正确' }) room?: string;
  @IsOptional() @IsString({ message: '联系人格式不正确' }) contactName?: string;
  @IsOptional()
  @IsString()
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone?: string;
}
export class CartQuantityDto {
  @IsInt() @Min(0) quantity!: number;
  // IKHL6Y 秒杀双渠道：加购入口身份——秒杀专区传 true，缺省原价行
  @IsOptional() @IsBoolean() asSeckill?: boolean;
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

/** 未发货退款（IKHZKA）：已支付未出库可申请；原因必填（道哥 2026-09-23 改）。 */
export class ApplyPreDeliveryRefundDto {
  @IsString() @MinLength(1) @MaxLength(120) reason!: string;
}

/** 抽奖（IKD6FB）：无请求体——每日 1 次，服务端判定资格与结果。 */
export class DrawWheelDto {}

/** 楼长报名（IKEAGE）：校区自由选（开放中），楼栋属该校区；一人一条在途。
 *  审核前修改复用同结构（PATCH /recruit/application）。 */
export class RecruitApplyDto {
  @IsString() campusId!: string;
  @IsString() buildingId!: string;
  @IsString() @MaxLength(20) name!: string;
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' }) phone!: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
