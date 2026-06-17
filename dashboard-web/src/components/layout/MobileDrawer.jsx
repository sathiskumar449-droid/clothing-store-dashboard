import { X, Store } from 'lucide-react';
import NavList from './NavList';

export default function MobileDrawer({ isOpen, onClose }) {
  return (
    <div
      className={`md:hidden fixed inset-0 z-50 ${isOpen ? '' : 'pointer-events-none'}`}
      aria-hidden={!isOpen}
    >
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        className={`absolute left-0 top-0 bottom-0 w-72 max-w-[80%] bg-[#111b21] text-[#e9edef] shadow-2xl flex flex-col transition-transform duration-300 ease-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-5 bg-[#202c33] border-b border-[#222e35]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#00a884] flex items-center justify-center shadow-lg">
              <Store size={18} className="text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-tight">Clothing Store</p>
              <p className="text-xs text-[#00a884] font-semibold">Owner Dashboard</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="min-w-11 min-h-11 flex items-center justify-center rounded-lg hover:bg-white/10 active:scale-90 text-[#aebac1] hover:text-white transition-all duration-200"
          >
            <X size={20} />
          </button>
        </div>

        <NavList onItemClick={onClose} />

        <div className="px-5 py-4 border-t border-[#222e35]">
          <p className="text-xs text-[#8696a0]">WhatsApp Bot Dashboard</p>
          <p className="text-[10px] text-[#00a884] mt-0.5">v1.0.0</p>
        </div>
      </aside>
    </div>
  );
}
