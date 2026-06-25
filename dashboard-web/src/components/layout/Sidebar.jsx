import { Store } from 'lucide-react';
import NavList from './NavList';

export default function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-64 min-h-screen bg-[#111b21] text-[#e9edef] fixed left-0 top-0 bottom-0 z-30 shadow-2xl border-r border-[#222e35]">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 bg-[#202c33] border-b border-[#222e35]">
        <div className="w-9 h-9 rounded-xl bg-[#00a884] flex items-center justify-center shadow-lg">
          <Store size={18} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-tight">Super Collections</p>
          <p className="text-xs text-[#00a884] font-semibold">Owner Dashboard</p>
        </div>
      </div>

      <NavList />

      {/* Footer */}
      <div className="px-5 py-4 border-t border-[#222e35] bg-[#111b21]">
        <p className="text-xs text-[#8696a0]">WhatsApp Bot Dashboard</p>
        <p className="text-[10px] text-[#00a884] mt-0.5">v1.0.0</p>
      </div>
    </aside>
  );
}
