import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  it('/api/v1/auth/mock-login (POST)', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/mock-login')
      .send({ code: 'mock' })
      .expect(200)
      .expect((response) =>
        expect(
          (response.body as { data: { token?: string } }).data.token,
        ).toBeDefined(),
      );
  });

  afterEach(async () => {
    await app.close();
  });
});
