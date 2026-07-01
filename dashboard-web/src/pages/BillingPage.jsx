import { useState, useCallback, useRef } from 'react';
import { Receipt, Search, Printer, Download, RefreshCw, X } from 'lucide-react';
import { getOrders } from '../api/ordersApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
}

export default function BillingPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [search, setSearch] = useState('');
  const invoiceRef = useRef(null);

  const fetchOrders = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getOrders();
      setOrders(res.data || []);
    } catch {/* silent */} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useAutoRefresh(fetchOrders, 20000);

  const handlePrint = () => window.print();

  const handleDownloadPDF = () => {
    // Open print dialog which also allows save as PDF in browsers
    window.print();
  };

  const filtered = orders.filter(o => {
    const id = (o.id || o.orderId || '').toLowerCase();
    const name = (o.customerName || o.customerDetails || o.customer || '').toLowerCase();
    const q = search.toLowerCase();
    return id.includes(q) || name.includes(q);
  });

  const getItems = (order) => {
    if (order.items) return order.items;
    const items = [];
    if (order.shirtName) items.push({ product: order.shirtName, size: order.shirtSize, price: order.shirtPrice });
    if (order.pantName) items.push({ product: order.pantName, size: order.pantSize, price: order.pantPrice });
    return items;
  };

  const settings = (() => {
    try {
      return JSON.parse(localStorage.getItem('store_settings') || '{}');
    } catch { return {}; }
  })();

  const storeName = settings.storeName || 'Super Collection';
  const storePhone = settings.phone || '';
  const storeAddress = settings.address || '';

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
          <p className="text-sm text-gray-500 mt-0.5">Generate and print invoices</p>
        </div>
        <button onClick={fetchOrders} className="flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-xl bg-white border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 active:scale-95 shadow-sm transition-all duration-200 no-print">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Invoice preview modal — shown when order is selected */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 no-print">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-700">Invoice Preview</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrint}
                  className="flex items-center gap-1.5 px-3 py-1.5 min-h-11 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition-all duration-200"
                >
                  <Printer size={13} /> Print
                </button>
                <button
                  onClick={handleDownloadPDF}
                  className="flex items-center gap-1.5 px-3 py-1.5 min-h-11 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95 transition-all duration-200"
                >
                  <Download size={13} /> Save PDF
                </button>
                <button onClick={() => setSelectedOrder(null)} className="min-w-11 min-h-11 flex items-center justify-center rounded-lg hover:bg-gray-200 active:scale-90 text-gray-500 transition-all duration-200">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Invoice body */}
            <div ref={invoiceRef} id="invoice-content" className="p-6">
              {/* Store header */}
              <div className="text-center mb-5">
                <h2 className="text-xl font-bold text-indigo-700">{storeName}</h2>
                {storeAddress && <p className="text-xs text-gray-500">{storeAddress}</p>}
                {storePhone && <p className="text-xs text-gray-500">📞 {storePhone}</p>}
                <div className="mt-2 border-t-2 border-indigo-600 pt-2">
                  <p className="text-sm font-bold text-gray-700">TAX INVOICE</p>
                </div>
              </div>

              {/* Order details */}
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mb-4 bg-gray-50 rounded-xl p-3">
                <div>
                  <p className="font-semibold text-gray-500 mb-0.5">Invoice No.</p>
                  <p className="font-mono">{selectedOrder.id || selectedOrder.orderId}</p>
                </div>
                <div>
                  <p className="font-semibold text-gray-500 mb-0.5">Date</p>
                  <p>{formatDate(selectedOrder.date || selectedOrder.createdAt)}</p>
                </div>
                <div>
                  <p className="font-semibold text-gray-500 mb-0.5">Customer</p>
                  <p className="font-medium">{selectedOrder.customerName || selectedOrder.customerDetails || selectedOrder.customer}</p>
                </div>
                <div>
                  <p className="font-semibold text-gray-500 mb-0.5">Phone</p>
                  <p>{selectedOrder.customerPhone || selectedOrder.customer}</p>
                </div>
                {selectedOrder.customerAddress && (
                  <div className="col-span-2">
                    <p className="font-semibold text-gray-500 mb-0.5">Address</p>
                    <p>{selectedOrder.customerAddress}</p>
                  </div>
                )}
              </div>

              {/* Items table */}
              <div className="overflow-x-auto mb-4">
                <table className="w-full text-xs min-w-[420px]">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="text-left py-2 px-3 rounded-tl-lg">#</th>
                      <th className="text-left py-2 px-3">Item</th>
                      <th className="text-center py-2 px-3">Size</th>
                      <th className="text-right py-2 px-3 rounded-tr-lg">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getItems(selectedOrder).filter(Boolean).map((item, i) => (
                      <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="py-2 px-3 text-gray-500">{i + 1}</td>
                        <td className="py-2 px-3 font-medium">
                          {item.product || item.name}
                          {item.color ? ` (${item.color})` : ''}
                        </td>
                        <td className="py-2 px-3 text-center text-gray-500">{item.size || '—'}</td>
                        <td className="py-2 px-3 text-right font-semibold">₹{item.price}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-indigo-200">
                      <td colSpan={3} className="py-2 px-3 font-bold text-right text-gray-700">Total</td>
                      <td className="py-2 px-3 font-bold text-right text-indigo-700 text-base">
                        ₹{(selectedOrder.totalPrice || 0).toLocaleString('en-IN')}
                      </td>
                    </tr>
                    {selectedOrder.paymentMethod && (
                      <tr>
                        <td colSpan={3} className="px-3 pb-2 text-right text-xs text-gray-500">Payment</td>
                        <td className="px-3 pb-2 text-right text-xs font-semibold text-gray-700">{selectedOrder.paymentMethod}</td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>

              <div className="text-center text-xs text-gray-400 border-t border-gray-100 pt-3">
                <p>Thank you for shopping with us! 🛍️</p>
                <p className="mt-0.5">WhatsApp: {storePhone || 'Contact us'}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-5 no-print">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by order ID or customer name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 min-h-11 text-sm rounded-xl border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 shadow-sm"
        />
      </div>

      {/* Orders list */}
      {loading ? (
        <Loader text="Loading orders..." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Receipt} title="No orders found" />
      ) : (
        <div className="space-y-3 no-print">
          {[...filtered]
            .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))
            .map(order => {
              const id = order.id || order.orderId;
              const name = order.customerName || order.customerDetails || order.customer || 'Customer';
              const items = getItems(order).filter(Boolean);
              return (
                <div
                  key={id}
                  onClick={() => setSelectedOrder(order)}
                  className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center justify-between cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all group"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{id} · {formatDate(order.date || order.createdAt)}</p>
                    <p className="text-xs text-gray-500 mt-1">{items.length} item{items.length !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-base font-bold text-gray-800">₹{(order.totalPrice || 0).toLocaleString('en-IN')}</p>
                      <p className="text-xs text-gray-400 capitalize">{order.status}</p>
                    </div>
                    <div className="w-9 h-9 rounded-xl bg-indigo-50 group-hover:bg-indigo-100 flex items-center justify-center transition-colors">
                      <Receipt size={16} className="text-indigo-500" />
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
