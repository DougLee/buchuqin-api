-- 类别头图（IK9RX0）：小程序分类 tab 图标；空串 = 无图（前端回退文字样式）
ALTER TABLE "Category" ADD COLUMN "image" TEXT NOT NULL DEFAULT '';
