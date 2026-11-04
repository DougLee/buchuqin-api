import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/* ==================== 后台 /admin/night/* ==================== */

export class NightStoreCreateDto {
  @IsOptional() @IsString() campusId?: string;
  @IsString() buildingId!: string;
  /** 楼长（Staff id），可空=招募中 */
  @IsOptional() @IsString() managerStaffId?: string;
  /** 佣金比例万分比（0~10000，显式 0 合法；PRD B09） */
  @IsInt() @Min(0) @Max(10000) commissionRate!: number;
}

export class NightStoreUpdateDto {
  /** suspended 停业 / closed 打烊（恢复走楼长开店） */
  @IsOptional() @IsIn(['closed', 'suspended']) status?: string;
  /** 换楼长：传新 Staff id（解绑重绑）；传 null=解绑（招募中） */
  @IsOptional() @IsString() managerStaffId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(10000) commissionRate?: number;
}

export class NightCatalogCreateDto {
  @IsOptional() @IsString() campusId?: string;
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  /** 夜宵统一售价（分）：同一校区同 SKU 统一执行（PRD B06） */
  @IsInt() @Min(1) price!: number;
  @IsOptional() @IsInt() @Min(0) originalPrice?: number;
  @IsOptional() @IsString() image?: string;
  @IsOptional() @IsString() subtitle?: string;
  /** 缺省自动挂本校区「夜宵专供」隐藏分类 */
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() barcode?: string;
}

export class NightCatalogUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(1) price?: number;
  @IsOptional() @IsInt() @Min(0) originalPrice?: number;
  @IsOptional() @IsString() image?: string;
  @IsOptional() @IsString() subtitle?: string;
  /** on-sale / off-sale（下架后楼栋行不可再备货） */
  @IsOptional() @IsIn(['on-sale', 'off-sale']) status?: string;
}

export class NightStoreProductAttachDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  catalogProductIds!: string[];
}

export class NightProductUpdateDto {
  /** 后台强制下架/恢复（saleAllowed 优先于楼长 onShelf 选择） */
  @IsOptional() @IsBoolean() saleAllowed?: boolean;
}

export class NightStockAdjustDto {
  @IsInt() delta!: number;
  @IsIn(['adjust', 'returnOut', 'loss', 'stocktake']) type!:
    'adjust' | 'returnOut' | 'loss' | 'stocktake';
  @IsString() @MinLength(1) @MaxLength(200) reason!: string;
}

export class NightConfigDto {
  @IsOptional() @IsString() campusId?: string;
  @IsBoolean() nightEnabled!: boolean;
  @IsOptional() @IsString() nightStartAt?: string | null;
  @IsOptional() @IsString() nightEndAt?: string | null;
  /** 待支付超时（分钟）；null=回落默认 15 分钟 */
  @IsOptional() @IsInt() @Min(1) @Max(120) nightPayTimeout?: number | null;
  /** 接单超时（分钟）；一期记录不自动关单 */
  @IsOptional() @IsInt() @Min(1) @Max(240) nightAcceptTimeout?: number | null;
  /** 夜间配送费（分）；null=回落白天即时送口径；0=显式免费 */
  @IsOptional() @IsInt() @Min(0) @Max(5000) nightDeliveryFee?: number | null;
  /** 强警告二次确认：夜宵开始早于校区闭店时刻时须显式 true（PRD V1.5 A02） */
  @IsOptional() @IsBoolean() confirm?: boolean;
}

export class NightRefundDto {
  /** 商品退款金额（分）；缺省=整单商品部分全额（productAmount−券优惠） */
  @IsOptional() @IsInt() @Min(1) productRefund?: number;
  /** 是否退配送费（整单取消/未履约场景；配送费退款触发楼长侧 clawback） */
  @IsOptional() @IsBoolean() refundDeliveryFee?: boolean;
  /** 退款商品是否回库（默认 true；已送出/损耗场景传 false 只退钱不回库） */
  @IsOptional() @IsBoolean() restock?: boolean;
  @IsString() @MinLength(1) @MaxLength(200) reason!: string;
}

export class NightSettleDto {
  @IsOptional() @IsString() campusId?: string;
  /** 缺省=该范围全部待结算店铺；显式列表则只出这些店 */
  @IsOptional() @IsArray() @IsString({ each: true }) storeIds?: string[];
}

export class NightDepositDeductDto {
  @IsInt() @Min(1) amount!: number;
  @IsString() @MinLength(1) @MaxLength(200) reason!: string;
}

export class NightDepositRefundDto {
  /** 缺省=全额退当前押金余额 */
  @IsOptional() @IsInt() @Min(1) amount?: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

/* ==================== 楼长端 /night-rider/* ==================== */

export class NightStockOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => NightStockItemDto)
  items!: NightStockItemDto[];
}

export class NightStockItemDto {
  @IsString() catalogProductId!: string;
  @IsInt() @Min(1) quantity!: number;
}

export class NightShelfDto {
  @IsBoolean() onShelf!: boolean;
}

/* ==================== 用户端 /night/* ==================== */

export class NightOrderItemDto {
  /** NightProduct 楼栋行 id */
  @IsString() productId!: string;
  @IsInt() @Min(1) quantity!: number;
}

export class NightOrderCreateDto {
  @IsString() storeId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => NightOrderItemDto)
  items!: NightOrderItemDto[];
  /** 夜宵券（UserCoupon id），可空 */
  @IsOptional() @IsString() couponId?: string;
  @IsString({ message: '请先选择寝室地址' }) addressId!: string;
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: '备注最多 60 字' })
  remark?: string;
}

export class NightAfterSaleDto {
  @IsIn(['quality', 'missing', 'damaged', 'wrong', 'other']) type!:
    'quality' | 'missing' | 'damaged' | 'wrong' | 'other';
  @IsString() @MinLength(1) @MaxLength(300) description!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) images?: string[];
}
