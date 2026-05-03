-- Add parties + party_members to the realtime publication so the lobby
-- updates immediately when create-party / join-party / leave-party run.
-- Without this, the Edge Function succeeds but the UI sits unchanged
-- until the user refreshes.

alter publication supabase_realtime add table
  public.parties,
  public.party_members;
