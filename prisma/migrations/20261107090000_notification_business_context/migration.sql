ALTER TABLE "Notification" ADD COLUMN "businessType" TEXT NOT NULL DEFAULT 'day';
ALTER TABLE "Notification" ADD COLUMN "orderId" TEXT;
-- Historic night notifications use dedicated event titles. Preserve their channel;
-- no guessed order linkage is written from free-form content.
UPDATE "Notification" SET "businessType" = 'night' WHERE "title" IN
('夜宵售后审核结果', '夜宵订单已接单', '夜宵订单已送达', '夜宵订单异常提醒', '夜宵订单支付成功', '夜宵订单已取消并退款', '夜宵退款已完成');
