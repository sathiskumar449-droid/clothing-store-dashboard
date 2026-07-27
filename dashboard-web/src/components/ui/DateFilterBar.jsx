import { Calendar } from 'lucide-react';

const QUICK_FILTERS = [
  { mode: 'today', label: 'Today' },
  { mode: 'week', label: 'This Week' },
  { mode: 'month', label: 'This Month' },
  { mode: 'all', label: 'All Time' },
];

// filter: { mode: 'all'|'today'|'week'|'month'|'custom', date?: 'YYYY-MM-DD' }
export default function DateFilterBar({ filter, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-6">
      {QUICK_FILTERS.map(({ mode, label }) => (
        <button
          key={mode}
          onClick={() => onChange({ mode })}
          className={`px-3 py-2 min-h-11 rounded-xl text-xs font-semibold transition-colors duration-200 ${
            filter.mode === mode
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          {label}
        </button>
      ))}
      <label
        className={`flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-xl border cursor-pointer ${
          filter.mode === 'custom'
            ? 'bg-indigo-600 border-indigo-600'
            : 'bg-white border-gray-200 hover:bg-gray-50'
        }`}
      >
        <Calendar size={14} className={filter.mode === 'custom' ? 'text-white' : 'text-gray-400'} />
        <input
          type="date"
          value={filter.mode === 'custom' ? filter.date || '' : ''}
          onChange={(e) => e.target.value && onChange({ mode: 'custom', date: e.target.value })}
          className={`text-xs font-semibold bg-transparent focus:outline-none ${
            filter.mode === 'custom' ? 'text-white' : 'text-gray-600'
          }`}
        />
      </label>
    </div>
  );
}
