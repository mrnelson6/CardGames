import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface AuthState {
  session: Session | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true });

  useEffect(() => {
    // Rely solely on onAuthStateChange for the initial state. supabase-js
    // fires INITIAL_SESSION after it has finished recovering from storage
    // AND parsing any auth tokens out of the URL. Calling getSession()
    // synchronously here would race ahead of the URL parse — getSession
    // returns null, we flip loading=false, RequireAuth redirects to
    // /login, and the redirect strips the magic-link hash off the URL
    // before supabase-js can read it. INITIAL_SESSION lets us hold the
    // "loading…" screen until the URL has been fully consumed.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8">Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}
