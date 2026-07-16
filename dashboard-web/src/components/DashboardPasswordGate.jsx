import { useState } from 'react';
import { Lock } from 'lucide-react';

const SESSION_KEY = 'dashboard_unlocked';

export default function DashboardPasswordGate({ children }) {
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(SESSION_KEY) === 'true'
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    const ownerPassword = import.meta.env.VITE_DASHBOARD_PASSWORD;
    if (ownerPassword && password === ownerPassword) {
      sessionStorage.setItem(SESSION_KEY, 'true');
      setUnlocked(true);
      setError(false);
    } else {
      setError(true);
    }
  };

  if (unlocked) return children;

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center mb-4">
          <Lock size={18} className="text-indigo-600" />
        </div>
        <h1 className="text-lg font-bold text-gray-900">Dashboard Locked</h1>
        <p className="text-sm text-gray-500 mt-1 mb-4">
          Enter the owner password to view revenue and stats.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(false);
            }}
            placeholder="Password"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          {error && (
            <p className="text-xs text-rose-600 mt-2">Incorrect password</p>
          )}
          <button
            type="submit"
            className="w-full mt-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}
