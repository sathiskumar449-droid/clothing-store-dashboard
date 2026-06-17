import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { navItems } from './navItems';

export default function NavList({ onItemClick }) {
  const [bounceMap, setBounceMap] = useState({});

  const handleClick = (to) => {
    setBounceMap((prev) => ({ ...prev, [to]: (prev[to] || 0) + 1 }));
    onItemClick?.();
  };

  return (
    <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto bg-[#111b21]">
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => handleClick(to)}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 min-h-11 rounded-r-xl rounded-l-none text-sm font-medium transition-colors duration-300 ease-in-out border-l-4 group
              ${isActive
                ? 'bg-[#2a3942] text-white border-[#00a884] shadow-md'
                : 'text-[#aebac1] border-transparent hover:bg-[#202c33] hover:text-white'
              }`
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                key={bounceMap[to] || 0}
                size={18}
                className={`transition-all duration-300 ease-in-out group-hover:scale-110 group-hover:drop-shadow-[0_0_6px_rgba(0,168,132,0.7)]
                  ${isActive ? 'text-[#00a884] animate-nav-pop' : 'text-[#8696a0] group-hover:text-white'}`}
              />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
