-- AlterTable (IKC9M4：类目可见性开关)
ALTER TABLE "Category" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
