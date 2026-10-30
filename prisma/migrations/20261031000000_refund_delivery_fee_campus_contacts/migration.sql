-- IKRSIY #110/#91：Refund.refundDeliveryFee（审核口径留痕）+ Campus.refundDeliveryFeeBeforeArrive
-- （到店前是否退配送费的校区级覆盖，默认不退）
-- IKRSIY #195：Campus.serviceKfUrl（企微微信客服链接，空=未配置走旧客服弹层）
-- IKRSIY #107：Campus.showDeliveryContacts（用户订单详情是否下发骑手/楼长真实电话）
-- （只含本批变更；工作区其他未提交字段的 DDL 归各自迁移，勿并入）
ALTER TABLE "Campus" ADD COLUMN     "serviceKfUrl" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "showDeliveryContacts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundDeliveryFeeBeforeArrive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "refundDeliveryFee" BOOLEAN NOT NULL DEFAULT false;
