import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class TaskActionDto {
  // IKA0UP：交接改为拍照凭证（images）；旧扫码字段已随 IKA0UM 一并移除。
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) images?: string[];
  // delivered 动作携带的定位坐标（B 线 H5 端上传）。
  @IsOptional() @Type(() => Number) @IsNumber() latitude?: number;
  @IsOptional() @Type(() => Number) @IsNumber() longitude?: number;
  @IsOptional() @IsString() reasonCode?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  @IsOptional() @IsString() receiver?: string;
}

export class StaffStatusDto {
  @IsIn(['online', 'paused', 'offline']) status!:
    'online' | 'paused' | 'offline';
}

/** 骑手/楼长自助改号（IKP0AP）：只允许更新本人联系电话，格式同后台
 *  servicePhone/CreateStaffDto.phone（3-20 位数字与-）。字段必挂装饰器——
 *  全局 ValidationPipe whitelist 会静默剥离无装饰器字段。 */
export class UpdateProfileDto {
  @IsOptional()
  @Matches(/^[0-9-]{3,20}$/, { message: '联系电话格式不正确' })
  phone?: string;
}

/** 一键获取本机手机号（道哥 2026-10-20）：wx getPhoneNumber 回调 code */
export class WechatPhoneCodeDto {
  @IsString()
  @MinLength(1)
  code!: string;
}

export class LeaveRequestDto {
  @IsString() startAt!: string;
  @IsString() endAt!: string;
  @IsString() @MaxLength(200) reason!: string;
  /** 请假期间订单调配方式（IK9U4B）：缺省平台自动派单 */
  @IsOptional() @IsIn(['self', 'platform']) dispatchMode?: string;
  /** 自己调配指定的代班楼长（IKA57Y）：dispatchMode=self 时必传 */
  @IsOptional() @IsString() substituteStaffId?: string;
}

export class RejectDto {
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
