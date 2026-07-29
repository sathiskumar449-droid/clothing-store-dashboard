import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';

export default function AppLayout() {
  return (
    <div className="flex h-full min-h-screen bg-gradient-to-br from-[#0b0c24] via-[#14163c] to-[#241344] p-0 md:p-4 gap-4">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main content — pushed right on desktop, rounded glass container */}
      <main className="flex-1 md:ml-64 min-h-screen md:min-h-[calc(100vh-2rem)] pb-20 md:pb-0 overflow-y-auto bg-white/95 backdrop-blur-xl md:rounded-3xl border border-white/60 shadow-2xl transition-all duration-300">
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <BottomNav />
    </div>
  );
}
