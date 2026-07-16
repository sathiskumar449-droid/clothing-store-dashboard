import { createContext, useContext, useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';

const SESSION_KEY = 'dashboard_unlocked';

const DashboardLockContext = createContext(null);

export function useDashboardLock() {
  return useContext(DashboardLockContext);
}

export default function DashboardPasswordGate({ children }) {
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(SESSION_KEY) === 'true'
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    const ownerPassword = import.meta.env.VITE_DASHBOARD_PASSWORD;
    if (ownerPassword && password === ownerPassword) {
      sessionStorage.setItem(SESSION_KEY, 'true');
      setUnlocked(true);
      setError(false);
      setPassword('');
    } else {
      setError(true);
    }
  };

  const lock = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setUnlocked(false);
    setPassword('');
    setShowPassword(false);
  };

  if (unlocked) {
    return (
      <DashboardLockContext.Provider value={{ lock }}>
        {children}
      </DashboardLockContext.Provider>
    );
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center mb-4">
          <Lock size={18} className="text-indigo-600" />
        </div>
        <h1 className="text-lg font-bold text-gray-900">Dashboard Locked</h1>
        <p className="text-sm text-gray-500 mt-1 mb-4">
          Enter password to continue.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(false);
              }}
              placeholder="Password"
              className="w-full px-3 py-2 pr-10 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
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
