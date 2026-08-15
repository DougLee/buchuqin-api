import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class TaskActionDto {
  @IsOptional() @IsString() packageCode?: string;
  @IsOptional() @IsString() handoverCode?: string;
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

export class LeaveRequestDto {
  @IsString() startAt!: string;
  @IsString() endAt!: string;
  @IsString() @MaxLength(200) reason!: string;
}

export class RejectDto {
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
