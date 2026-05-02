import { useEffect } from 'react';
import { HashRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { AuthProvider } from './lib/auth';
import { bindRealtimeAuth } from './lib/realtime';

export function App() {
  useEffect(() => {
    bindRealtimeAuth();
  }, []);

  return (
    <AuthProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AuthProvider>
  );
}
