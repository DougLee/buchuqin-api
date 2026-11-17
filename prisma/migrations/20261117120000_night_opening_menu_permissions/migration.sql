-- Existing menu permissions are DB-owned after their first seed. Extend only
-- retained standard night-store grants; do not recreate deleted menus or add
-- approval to deliberately narrowed/empty permission sets.
WITH added_read AS (
  UPDATE "AdminMenu"
  SET "perms" = concat_ws(',', NULLIF("perms", ''), 'GET /admin/night/opening-requests'),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "code" = 'night-stores'
    AND 'GET /admin/night/stores' = ANY(string_to_array("perms", ','))
    AND NOT ('GET /admin/night/opening-requests' = ANY(string_to_array("perms", ',')))
  RETURNING "id"
), added_review AS (
  UPDATE "AdminMenu"
  SET "perms" = concat_ws(',', NULLIF("perms", ''), 'POST /admin/night/opening-requests/:id/review'),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "code" = 'night-stores.write'
    AND 'PUT /admin/night/config' = ANY(string_to_array("perms", ','))
    AND NOT ('POST /admin/night/opening-requests/:id/review' = ANY(string_to_array("perms", ',')))
  RETURNING "id"
)
UPDATE "RbacState"
SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'global'
  AND (EXISTS(SELECT 1 FROM added_read) OR EXISTS(SELECT 1 FROM added_review));
