import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const marker = 'night.preview.realistic.v1';
const adminId = 'night-preview-admin';

// Only the local preview runner calls this helper. No shared test/public or production writes.
export async function seedNightPreview(db, inventory, databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !url.pathname.endsWith('_spec') ||
    url.searchParams.get('schema') !== 'night_stock_preview_20261106'
  )
    throw new Error('模拟数据只允许独立夜宵预览 schema');
  const campusId = 'night-preview-campus';
  // Additive fixtures remain available on later runs without resetting manual business operations.
  const recruitBuilding = await db.building.upsert({ where: { id: 'night-preview-recruit-building' }, update: {}, create: { id: 'night-preview-recruit-building', campusId, name: '南区12栋' } });
  await db.staff.upsert({ where: { id: 'night-preview-new-manager' }, update: {}, create: { id: 'night-preview-new-manager', campusId, name: '周予安（建店验收）', staffNo: 'NIGHT-NEW12', role: 'building-manager', roleText: '楼长', building: recruitBuilding.name, buildingId: recruitBuilding.id, phone: '13800001012', onTimeRate: 100, income: 0 } });
  for (const buildingId of ['night-preview-building', recruitBuilding.id]) for (const roomNo of ['201', '202']) {
    await db.room.upsert({ where: { buildingId_floor_roomNo: { buildingId, floor: 2, roomNo } }, update: {}, create: { buildingId, floor: 2, roomNo, qrToken: `${buildingId}-room-${roomNo}-local` } });
  }
  if (await db.auditLog.findFirst({ where: { campusId, action: marker } }))
    return;
  require('ts-node').register({
    skipProject: true,
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
  });
  const { products, categories } = require('../prisma/seed-data/mock.data.ts');
  const {
    NightOrderService,
  } = require('../dist/src/night/night-order.service.js');
  const orders = new NightOrderService(db, {
    registerNightPaymentHandler() {},
  });
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
  const yesterday = new Date(`${day}T12:00:00+08:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const previousDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(yesterday);
  const at = (date, hour, minute = 0) =>
    new Date(
      `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
    );
  const fixtureDir = path.resolve('uploads/night-preview-products');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const imageUrl = (source) => {
    const file = path.resolve(
      '../buchuqin-user-weapp/src',
      source.replace(/^\//, ''),
    );
    if (!fs.existsSync(file)) throw new Error(`缺少本地商品素材：${source}`);
    fs.copyFileSync(file, path.join(fixtureDir, path.basename(file)));
    return `http://localhost:3150/api/v1/uploads/night-preview-products/${path.basename(file)}`;
  };
  await db.campus.update({
    where: { id: campusId },
    data: {
      name: '湖北工业大学·夜宵联调校区',
      shortName: '湖工大联调',
      warehouseName: '湖工大校园仓',
      nightStartAt: '00:00',
      nightEndAt: '23:59',
    },
  });
  await db.staff.update({
    where: { id: 'night-preview-staff' },
    data: { name: '方福宁', staffNo: 'YX009' },
  });
  const stores = [
    {
      id: 'night-preview-store',
      staffId: 'night-preview-staff',
      buildingId: 'night-preview-building',
      buildingName: '西区9栋',
      name: '方福宁',
      deposit: 150000,
    },
  ];
  for (const [i, name] of ['陈嘉宁', '李思远'].entries()) {
    const id = `night-demo-store-${i}`,
      staffId = `night-demo-staff-${i}`,
      buildingId = `night-demo-building-${i}`,
      buildingName = i === 0 ? '西区10栋' : '北区18栋';
    await db.building.upsert({
      where: { id: buildingId },
      update: {},
      create: { id: buildingId, campusId, name: buildingName },
    });
    await db.staff.upsert({
      where: { id: staffId },
      update: {},
      create: {
        id: staffId,
        campusId,
        name,
        role: 'building-manager',
        roleText: '楼长',
        staffNo: `YX0${10 + i}`,
        building: buildingName,
        buildingId,
        onTimeRate: 100,
        income: 0,
      },
    });
    await db.nightStore.upsert({
      where: { id },
      update: {},
      create: {
        id,
        campusId,
        buildingId,
        managerStaffId: staffId,
        deposit: 50000,
        commissionRate: 2000,
      },
    });
    stores.push({
      id,
      staffId,
      buildingId,
      buildingName,
      name,
      deposit: 50000,
    });
  }
  for (const s of stores) {
    // A local fixture opening balance, never an external payment or callback.
    if (!(await db.nightDepositTxn.count({ where: { storeId: s.id } }))) {
      await db.nightStore.update({
        where: { id: s.id },
        data: { deposit: s.deposit },
      });
      await db.nightDepositTxn.create({
        data: {
          id: `night-demo-deposit-${s.id}`,
          storeId: s.id,
          type: 'deposit',
          amount: s.deposit,
          operatorId: s.staffId,
          remark: '本地模拟：期初押金（无真实支付）',
          createdAt: at(previousDay, 16),
        },
      });
    }
  }
  const catalogRows = [];
  const openingStarted = await db.nightStockOrder.count({ where: { storeId: stores[0].id, requestId: 'night-demo-opening-0' } });
  for (const [i, source] of products.entries()) {
    const catName = categories.find((c) => c.id === source.categoryId).name;
    const category = await db.category.upsert({
      where: { campusId_name: { campusId: 'campus-official', name: catName } },
      update: {},
      create: { campusId: 'campus-official', name: catName, sort: i },
    });
    const id = `night-demo-official-${source.id}`;
    const product = await db.product.upsert({
      where: { id },
      update: {},
      create: {
        id,
        campusId: 'campus-official',
        categoryId: category.id,
        catalogScope: 'platform',
        name: source.name,
        subtitle: source.subtitle,
        price: source.price,
        originalPrice: source.originalPrice,
        stock: 0,
        image: imageUrl(source.image),
        barcode: `69010000${String(i + 1).padStart(5, '0')}`,
        tag: source.tag,
        weight: source.weight,
        retailUnit:
          source.categoryId === 'drink'
            ? '瓶'
            : source.categoryId === 'fruit'
              ? '份'
              : '包',
      },
    });
    // Keep one official item unimported so the picker has a realistic candidate.
    if (i === products.length - 1) continue;
    await inventory.importCatalog(adminId, campusId, [id]);
    const p = await db.product.findFirstOrThrow({
      where: { campusId, nightCatalog: true, sourceProductId: id },
    });
    await db.product.update({
      where: { id: p.id },
      data: { status: 'on-sale' },
    });
    if (!openingStarted) await db.product.update({
      where: { id: p.warehouseProductId },
      data: { stock: 60 + i * 7 },
    });
    catalogRows.push(p);
  }
  // Add real pictures/specifications to the three original preview items as well.
  for (const [i, source] of [products[0], products[5], products[2]].entries()) {
    const image = imageUrl(source.image);
    await db.product.updateMany({
      where: {
        OR: [
          { id: `night-preview-official-${i}` },
          { campusId, sourceProductId: `night-preview-official-${i}` },
        ],
      },
      data: {
        image,
        subtitle: ['经典口味 330ml', '原味 70g', '红烧牛肉味 110g'][i],
      },
    });
  }
  async function stock(s, key, items, target, received, old = false) {
    let o = await inventory.createStockOrder(s.staffId, {
      requestId: `night-demo-${key}`,
      items,
    });
    if (
      o.status === 'requested' &&
      ['approved', 'shipped', 'received'].includes(target)
    )
      o = await inventory.reviewStockOrder(
        adminId,
        o.id,
        true,
        '仓库已核对，按申请数量配货',
      );
    if (o.status === 'approved' && ['shipped', 'received'].includes(target))
      o = await inventory.shipStockOrder(adminId, o.id);
    if (o.status === 'shipped' && target === 'received')
      await inventory.receiveStockOrder(s.staffId, o.id, received || items);
    if (o.status === 'requested' && target === 'rejected')
      await inventory.reviewStockOrder(
        adminId,
        o.id,
        false,
        '鲜食今晚供应不足，请调整后重新提交',
      );
    if (o.status === 'requested' && target === 'cancelled')
      await inventory.cancelStockOrder(o.id, { operatorId: adminId }, '楼长调整今晚备货计划');
    if (old) {
      await db.nightStockOrder.update({
        where: { id: o.id },
        data: {
          createdAt: at(previousDay, 16, 20),
          reviewedAt: at(previousDay, 16, 40),
          shippedAt: at(previousDay, 17),
          receivedAt: at(previousDay, 17, 30),
        },
      });
      await db.nightStockTxn.updateMany({
        where: { storeId: s.id, refId: o.id },
        data: { createdAt: at(previousDay, 17, 30) },
      });
    }
    return o;
  }
  for (const [i, s] of stores.entries()) {
    const pool = i ? catalogRows.slice(i, i + 7) : catalogRows;
    await stock(
      s,
      `opening-${i}`,
      pool.map((p, j) => ({
        catalogProductId: p.id,
        quantity: i ? 4 : 4 + (j % 3),
      })),
      'received',
      null,
      true,
    );
    await db.nightStore.update({
      where: { id: s.id },
      data: { status: 'open' },
    });
  }
  for (const [i, target] of [
    'requested',
    'approved',
    'shipped',
    'rejected',
    'cancelled',
  ].entries()) {
    await stock(
      stores[i % stores.length],
      `progress-${target}`,
      [{ catalogProductId: catalogRows[i].id, quantity: 3 + i }],
      target,
    );
  }
  await stock(
    stores[0],
    'receipt-difference',
    [{ catalogProductId: catalogRows[7].id, quantity: 4 }],
    'received',
    [{ catalogProductId: catalogRows[7].id, quantity: 3 }],
  );
  for (const [i, state] of [
    'pending',
    'approved',
    'rejected',
    'gain',
  ].entries()) {
    const s = stores[i % stores.length],
      key = `night-demo-report-${i}`;
    if (
      await db.nightInventoryReport.findUnique({
        where: { storeId_requestId: { storeId: s.id, requestId: key } },
      })
    )
      continue;
    const p = await db.nightProduct.findUniqueOrThrow({
      where: {
        storeId_catalogProductId: {
          storeId: s.id,
          catalogProductId: catalogRows[i + 2].id,
        },
      },
    });
    const r = await inventory.createReport(s.staffId, {
      requestId: key,
      kind: state === 'gain' ? 'stocktake' : 'loss',
      reason: [
        '到货整理时发现一包外包装破损，等待核实',
        '一瓶饮料漏液，无法继续销售',
        '清点时发现少一包，申请复核',
        '整理货架发现一包漏记，盘点补登',
      ][i],
      photos: [],
      items: [
        {
          nightProductId: p.id,
          quantity: state === 'gain' ? p.stock + 1 : 1,
          inventoryVersion: p.inventoryVersion,
        },
      ],
    });
    if (state !== 'pending')
      await inventory.reviewReport(
        adminId,
        r.id,
        state !== 'rejected',
        state === 'rejected'
          ? '复盘找到商品，恢复可售库存'
          : '与楼长核对实物，确认差异',
      );
  }
  for (let i = 0; i < 10; i++) {
    const s = stores[i % stores.length],
      userId = `night-demo-customer-${i}`,
      addressId = `night-demo-address-${i}`;
    const user = await db.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        campusId,
        nickname: ['小林', '阿哲', '小雨', '晨晨', '一只橘子'][i % 5],
        phone: `1380000${String(1000 + i)}`,
      },
    });
    await db.address.upsert({
      where: { id: addressId },
      update: {},
      create: {
        id: addressId,
        userId,
        campusId,
        campusName: '湖北工业大学',
        buildingId: s.buildingId,
        buildingName: s.buildingName,
        floor: 2 + (i % 5),
        room: `${2 + (i % 5)}0${(i % 8) + 1}`,
        contactName: user.nickname,
        phone: user.phone,
      },
    });
    if (await db.nightOrder.count({ where: { userId } })) continue;
    const choices = await db.nightProduct.findMany({
      where: { storeId: s.id, stock: { gte: 2 }, frozenStock: 0 },
      orderBy: { id: 'asc' },
    });
    const p = choices[i % choices.length];
    const o = await orders.submitOrder(userId, {
      storeId: s.id,
      addressId,
      items: [{ productId: p.id, quantity: i % 3 === 0 ? 2 : 1 }],
    });
    if (i === 9) {
      await orders.closePendingPayment(o.id, '用户调整加餐计划');
      continue;
    }
    await orders.applyNightOrderPaid(o.orderNo);
    if (i !== 8) await orders.acceptOrder(s.staffId, s.id, o.id);
    if (i < 7) {
      await orders.deliverOrder(s.staffId, s.id, o.id, {
        images: [
          p.catalogProductId
            ? catalogRows.find((c) => c.id === p.catalogProductId)?.image ||
              `http://localhost:3150/api/v1/uploads/night-preview-products/soda.svg`
            : 'http://localhost:3150/api/v1/uploads/night-preview-products/soda.svg',
        ],
        remark: '本地模拟送达凭证',
      });
      const date = i < 4 ? previousDay : day,
        createdAt = at(date, 20, i * 4);
      const completed = await db.nightOrder.findUniqueOrThrow({ where: { id: o.id } });
      await db.nightOrder.update({
        where: { id: o.id },
        data: {
          createdAt,
          paidAt: new Date(+createdAt + 60000),
          completedAt: new Date(+createdAt + 480000),
          businessDate: date,
          timeline: completed.timeline.map((event, index) => ({ ...event, time: new Date(+createdAt + (event.key === 'completed' ? 480000 : index * 60000)).toISOString() })),
        },
      });
      await db.nightCommissionTxn.updateMany({
        where: { orderId: o.id },
        data: {
          createdAt: new Date(+createdAt + 60000),
          ...(i < 4
            ? { status: 'settled', settleBatch: `night-demo-${previousDay}` }
            : {}),
        },
      });
      await db.nightStockTxn.updateMany({
        where: { refId: o.id },
        data: { createdAt },
      });
    }
  }
  const disabled = catalogRows.at(-1);
  await db.product.update({
    where: { id: disabled.id },
    data: { status: 'off-sale' },
  });
  await db.product.update({
    where: { id: disabled.warehouseProductId },
    data: { stock: 0 },
  });
  const shelf = await db.nightProduct.findFirstOrThrow({
    where: { storeId: stores[0].id, catalogProductId: catalogRows[0].id },
  });
  await db.nightProduct.update({
    where: { id: shelf.id },
    data: { onShelf: false },
  });
  await db.nightProduct.updateMany({
    where: { storeId: stores[1].id, catalogProductId: catalogRows[1].id },
    data: { saleAllowed: false },
  });
  await db.nightStore.update({
    where: { id: stores[2].id },
    data: { status: 'paused' },
  });
  await db.campus.update({
    where: { id: campusId },
    data: { nightStartAt: '20:00', nightEndAt: '03:00' },
  });
  for (const s of stores) {
    const quota = await inventory.summary(s.id);
    if (quota.usedQuota > quota.deposit) throw new Error('模拟数据额度不平衡');
  }
  await db.auditLog.create({
    data: {
      campusId,
      operator: adminId,
      action: marker,
      entityType: 'night-preview',
      entityId: stores[0].id,
      after: {
        stores: stores.length,
        catalog: catalogRows.length,
        customers: 10,
      },
    },
  });
  console.log(
    `已准备真实场景模拟：${stores.length} 栋楼、${catalogRows.length} 种商品、10 笔订单及各状态备货/盘点；重启保留后续手工操作。`,
  );
}
