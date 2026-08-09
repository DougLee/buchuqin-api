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
}
