import { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShoppingBag, RefreshCw, ChevronDown } from 'lucide-react';
import { getOrders, updateOrderStatus } from '../api/ordersApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';
import Badge from '../components/ui/Badge';

const TABS = ['all', 'pending', 'confirmed', 'delivered', 'cancelled'];
const STATUS_OPTIONS = ['pending', 'confirmed', 'delivered', 'cancelled'];

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const activeTab = searchParams.get('tab') || 'all';

  const fetchOrders = useCallback(async () => {
    try {
      const res = await getOrders();
      setOrders(res.data || []);
    } catch {/* silent */} finally {
      setLoading(false);
    }
  }, []);

  useAutoRefresh(fetchOrders, 15000);

  const handleStatusUpdate = async (order, newStatus) => {
    const id = order.id || order.orderId;
    setUpdating(id);
    try {
      await updateOrderStatus(id, newStatus);
      setOrders(prev =>
        prev.map(o => (o.id === id || o.orderId === id) ? { ...o, status: newStatus } : o)
      );
    } catch {/* silent */} finally {
      setUpdating(null);
    }
  };

  const filtered = activeTab === 'all'
    ? orders
    : orders.filter(o => o.status === activeTab);

  const tabCount = (tab) =>
    tab === 'all' ? orders.length : orders.filter(o => o.status === tab).length;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">{orders.length} total orders</p>
        </div>
        <button onClick={fetchOrders} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 shadow-sm">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-xl overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setSearchParams({ tab })}
            className={`flex-1 min-w-max px-3 py-2 rounded-lg text-xs font-semibold capitalize transition-all ${
              activeTab === tab
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab} <span className="ml-1 opacity-60">({tabCount(tab)})</span>
          </button>
        ))}
      </div>

      {/* Orders list */}
      {loading ? (
        <Loader text="Loading orders..." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={ShoppingBag} title={`No ${activeTab} orders`} description="Orders will appear here when placed via WhatsApp." />
      ) : (
        <div className="space-y-3">
          {[...filtered]
            .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))
            .map(order => {
              const id = order.id || order.orderId;
              const name = order.customerName || order.customerDetails || order.customer || 'Customer';
              const phone = order.customerPhone || order.customer || '—';
              const address = order.customerAddress || '—';
              const items = order.items || [
                order.shirtName && { product: order.shirtName, size: order.shirtSize, price: order.shirtPrice },
                order.pantName && { product: order.pantName, size: order.pantSize, price: order.pantPrice },
              ].filter(Boolean);
              const isExpanded = expandedId === id;

              return (
                <div key={id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  <div
                    className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                    onClick={() => setExpandedId(isExpanded ? null : id)}
                  >
                    <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                      <ShoppingBag size={16} className="text-indigo-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-800">{name}</p>
                        <Badge status={order.status} />
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{id} · {formatDate(order.date || order.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-sm font-bold text-gray-800">₹{(order.totalPrice || 0).toLocaleString('en-IN')}</span>
                      <ChevronDown size={16} className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-5 pb-4 border-t border-gray-50">
                      <div className="grid grid-cols-2 gap-3 mt-3 text-xs text-gray-600">
                        <div><span className="font-medium text-gray-500">Phone:</span> {phone}</div>
                        <div><span className="font-medium text-gray-500">Payment:</span> {order.paymentMethod || '—'}</div>
                        <div className="col-span-2"><span className="font-medium text-gray-500">Address:</span> {address}</div>
                      </div>

                      {items.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs font-semibold text-gray-500 mb-2">Items</p>
                          <div className="space-y-1">
                            {items.map((item, i) => (
                              <div key={i} className="flex justify-between text-xs bg-gray-50 rounded-lg px-3 py-2">
                                <span className="text-gray-700">
                                  {item.product || item.name}
                                  {item.color ? ` · ${item.color}` : ''}
                                  {item.size ? ` · Size ${item.size}` : ''}
                                </span>
                                <span className="font-semibold text-gray-800">₹{item.price}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Status update */}
                      <div className="mt-4 flex items-center gap-2 flex-wrap">
                        <p className="text-xs font-semibold text-gray-500">Update status:</p>
                        {STATUS_OPTIONS.filter(s => s !== order.status).map(s => (
                          <button
                            key={s}
                            disabled={updating === id}
                            onClick={() => handleStatusUpdate(order, s)}
                            className="px-3 py-1 text-xs font-medium rounded-lg border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 transition-all disabled:opacity-50 capitalize"
                          >
                            {updating === id ? '...' : s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
