-- フェーズ4：台本が pending で登録（または pending に戻）されたら GitHub Actions を即時起動する
-- 適用済み（2026-10-27）。トークンは Vault の radio_github_token に置く（README 参照）
create extension if not exists pg_net with schema extensions;

create or replace function public.radio_dispatch_synthesize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'radio_github_token'
   limit 1;

  if v_token is null or v_token = '' then
    raise warning 'radio_dispatch: Vault secret radio_github_token が未設定のため起動をスキップ（予備の定時起動で処理されます）';
    return new;
  end if;

  perform net.http_post(
    url     := 'https://api.github.com/repos/nfukuda56/ai-radio/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'ai-radio-supabase'
    ),
    body    := jsonb_build_object(
      'event_type', 'synthesize',
      'client_payload', jsonb_build_object('episode_id', new.id, 'air_date', new.air_date)
    ),
    timeout_milliseconds := 10000
  );
  return new;
exception when others then
  -- 起動に失敗しても台本の登録は止めない
  raise warning 'radio_dispatch failed: %', sqlerrm;
  return new;
end;
$$;

revoke execute on function public.radio_dispatch_synthesize() from public, anon, authenticated;

drop trigger if exists radio_episodes_dispatch on public.radio_episodes;
create trigger radio_episodes_dispatch
  after insert or update of status on public.radio_episodes
  for each row
  when (new.status = 'pending')
  execute function public.radio_dispatch_synthesize();
