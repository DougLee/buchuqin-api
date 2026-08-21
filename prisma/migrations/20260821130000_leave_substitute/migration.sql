-- IKA57Y：请假「自己调配」可指定代班楼长（id + 姓名快照）
ALTER TABLE "LeaveRequest" ADD COLUMN "substituteStaffId" TEXT;
ALTER TABLE "LeaveRequest" ADD COLUMN "substituteName" TEXT;
