import { Navigate, Route, Routes } from 'react-router-dom';
import { Login } from './pages/Login';
import { Lobby } from './pages/Lobby';
import { Friends } from './pages/Friends';
import { Profile } from './pages/Profile';
import { EuchreGamePage } from './games/euchre/pages/Game';
import { EuchreQueuePage } from './games/euchre/pages/Queue';
import { EuchreRoomPage } from './games/euchre/pages/Room';
import { EuchreHotseatPage } from './games/euchre/pages/Hotseat';
import { RequireAuth } from './lib/auth';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Lobby />} />
        <Route path="/friends" element={<Friends />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/games/euchre/hotseat" element={<EuchreHotseatPage />} />
        <Route path="/games/euchre/play/:mode" element={<EuchreQueuePage />} />
        <Route path="/games/euchre/room/:code" element={<EuchreRoomPage />} />
        <Route path="/games/euchre/g/:gameId" element={<EuchreGamePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
