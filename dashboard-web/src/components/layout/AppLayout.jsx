import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import MobileDrawer from './MobileDrawer';

export default function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const isChatsRoute = pathname.startsWith('/chats');

  const openDrawer = () => setDrawerOpen(true);
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className="flex h-full min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Mobile slide-in nav drawer */}
      <MobileDrawer isOpen={drawerOpen} onClose={closeDrawer} />

      {/* Main content — pushed right on desktop, full width on mobile */}
      <div className="flex-1 md:ml-64 min-h-screen flex flex-col">
        {/* Chats page renders its own mobile header with a built-in menu trigger */}
        {!isChatsRoute && <MobileTopBar onMenuClick={openDrawer} />}

        <main className="flex-1 overflow-y-auto">
          <Outlet context={{ openMobileNav: openDrawer }} />
        </main>
      </div>
    </div>
  );
}
