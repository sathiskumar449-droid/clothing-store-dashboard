import { useState, useCallback } from 'react';
import { Users, Search, Phone, ShoppingBag, Calendar } from 'lucide-react';
import { getCustomers } from '../api/customersApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function cleanPhone(phone) {
  if (!phone) return '—';
  return phone.replace(/^91/, '').replace(/^919/, '9');
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchCustomers = useCallback(async () => {
    try {
      const data = await getCustomers();
      setCustomers(data);
    } catch {/* silent */} finally {
      setLoading(false);
    }
  }, []);

  useAutoRefresh(fetchCustomers, 20000);

  const filtered = customers.filter(c =>
    (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.phone || '').includes(search)
  );

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
        <p className="text-sm text-gray-500 mt-0.5">{customers.length} unique customers from orders</p>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by name or phone..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 text-sm rounded-xl border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 shadow-sm"
        />
      </div>

      {loading ? (
        <Loader text="Loading customers..." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Users} title="No customers found" description="Customers are automatically detected from WhatsApp orders." />
      ) : (
        <div className="space-y-3">
          {filtered.map((customer, index) => (
            <div
              key={customer.phone}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4 hover:shadow-md transition-shadow"
            >
              {/* Avatar */}
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-bold text-lg shrink-0">
                {(customer.name || 'C')[0].toUpperCase()}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-800 truncate">{customer.name || 'Customer'}</p>
                  {index === 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">Top</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="flex items-center gap-1 text-xs text-gray-500">
                    <Phone size={10} /> {cleanPhone(customer.phone)}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-gray-500">
                    <Calendar size={10} /> {formatDate(customer.lastOrderDate)}
                  </span>
                </div>
              </div>

              {/* Stats */}
              <div className="text-right shrink-0">
                <div className="flex items-center gap-1 justify-end text-indigo-700 font-bold text-sm">
                  <ShoppingBag size={13} />
                  {customer.orderCount} order{customer.orderCount !== 1 ? 's' : ''}
                </div>
                <p className="text-xs text-emerald-600 font-semibold mt-0.5">
                  ₹{customer.totalSpent.toLocaleString('en-IN')}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
