import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';

export function Login() {
  const { session, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (loading) return <div className="p-8">Loading…</div>;
  if (session) return <Navigate to="/" replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      setError(error.message);
      setStatus('error');
    } else {
      setStatus('sent');
    }
  };

  const onGuest = async () => {
    setStatus('sending');
    setError(null);
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      setError(error.message);
      setStatus('error');
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg bg-slate-800 p-6 shadow">
        <h1 className="text-2xl font-bold mb-4">Card Games</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={status === 'sending'}
            className="w-full rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-2 font-medium disabled:opacity-50"
          >
            {status === 'sending' ? 'Sending…' : 'Send magic link'}
          </button>
        </form>
        {status === 'sent' && (
          <p className="mt-3 text-sm text-emerald-400">Check your email for the sign-in link.</p>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="my-4 flex items-center gap-2 text-xs text-slate-400">
          <div className="h-px flex-1 bg-slate-700" />
          <span>or</span>
          <div className="h-px flex-1 bg-slate-700" />
        </div>
        <button
          onClick={onGuest}
          disabled={status === 'sending'}
          className="w-full rounded border border-slate-600 hover:bg-slate-700 px-3 py-2 disabled:opacity-50"
        >
          Continue as guest (private rooms only)
        </button>
      </div>
    </div>
  );
}
