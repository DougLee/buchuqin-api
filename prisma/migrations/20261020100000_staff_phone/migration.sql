-- AlterTable
-- IKP0AP：Staff 加联系电话（后台联系配送员/楼长端拨号用；空串=未录入）
ALTER TABLE "Staff" ADD COLUMN     "phone" TEXT NOT NULL DEFAULT '';
