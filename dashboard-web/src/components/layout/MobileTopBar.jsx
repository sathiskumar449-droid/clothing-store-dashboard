import { Menu, Store } from 'lucide-react';

export default function MobileTopBar({ onMenuClick }) {
  return (
    <header className="md:hidden flex items-center gap-3 px-3 h-14 bg-[#111b21] text-white shadow-md shrink-0">
      <button
        onClick={onMenuClick}
        aria-label="Open menu"
        className="min-w-11 min-h-11 flex items-center justify-center rounded-lg hover:bg-white/10 active:scale-90 active:bg-white/15 transition-all duration-200"
      >
        <Menu size={22} />
      </button>
      <div className="w-7 h-7 rounded-lg bg-[#00a884] flex items-center justify-center shrink-0">
        <Store size={14} className="text-white" />
      </div>
      <p className="text-sm font-bold leading-none">Clothing Store</p>
    </header>
  );
}
