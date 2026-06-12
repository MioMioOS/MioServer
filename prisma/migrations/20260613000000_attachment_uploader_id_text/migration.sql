-- S8 human attachment uploads: uploader_id must hold cuid User.ids as well as
-- uuid ControlAgent.ids. Widen uuid -> text (lossless; uuids cast to their
-- canonical string form).
ALTER TABLE "control_attachments" ALTER COLUMN "uploader_id" TYPE TEXT USING "uploader_id"::text;
