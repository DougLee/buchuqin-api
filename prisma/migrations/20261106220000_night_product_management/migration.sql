-- Reuse existing night store view grants for cross-building product management.
UPDATE "AdminMenu" m SET perms = (
  SELECT string_agg(DISTINCT p, ',')
  FROM unnest(string_to_array(m.perms, ',') || ARRAY['GET /admin/night/store-products']) AS p
  WHERE p <> ''
) WHERE m.code = 'night-stores';
UPDATE "RbacState" SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'global';
