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
  private auth(req: AuthRequest) {
    if (
      !['building-manager', 'fulltime-rider', 'parttime-rider'].includes(
        req.user.role,
      )
    )
      throw new ForbiddenException('无履约端权限');
    return req.user.id;
  }
  @Get('profile') async profile(@Req() r: AuthRequest) {
    return ok(await this.service.profile(this.auth(r)));
  }
  @Patch('profile/status') async status(
    @Req() r: AuthRequest,
    @Body() d: StaffStatusDto,
  ) {
    return ok(await this.service.updateStatus(this.auth(r), d.status));
  }
  @Get('shifts/current') async shift(@Req() r: AuthRequest) {
    return ok(await this.service.currentShift(this.auth(r)));
  }
  @Post('shifts/check-in') async checkIn(@Req() r: AuthRequest) {
    return ok(await this.service.checkIn(this.auth(r)), '签到成功');
  }
  @Post('shifts/check-out') async checkOut(@Req() r: AuthRequest) {
    return ok(await this.service.checkOut(this.auth(r)), '签退成功');
  }
  @Get('dashboard') async dashboard(@Req() r: AuthRequest) {
    return ok(await this.service.dashboard(this.auth(r)));
  }
  @Get('tasks') async tasks(
    @Req() r: AuthRequest,
    @Query('status') s?: string,
  ) {
    return ok(await this.service.tasks(this.auth(r), s));
  }
  @Get('tasks/available') async available(@Req() r: AuthRequest) {
    const id = this.auth(r);
    // 抢单池仅配送员角色（IK8W5U）；楼长的接货视图走 GET /fulfillment/tasks。
    if (r.user.role === 'building-manager')
      throw new ForbiddenException('抢单池仅配送员可用');
    return ok(await this.service.availableTasks(id));
  }
  @Get('tasks/:id') async task(@Req() r: AuthRequest, @Param('id') id: string) {
    return ok(await this.service.task(this.auth(r), id));
  }
  @Post('tasks/:id/actions/:action') async action(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('action') a: string,
    @Body() b: TaskActionDto,
  ) {
    return ok(
      await this.service.updateTask(this.auth(r), id, a, b),
      '履约状态已更新',
    );
  }
  @Post('tasks/:id/accept') accept(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'accept', b);
  }
  // 抢单池动作（IK8W5U）：grab 与 accept 同语义同互斥。
  @Post('tasks/:id/grab') grab(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'grab', b);
  }
  @Post('tasks/:id/pickup') pickup(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'pickup', b);
  }
  @Post('tasks/:id/depart') depart(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'depart', b);
  }
  @Post('tasks/:id/arrive') arrive(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'arrive', b);
  }
  @Post('tasks/:id/handover') handover(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'handover', b);
  }
  @Post('tasks/:id/receive') receive(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'receive', b);
  }
  @Post('tasks/:id/start-delivery') start(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'start-delivery', b);
  }
  @Post('tasks/:id/delivered') delivered(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'delivered', b);
  }
  @Post('tasks/:id/report-exception') exception(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: TaskActionDto,
  ) {
    return this.action(r, id, 'absent', b);
  }
  @Get('leave-dispatch') async leaveDispatch(@Req() r: AuthRequest) {
    const id = this.auth(r);
    return ok([
      ...(await this.service.leave(id)),
      ...(await this.service.dispatchInvites(id)),
    ]);
  }
  @Get('leave-requests') async leaves(@Req() r: AuthRequest) {
    return ok(await this.service.leave(this.auth(r)));
  }
  @Post('leave-requests') async createLeave(
    @Req() r: AuthRequest,
    @Body() d: LeaveRequestDto,
  ) {
    return ok(
      await this.service.createLeave(this.auth(r), d),
      '请假申请已提交',
    );
  }
  @Post('leave-requests/:id/cancel') async cancelLeave(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.cancelLeave(this.auth(r), id));
  }
  @Get('dispatch-invitations') async invites(
    @Req() r: AuthRequest,
    @Query('status') s?: string,
  ) {
    return ok(await this.service.dispatchInvites(this.auth(r), s));
  }
  @Post('dispatch-invitations/:id/accept') async acceptInvite(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return ok(await this.service.respondDispatch(this.auth(r), id, true));
  }
  @Post('dispatch-invitations/:id/reject') async rejectInvite(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: RejectDto,
  ) {
    void b;
    return ok(await this.service.respondDispatch(this.auth(r), id, false));
  }
  @Get('commissions') async commissions(
    @Req() r: AuthRequest,
    @Query('month') month?: string,
  ) {
    return ok(await this.service.commissions(this.auth(r), month));
  }
  @Get('performance') async performance(@Req() r: AuthRequest) {
    return ok(await this.service.performance(this.auth(r)));
  }
}
