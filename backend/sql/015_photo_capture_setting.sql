-- Adds an independent admin control for System Check check-in photos.
-- Existing deployments remain enabled by default.
alter table exam_settings
    add column if not exists photo_capture_enabled boolean not null default true;
