-- IK8W5Y 调配邀请：记录目标楼栋 buildingId（admin 创建邀请时校验目标楼长非该楼绑定楼长）
ALTER TABLE "DispatchInvitation" ADD COLUMN "buildingId" TEXT;
