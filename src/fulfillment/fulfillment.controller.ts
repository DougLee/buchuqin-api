import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { FulfillmentService } from './fulfillment.service';
import type { StaffRole } from './fulfillment.service';
import {
  LeaveRequestDto,
  RejectDto,
  StaffStatusDto,
  TaskActionDto,
} from './dto';

@ApiTags('履约端 MVP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fulfillment')
export class FulfillmentController {
  constructor(private readonly service: FulfillmentService) {}
  private role(req: AuthRequest, mockRole?: StaffRole): StaffRole {
    if (
      !['building-manager', 'fulltime-rider', 'parttime-rider'].includes(
        req.user.role,
      )
    )
      throw new ForbiddenException('普通用户无权访问履约端');
    return mockRole ?? (req.user.role as StaffRole);
  }
  @Get('profile') profile(
    @Req() req: AuthRequest,
    @Query('role') mockRole?: StaffRole,
  ) {
    return ok(this.service.profile(this.role(req, mockRole)));
  }
  @Patch('profile/status') updateStatus(
    @Req() req: AuthRequest,
    @Query('role') mockRole: StaffRole | undefined,
    @Body() dto: StaffStatusDto,
  ) {
    return ok(this.service.updateStatus(this.role(req, mockRole), dto.status));
  }
  @Get('shifts/current') currentShift(
    @Req() req: AuthRequest,
    @Query('role') mockRole?: StaffRole,
  ) {
    return ok(this.service.currentShift(this.role(req, mockRole)));
  }
  @Post('shifts/check-in') checkIn(
    @Req() req: AuthRequest,
    @Query('role') mockRole?: StaffRole,
  ) {
    return ok(this.service.checkIn(this.role(req, mockRole)), '签到成功');
  }
  @Post('shifts/check-out') checkOut(
    @Req() req: AuthRequest,
    @Query('role') mockRole?: StaffRole,
  ) {
    return ok(this.service.checkOut(this.role(req, mockRole)), '签退成功');
  }
  @Get('dashboard') dashboard(
    @Req() req: AuthRequest,
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    return ok(this.service.dashboard(this.role(req, role)));
  }
  @Get('tasks') tasks(
    @Req() req: AuthRequest,
    @Query('role') role: StaffRole = 'building-manager',
    @Query('status') status?: string,
  ) {
    return ok(this.service.tasks(this.role(req, role), status));
  }
  @Get('tasks/:id') task(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    return ok(this.service.task(this.role(req, role), id));
  }
  @Post('tasks/:id/actions/:action') action(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('action') action: string,
    @Query('role') role: StaffRole = 'building-manager',
    @Body() body: TaskActionDto,
  ) {
    if (action === 'pickup' && !body.packageCode)
      body.packageCode = 'MOCK-SCAN-CODE';
    if (action === 'handover' && !body.handoverCode)
      body.handoverCode = 'MOCK-HANDOVER-CODE';
    return ok(
      this.service.updateTask(this.role(req, role), id, action, body),
      '履约状态已更新',
    );
  }
  @Post('tasks/:id/accept') accept(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'accept', body),
    );
  }
  @Post('tasks/:id/pickup') pickup(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'pickup', body),
    );
  }
  @Post('tasks/:id/depart') depart(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'depart', body),
    );
  }
  @Post('tasks/:id/arrive') arrive(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'arrive', body),
    );
  }
  @Post('tasks/:id/handover') handover(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'handover', body),
    );
  }
  @Post('tasks/:id/receive') receive(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'receive', body),
    );
  }
  @Post('tasks/:id/start-delivery') startDelivery(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'start-delivery', body),
    );
  }
  @Post('tasks/:id/delivered') delivered(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'delivered', body),
    );
  }
  @Post('tasks/:id/report-exception') reportException(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Query('role') role: StaffRole,
    @Body() body: TaskActionDto,
  ) {
    return ok(
      this.service.updateTask(this.role(req, role), id, 'absent', body),
    );
  }
  @Get('leave-dispatch') leave() {
    return ok(this.service.leave());
  }
  @Get('leave-requests') leaveRequests() {
    return ok(
      this.service.leave().filter((item) => item.id.startsWith('leave-')),
    );
  }
  @Post('leave-requests') createLeave(
    @Req() req: AuthRequest,
    @Body() dto: LeaveRequestDto,
  ) {
    return ok(this.service.createLeave(req.user.id, dto), '请假申请已提交');
  }
  @Post('leave-requests/:id/cancel') cancelLeave(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.cancelLeave(req.user.id, id));
  }
  @Get('dispatch-invitations') dispatchInvitations(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
  ) {
    return ok(this.service.dispatchInvites(req.user.id, status));
  }
  @Post('dispatch-invitations/:id/accept') acceptDispatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(this.service.respondDispatch(req.user.id, id, true));
  }
  @Post('dispatch-invitations/:id/reject') rejectDispatch(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: RejectDto,
  ) {
    void body;
    return ok(this.service.respondDispatch(req.user.id, id, false));
  }
  @Get('commissions') commissions(
    @Req() req: AuthRequest,
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    return ok(this.service.commissions(this.role(req, role)));
  }
  @Get('performance') performance(
    @Req() req: AuthRequest,
    @Query('role') role: StaffRole = 'building-manager',
  ) {
    const dashboard = this.service.dashboard(this.role(req, role));
    return ok({
      period: 'today',
      ...dashboard.stats,
      proofRate: 99,
      exceptionRate: 1.2,
    });
  }
}
