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
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setState({ session: data.session, loading: false });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false });
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
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
