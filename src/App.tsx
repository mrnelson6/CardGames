import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { AuthProvider, useAuth } from './lib/auth';
import { bindRealtimeAuth } from './lib/realtime';
import { usePresenceTracker } from './lib/presence';
import { useActiveGameRedirect } from './lib/useActiveGameRedirect';
import { InviteNotifier } from './components/InviteNotifier';

function AuthedShell() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  usePresenceTracker(userId);
  useActiveGameRedirect(userId);
  return (
    <>
      <AppRoutes />
      <InviteNotifier />
    </>
  );
}

export function App() {
  useEffect(() => {
    bindRealtimeAuth();
  }, []);

  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthedShell />
      </BrowserRouter>
    </AuthProvider>
  );
}
