-- IKE9YC：Banner 点击跳转配置（none 无 / page 站内页面；预留 miniapp）
ALTER TABLE "Banner" ADD COLUMN "linkType" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "linkUrl" TEXT NOT NULL DEFAULT '';
