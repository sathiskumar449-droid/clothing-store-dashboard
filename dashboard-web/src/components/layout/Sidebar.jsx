import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  ShoppingBag,
  Receipt,
  Package,
  Users,
  Settings,
  Store,
} from 'lucide-react';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chats', icon: MessageSquare, label: 'Chats' },
  { to: '/orders', icon: ShoppingBag, label: 'Orders' },
  { to: '/billing', icon: Receipt, label: 'Billing' },
  { to: '/products', icon: Package, label: 'Products' },
  { to: '/customers', icon: Users, label: 'Customers' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-64 min-h-screen bg-[#111b21] text-[#e9edef] fixed left-0 top-0 bottom-0 z-30 shadow-2xl border-r border-[#222e35]">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 bg-[#202c33] border-b border-[#222e35]">
        <div className="w-9 h-9 rounded-xl bg-[#00a884] flex items-center justify-center shadow-lg">
          <Store size={18} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-tight">Clothing Store</p>
          <p className="text-xs text-[#00a884] font-semibold">Owner Dashboard</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto bg-[#111b21]">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-r-xl rounded-l-none text-sm font-medium transition-all duration-200 border-l-4 group
              ${isActive
                ? 'bg-[#2a3942] text-white border-[#00a884] shadow-md'
                : 'text-[#aebac1] border-transparent hover:bg-[#202c33] hover:text-white'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={18}
                  className={isActive ? 'text-[#00a884]' : 'text-[#8696a0] group-hover:text-white transition-colors'}
                />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-[#222e35] bg-[#111b21]">
        <p className="text-xs text-[#8696a0]">WhatsApp Bot Dashboard</p>
        <p className="text-[10px] text-[#00a884] mt-0.5">v1.0.0</p>
      </div>
    </aside>
  );
}
