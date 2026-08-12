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
import { AdminService } from './admin.service';

@ApiTags('PC 管理后台 MVP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}
  private authorize(req: AuthRequest) {
    if (
      !['admin', 'operations', 'warehouse', 'finance'].includes(req.user.role)
    )
      throw new ForbiddenException('无后台访问权限');
  }
  @Get('dashboard') dashboard(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.dashboard());
  }
  @Get('products') products(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.products());
  }
  @Patch('products/:id') updateProduct(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { price?: number; stock?: number },
  ) {
    this.authorize(req);
    return ok(this.service.updateProduct(id, body, req.user.id));
  }
  @Get('inventory') inventory(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.inventory());
  }
  @Get('orders') orders(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
  ) {
    this.authorize(req);
    return ok(this.service.orders(status));
  }
  @Get('orders/:id') order(@Req() req: AuthRequest, @Param('id') id: string) {
    this.authorize(req);
    return ok(this.service.order(id));
  }
  @Post('orders/:id/actions/:action') orderAction(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    this.authorize(req);
    return ok(this.service.orderAction(id, action, req.user.id));
  }
  @Get('staff') staff(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.staff());
  }
  @Get('after-sales') afterSales(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.afterSales());
  }
  @Post('after-sales/:id/review') review(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: { approved: boolean },
  ) {
    this.authorize(req);
    return ok(this.service.reviewAfterSale(id, body.approved, req.user.id));
  }
  @Get('settlements') settlements(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.settlements());
  }
  @Get('campuses') campuses(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.campuses());
  }
  @Get('coupons') coupons(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.coupons());
  }
  @Get('audit-logs') audits(@Req() req: AuthRequest) {
    this.authorize(req);
    return ok(this.service.auditLogs());
  }
}
