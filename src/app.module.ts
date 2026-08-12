import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BusinessController } from './business/business.controller';
import { BusinessService } from './business/business.service';
import { MockStore } from './mock/mock.store';
import { FulfillmentController } from './fulfillment/fulfillment.controller';
import { FulfillmentService } from './fulfillment/fulfillment.service';

@Module({
  imports: [JwtModule.register({ secret: 'buchuqinshishe-mock-secret' })],
  controllers: [AuthController, BusinessController, FulfillmentController],
  providers: [MockStore, BusinessService, FulfillmentService, JwtAuthGuard],
})
export class AppModule {}
