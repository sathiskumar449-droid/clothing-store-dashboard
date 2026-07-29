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
    <nav className="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto">
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => handleClick(to)}
          className={({ isActive }) =>
            `flex items-center gap-3.5 px-4 py-3 min-h-11 rounded-2xl text-sm font-semibold transition-all duration-300 ease-in-out group
              ${isActive
                ? 'bg-gradient-to-r from-[#5856d6] via-[#6366f1] to-[#8b5cf6] text-white shadow-lg shadow-indigo-500/35 scale-[1.02]'
                : 'text-gray-300 hover:bg-white/10 hover:text-white hover:translate-x-1'
              }`
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                key={bounceMap[to] || 0}
                size={19}
                className={`transition-all duration-300 ease-in-out group-hover:scale-110
                  ${isActive ? 'text-white animate-nav-pop' : 'text-gray-400 group-hover:text-white'}`}
              />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
