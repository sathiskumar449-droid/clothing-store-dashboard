import { Store, ChevronDown } from 'lucide-react';
import NavList from './NavList';

export default function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-64 fixed left-4 top-4 bottom-4 z-30 shadow-2xl bg-gradient-to-b from-[#13153b] via-[#101230] to-[#0c0d24] text-white rounded-3xl overflow-hidden border border-white/10">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-[#6366f1] to-[#8b5cf6] flex items-center justify-center shadow-lg shadow-indigo-500/30">
          <Store size={20} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-tight tracking-wide">Super Collections</p>
          <p className="text-xs text-[#00f0b5] font-semibold">Chat Bot</p>
        </div>
      </div>

      <NavList />

      {/* Profile Footer */}
      <div className="p-3 border-t border-white/10 bg-[#0f102e]/60">
        <div className="flex items-center gap-3 p-2 rounded-2xl hover:bg-white/5 cursor-pointer transition-all duration-200 group">
          <div className="relative">
            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center text-white font-bold text-xs shadow-md">
              SK
            </div>
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-400 border-2 border-[#0f102e] rounded-full"></span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-white truncate">Sathish Kumar</p>
            <p className="text-[10px] text-gray-400 font-medium">Admin</p>
          </div>
          <ChevronDown size={14} className="text-gray-400 group-hover:text-white transition-colors" />
        </div>
      </div>
    </aside>
  );
}
