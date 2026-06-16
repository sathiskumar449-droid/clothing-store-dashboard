import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  ShoppingBag,
  Receipt,
  Package,
  Users,
  Settings,
} from 'lucide-react';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Home' },
  { to: '/chats', icon: MessageSquare, label: 'Chats' },
  { to: '/orders', icon: ShoppingBag, label: 'Orders' },
  { to: '/billing', icon: Receipt, label: 'Billing' },
  { to: '/products', icon: Package, label: 'Products' },
  { to: '/customers', icon: Users, label: 'Customers' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[#202c33] border-t border-[#222e35] shadow-[0_-4px_20px_rgba(0,0,0,0.2)]">
      <div className="flex items-stretch overflow-x-auto">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 min-w-[52px] flex flex-col items-center justify-center py-2 px-1 text-[10px] font-medium transition-all duration-200
              ${isActive
                ? 'text-[#00a884]'
                : 'text-[#aebac1] hover:text-white'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className={`mb-0.5 p-1 rounded-lg transition-all ${isActive ? 'bg-[#2a3942]' : ''}`}>
                  <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                </span>
                {label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
