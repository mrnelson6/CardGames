import { Link } from 'react-router-dom';

export function Friends() {
  return (
    <div className="min-h-full p-6 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Friends</h1>
        <Link to="/" className="text-sm hover:underline">← Lobby</Link>
      </header>
      <p className="text-slate-400">Friends list and requests will live here (Phase 5).</p>
    </div>
  );
}
