-- ---------------------------------------------------------------------------
-- Hub: UP NEXT cards (liked or fast-tracked, nothing requested yet) sit on
-- the canvas as kind 'card' (ref_id -> cards.id). Once the card is requested
-- the portal turns that row into kind 'article' (ref_id -> articles.id) in
-- place, so it keeps its spot.
-- ---------------------------------------------------------------------------
alter table hub_items drop constraint if exists hub_items_kind_check;
alter table hub_items add constraint hub_items_kind_check
  check (kind in ('article','note','text','emoji','card'));
