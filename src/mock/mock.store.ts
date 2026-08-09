import { Injectable } from '@nestjs/common';
import {
  addresses,
  banners,
  campus,
  categories,
  coupons,
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
  carts: Record<string, Record<string, number>> = {
    'user-001': { p001: 2, p002: 1 },
  };
  orders: Array<Record<string, any>> = [];
}
