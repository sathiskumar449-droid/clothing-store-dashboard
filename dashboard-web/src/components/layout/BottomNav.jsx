import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  ShoppingBag,
  Receipt,
  Package,
  Settings,
} from 'lucide-react';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
  { to: '/chats', icon: MessageSquare, label: 'Chats' },
  { to: '/orders', icon: ShoppingBag, label: 'Orders' },
  { to: '/billing', icon: Receipt, label: 'Billing' },
  { to: '/products', icon: Package, label: 'Products' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-3 left-3 right-3 z-40 bg-[#121438]/90 backdrop-blur-2xl border border-white/20 rounded-full shadow-[0_10px_35px_rgba(0,0,0,0.5)] px-2 py-1.5">
      <div className="flex items-center justify-around">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center transition-all duration-300 ease-out group
              ${isActive ? 'scale-105' : 'opacity-80 hover:opacity-100'}`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`flex items-center justify-center transition-all duration-300 ${
                    isActive
                      ? 'w-10 h-10 rounded-full bg-gradient-to-tr from-[#5856d6] via-[#6366f1] to-[#8b5cf6] text-white shadow-lg shadow-indigo-500/40 ring-2 ring-white/30 -translate-y-1'
                      : 'w-9 h-9 rounded-full text-gray-400 hover:text-white hover:bg-white/10'
                  }`}
                >
                  <Icon size={isActive ? 20 : 18} strokeWidth={isActive ? 2.5 : 1.8} />
                </span>
                <span
                  className={`text-[9.5px] transition-colors mt-0.5 ${
                    isActive ? 'font-bold text-white' : 'font-medium text-gray-400'
                  }`}
                >
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
