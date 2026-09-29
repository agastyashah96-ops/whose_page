-- Run this ONLY if you already have the original Whose Page schema.
-- It does not recreate your existing RLS policies.

ALTER TABLE public.players
ADD COLUMN IF NOT EXISTS last_seen timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.update_player_last_seen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.last_seen = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS player_last_seen_trigger ON public.players;

CREATE TRIGGER player_last_seen_trigger
BEFORE UPDATE ON public.players
FOR EACH ROW
EXECUTE FUNCTION public.update_player_last_seen();

CREATE OR REPLACE FUNCTION public.delete_empty_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.players WHERE room_id = OLD.room_id
  ) THEN
    DELETE FROM public.rooms WHERE id = OLD.room_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS delete_empty_room_trigger ON public.players;

CREATE TRIGGER delete_empty_room_trigger
AFTER DELETE ON public.players
FOR EACH ROW
EXECUTE FUNCTION public.delete_empty_room();
