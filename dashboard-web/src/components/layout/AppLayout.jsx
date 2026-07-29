import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';

export default function AppLayout() {
  return (
    <div className="flex h-full min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main content — pushed right on desktop, full width on mobile */}
      <main className="flex-1 md:ml-64 min-h-screen pb-20 md:pb-0 overflow-y-auto">
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <BottomNav />
    </div>
  );
}
