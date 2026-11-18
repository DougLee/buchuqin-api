-- Explicit opt-in only. Existing campus flags and all day-store data are preserved.
ALTER TABLE "Organization" ADD COLUMN "nightEnabled" BOOLEAN NOT NULL DEFAULT false;
