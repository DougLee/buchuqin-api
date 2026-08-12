import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class TaskActionDto {
  @IsOptional() @IsString() packageCode?: string;
  @IsOptional() @IsString() handoverCode?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) images?: string[];
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
