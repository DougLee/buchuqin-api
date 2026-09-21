import { ForbiddenException } from '@nestjs/common';
import { RbacService, type RbacContext } from '../admin/rbac/rbac.service';
import type { FilesController } from './files.controller';

const mockPutObject = jest.fn((_options, callback) => callback(null, { Location: 'synthetic' }));
jest.mock('cos-nodejs-sdk-v5', () => ({ __esModule: true, default: jest.fn(() => ({ putObject: mockPutObject })) }));

describe('admin image upload capability and ACL', () => {
  let controller: FilesController;
  const account = { id: 'admin-A', status: 'active', sessionVersion: 2 };
  const db = { adminAccount: { findUnique: jest.fn(async () => account as typeof account | null) } };
  let ctx: RbacContext;
  const rbac = {
    assertSession: RbacService.prototype.assertSession,
    getEffective: jest.fn(async () => ctx),
    allow: RbacService.prototype.allow,
  };
  const file = { originalname: 'image.png', mimetype: 'image/png', buffer: Buffer.from('synthetic') } as Express.Multer.File;
  const req = { user: { id: account.id, role: 'rbac', sv: 2 } } as any;
  beforeAll(() => {
    const oldBucket = process.env.COS_BUCKET, oldRegion = process.env.COS_REGION;
    process.env.COS_BUCKET = 'test-bucket'; process.env.COS_REGION = 'test-region';
    // Load only after synthetic config is installed. COS itself is mocked; no cloud writes.
    const { FilesController: Controller } = require('./files.controller');
    controller = new Controller(db, rbac);
    if (oldBucket === undefined) delete process.env.COS_BUCKET; else process.env.COS_BUCKET = oldBucket;
    if (oldRegion === undefined) delete process.env.COS_REGION; else process.env.COS_REGION = oldRegion;
  });
  beforeEach(() => {
    mockPutObject.mockClear(); db.adminAccount.findUnique.mockResolvedValue(account);
    ctx = { accountId: account.id, username: 'test', nickname: 'test', campusId: 'A', platform: false,
      super: false, campuses: ['A'], patterns: new Set(), menuCodes: new Set() };
  });
  it.each([
    ['app', 'POST /admin/banners'], ['app/banner-detail', 'PATCH /admin/banners/:id'],
    ['app/product', 'PATCH /admin/products/:id'], ['app/category', 'POST /admin/categories'],
    ['app/wechat-group', 'POST /admin/wechat-groups'], ['app/wheel', 'PUT /admin/wheel'],
    ['uploads', 'POST /admin/products'],
  ])('%s requires the matching write permission and uploads public media', async (folder, permission) => {
    ctx.patterns.add('GET /admin/products');
    await expect(controller.uploadImage(req, folder, file)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPutObject).not.toHaveBeenCalled();
    ctx.patterns.add(permission);
    const result = await controller.uploadImage(req, folder, file);
    expect(result.data.private).toBe(false);
    expect(mockPutObject).toHaveBeenCalledWith(expect.objectContaining({ ACL: 'public-read', Key: expect.stringMatching(new RegExp(`^${folder}/`)) }), expect.any(Function));
  });
  it('ID-card capability stays separate and writes private ACL', async () => {
    ctx.patterns.add('PATCH /admin/products/:id');
    await expect(controller.uploadImage(req, 'app/idcard', file)).rejects.toBeInstanceOf(ForbiddenException);
    ctx.patterns.add('POST /admin/recruit-applications/:id/idcard');
    const result = await controller.uploadImage(req, 'app/idcard', file);
    expect(result.data.private).toBe(true);
    expect(mockPutObject).toHaveBeenCalledWith(expect.objectContaining({ ACL: 'private' }), expect.any(Function));
  });
  it('price-only ability cannot upload product media', async () => {
    ctx.patterns.add('PATCH /admin/products/:id/price');
    await expect(controller.uploadImage(req, 'app/product', file)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPutObject).not.toHaveBeenCalled();
  });
  it('ordinary app users retain public uploads but cannot upload private documents', async () => {
    db.adminAccount.findUnique.mockResolvedValue(null);
    const userReq = { user: { id: 'user-A', role: 'user' } } as any;
    await controller.uploadImage(userReq, 'uploads', file);
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    await expect(controller.uploadImage(userReq, 'app/idcard', file)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPutObject).toHaveBeenCalledTimes(1);
  });
});
