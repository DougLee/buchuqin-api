import { Injectable } from '@nestjs/common';
import type { MockOrder } from '../business/business.service';
import {
  addresses,
  banners,
  campus,
  categories,
  coupons,
  deliverySlots,
  products,
} from './mock.data';
@Injectable()
export class MockStore {
  campus = structuredClone(campus);
  categories = structuredClone(categories);
  products = structuredClone(products);
  banners = structuredClone(banners);
  addresses = structuredClone(addresses);
  coupons = structuredClone(coupons);
  deliverySlots = structuredClone(deliverySlots);
  carts: Record<string, Record<string, number>> = {
    'user-001': { p001: 2, p002: 1 },
  };
  orders: MockOrder[] = [];
  afterSales: Array<{
    id: string;
    userId: string;
    orderId: string;
    type: string;
    description: string;
    images: string[];
    status: string;
    createdAt: string;
  }> = [];
  refunds: Array<{
    id: string;
    userId: string;
    orderId: string;
    amount: number;
    reason: string;
    status: string;
    createdAt: string;
  }> = [];
  notifications = [
    {
      id: 'notice-001',
      userId: 'user-001',
      type: 'campaign',
      title: '夜宵补给站开门啦',
      content: '今晚 22:30 前下单都能送到寝室。',
      read: false,
      createdAt: '2026-08-10T12:00:00.000Z',
    },
    {
      id: 'notice-002',
      userId: 'user-001',
      type: 'service',
      title: '欢迎来到不出寝食社',
      content: '校园零食日用，配送员与楼长接力送到寝室。',
      read: true,
      createdAt: '2026-08-09T09:00:00.000Z',
    },
  ];
}
