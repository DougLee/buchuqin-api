-- IKJCJF：菜单「订货管理」→「订货单」（registry upsert 不更新已有菜单名，走迁移）
UPDATE "AdminMenu" SET "name" = '订货单' WHERE "code" = 'restock';
