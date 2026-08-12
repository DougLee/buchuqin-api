import { BadRequestException } from '@nestjs/common';
import { MockStore } from '../mock/mock.store';
import { FulfillmentService } from './fulfillment.service';

describe('FulfillmentService', () => {
  let service: FulfillmentService;
  beforeEach(() => {
    service = new FulfillmentService(new MockStore());
  });

  it('exposes legal actions and rejects invalid transitions', () => {
    const task = service
      .tasks('fulltime-rider')
      .find((item) => item.status === 'delivering');
    expect(task?.availableActions).toContain('arrive');
    expect(() =>
      service.updateTask('fulltime-rider', task!.id, 'delivered', {}),
    ).toThrow(BadRequestException);
  });

  it('requires scan data for pickup and handover', () => {
    const task = service
      .tasks('fulltime-rider')
      .find((item) => item.status === 'available')!;
    expect(() =>
      service.updateTask('fulltime-rider', task.id, 'pickup', {}),
    ).toThrow('包裹码');
    expect(
      service.updateTask('fulltime-rider', task.id, 'pickup', {
        packageCode: 'PKG-MOCK',
      }).status,
    ).toBe('delivering');
  });

  it('updates staff status and handles dispatch invitation once', () => {
    expect(service.updateStatus('building-manager', 'paused').status).toBe(
      'paused',
    );
    const invite = service.dispatchInvites('staff-bm-001')[0];
    expect(
      service.respondDispatch('staff-bm-001', invite.id, true).status,
    ).toBe('accepted');
    expect(() =>
      service.respondDispatch('staff-bm-001', invite.id, false),
    ).toThrow('已处理');
  });
});
