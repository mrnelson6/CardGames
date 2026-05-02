import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { AuthProvider } from './lib/auth';
import { bindRealtimeAuth } from './lib/realtime';

export function App() {
  useEffect(() => {
    bindRealtimeAuth();
  }, []);

  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
