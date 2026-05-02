import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { subscribeWithReconnect } from '../../../lib/realtime';
import { useAuth } from '../../../lib/auth';
import { euchreApi } from '../api';

type Mode = 'solo' | 'duo';

export function EuchreQueuePage() {
  const { mode: rawMode } = useParams();
  const mode = (rawMode === 'duo' ? 'duo' : 'solo') as Mode;
  const { session } = useAuth();
  const navigate = useNavigate();
  const [enqueued, setEnqueued] = useState<{ rating: number; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const navigated = useRef(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await euchreApi.enqueueMatchmaking(mode);
        if (!cancelled) setEnqueued({ rating: r.rating ?? 0, at: Date.now() });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      // Best-effort: leave the queue if we navigated away without matching.
      supabase.from('mm_queue').delete().eq('user_id', session.user.id).then(() => undefined);
    };
  }, [session, mode]);

  // Tick the elapsed-time display.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Subscribe to game_players for this user — when a row appears, we matched.
  useEffect(() => {
    if (!session) return;
    const userId = session.user.id;
    const unsub = subscribeWithReconnect({
      channel: `mm-watch-${userId}`,
      configure: (ch) =>
        ch.on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'game_players',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            if (navigated.current) return;
            const row = payload.new as { game_id: string };
            if (!row.game_id) return;
            navigated.current = true;
            navigate(`/games/euchre/g/${row.game_id}`, { replace: true });
          },
        ),
    });
    return () => unsub();
  }, [session, navigate]);

  // Fallback: poll every 5s in case the realtime subscription missed the event.
  useEffect(() => {
    if (!session || !enqueued) return;
    const id = setInterval(async () => {
      if (navigated.current) return;
      const { data } = await supabase
        .from('game_players')
        .select('game_id, games!inner(status)')
        .eq('user_id', session.user.id)
        .eq('games.status', 'playing')
        .limit(1);
      const row = data?.[0] as { game_id: string } | undefined;
      if (row?.game_id) {
        navigated.current = true;
        navigate(`/games/euchre/g/${row.game_id}`, { replace: true });
      }
    }, 5000);
    return () => clearInterval(id);
  }, [session, enqueued, navigate]);

  const onLeave = async () => {
    if (session) {
      await supabase.from('mm_queue').delete().eq('user_id', session.user.id);
    }
    navigate('/');
  };

  const elapsed = enqueued ? Math.max(0, Math.floor((now - enqueued.at) / 1000)) : 0;
  const band = Math.min(300, 50 + 25 * Math.floor(elapsed / 10));

  return (
    <div className="min-h-full p-6 max-w-xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Euchre — {mode} queue</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>

      {error && (
        <div className="mb-4 rounded bg-red-900/50 border border-red-700 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {!error && (
        <div className="rounded-lg bg-slate-800 p-6 text-center">
          {enqueued ? (
            <>
              <p className="text-slate-300 mb-1">Searching for opponents…</p>
              <p className="text-4xl font-mono tabular-nums my-3">
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </p>
              <p className="text-xs text-slate-400">
                Your rating: <span className="text-slate-200">{enqueued.rating}</span> · search band ±{band}
              </p>
              <button
                onClick={onLeave}
                className="mt-5 rounded border border-slate-600 hover:bg-slate-700 px-4 py-2 text-sm"
              >
                Leave queue
              </button>
            </>
          ) : (
            <p className="text-slate-400">Joining queue…</p>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Cron pairs queued players every 3 seconds. Bands grow ±25 per 10s, capped at ±300.
      </p>
    </div>
  );
}
