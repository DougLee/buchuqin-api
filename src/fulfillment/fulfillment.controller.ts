import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { FulfillmentService } from './fulfillment.service';
import type { StaffRole } from './fulfillment.service';

@ApiTags('履约端 MVP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fulfillment')
export class FulfillmentController {
  constructor(private readonly service: FulfillmentService) {}
  @Get('profile') profile(@Query('role') role: StaffRole = 'building-manager') {
    return ok(this.service.profile(role));
  }
  @Get('dashboard') dashboard(
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    return ok(this.service.dashboard(role));
  }
  @Get('tasks') tasks(
    @Query('role') role: StaffRole = 'building-manager',
    @Query('status') status?: string,
  ) {
    return ok(this.service.tasks(role, status));
  }
  @Get('tasks/:id') task(
    @Param('id') id: string,
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    return ok(this.service.task(role, id));
  }
  @Post('tasks/:id/actions/:action') action(
    @Param('id') id: string,
    @Param('action') action: string,
    @Query('role') role: StaffRole = 'building-manager',
    @Body() body: Record<string, unknown>,
  ) {
    return ok(
      this.service.updateTask(role, id, action, body),
      '履约状态已更新',
    );
  }
  @Get('leave-dispatch') leave() {
    return ok(this.service.leave());
  }
  @Get('commissions') commissions(
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    return ok(this.service.commissions(role));
  }
}
