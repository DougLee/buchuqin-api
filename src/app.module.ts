import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BusinessController } from './business/business.controller';
import { BusinessService } from './business/business.service';
import { MockStore } from './mock/mock.store';

@Module({
  imports: [JwtModule.register({ secret: 'buchuqinshishe-mock-secret' })],
  controllers: [AuthController, BusinessController],
  providers: [MockStore, BusinessService, JwtAuthGuard],
})
export class AppModule {}
