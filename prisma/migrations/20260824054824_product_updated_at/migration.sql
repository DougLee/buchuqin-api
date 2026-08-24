/*
  Warnings:

  - Added the required column `updatedAt` to the `Product` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- 存量行回填当前时间：官方库行晚于任何 sourceSyncedAt 会导致角标误亮，
-- 但存量校区商品 sourceSyncedAt 全为空（不参与比较），无实际影响。
ALTER TABLE "Product" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();
