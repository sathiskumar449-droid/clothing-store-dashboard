import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Download, RefreshCw, ShoppingBag } from 'lucide-react';
import { getOrders, updateOrderStatus } from '../api/ordersApi';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { DEFAULT_DATE_FILTER, getDateRangeParams } from '../utils/dateFilter';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';
import Badge from '../components/ui/Badge';
import DateFilterBar from '../components/ui/DateFilterBar';

const TABS = ['all', 'pending', 'confirmed', 'cancelled'];
const STATUS_OPTIONS = ['pending', 'confirmed', 'cancelled'];

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatExportDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function getOrderItems(order) {
  if (Array.isArray(order.items) && order.items.length > 0) {
    return order.items.filter(Boolean);
  }

  return [
    order.shirtName && {
      product: order.shirtName,
      size: order.shirtSize,
      color: order.shirtColor,
      price: order.shirtPrice,
      qty: 1,
    },
    order.pantName && {
      product: order.pantName,
      size: order.pantSize,
      color: order.pantColor,
      price: order.pantPrice,
      qty: 1,
    },
  ].filter(Boolean);
}

function getCustomerDetailParts(order) {
  return String(order.customerDetails || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function getCustomerName(order) {
  const detailParts = getCustomerDetailParts(order);
  return order.customerName || detailParts[0] || order.customer || 'Customer';
}

function getCustomerPhone(order) {
  const detailParts = getCustomerDetailParts(order);
  return order.customerPhone || detailParts[1] || order.customer || '-';
}

function getCustomerAddress(order) {
  const detailParts = getCustomerDetailParts(order);
  return order.customerAddress || detailParts.slice(2).join(', ') || '-';
}

function getPaymentLabel(order) {
  if (order.status === 'pending_payment') return 'Pending';
  if (String(order.paymentMethod || '').toLowerCase() === 'cod') return 'COD';
  if (order.orderSource === 'whatsapp' || order.orderSource === 'website') return 'Online';
  if (order.source === 'whatsapp' || order.source === 'website') return 'Online';
  return order.paymentMethod || '-';
}

function getOrderTakenBy(order) {
  return (order.orderSource || order.source) === 'website' ? 'Website' : 'WhatsApp';
}

function getReturnLabel(order) {
  return order.deliveryComplaintAt ? 'Yes' : '';
}

function escapeCsvValue(value) {
  const stringValue = value == null ? '' : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function getTotalQty(items) {
  return items.reduce((total, item) => total + Number(item.qty || 1), 0);
}

export default function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState([]);
  const [dateFilter, setDateFilter] = useState(DEFAULT_DATE_FILTER);

  const activeTab = searchParams.get('tab') || 'all';

  const fetchOrders = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getOrders(getDateRangeParams(dateFilter));
      setOrders(res.data || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateFilter]);

  useAutoRefresh(fetchOrders, 15000, [dateFilter.mode, dateFilter.date]);

  const handleStatusUpdate = async (order, newStatus) => {
    const id = order.id || order.orderId;
    setUpdating(id);
    try {
      await updateOrderStatus(id, newStatus);
      setOrders(prev =>
        prev.map(o => (o.id === id || o.orderId === id ? { ...o, status: newStatus } : o))
      );
    } catch {
      // silent
    } finally {
      setUpdating(null);
    }
  };

  const filtered = activeTab === 'all'
    ? orders
    : orders.filter(order => order.status === activeTab);

  const sortedFilteredOrders = [...filtered].sort(
    (a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt)
  );

  const tabCount = tab =>
    tab === 'all' ? orders.length : orders.filter(order => order.status === tab).length;

  const selectedOrders = orders.filter(order =>
    selectedOrderIds.includes(order.id || order.orderId)
  );

  const exportOrders = selectedOrders.length > 0 ? selectedOrders : sortedFilteredOrders;

  const toggleOrderSelection = (id) => {
    setSelectedOrderIds(prev =>
      prev.includes(id) ? prev.filter(orderId => orderId !== id) : [...prev, id]
    );
  };

  const clearSelection = () => setSelectedOrderIds([]);

  const handleExport = () => {
    const headers = [
      'S.No',
      'Date',
      'Payment',
      'Phone Number',
      'Name',
      'Amount',
      'Items',
      'Size',
      'Qty',
      'Order Taken By',
      'Return',
      'Dispatch No',
    ];

    const rows = exportOrders.map((order, index) => {
      const items = getOrderItems(order);

      return [
        index + 1,
        formatExportDate(order.date || order.createdAt),
        getPaymentLabel(order),
        getCustomerPhone(order),
        getCustomerName(order),
        Number(order.totalPrice || 0),
        items.map(item => item.product || item.name || '').filter(Boolean).join(', '),
        items.map(item => item.size || '').filter(Boolean).join(', '),
        getTotalQty(items),
        getOrderTakenBy(order),
        getReturnLabel(order),
        order.dispatchNo || order.dispatchNumber || '',
      ].map(escapeCsvValue).join(',');
    });

    const csvContent = [headers.map(escapeCsvValue).join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.setAttribute('download', `orders-export-${activeTab}-${today}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
          <p className="mt-0.5 text-sm text-gray-500">{orders.length} total orders</p>
          {selectedOrders.length > 0 && (
            <p className="mt-1 text-xs font-medium text-emerald-600">
              {selectedOrders.length} selected for export
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedOrders.length > 0 && (
            <button
              onClick={clearSelection}
              className="flex min-h-11 items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 shadow-sm transition-all duration-200 hover:bg-gray-50 active:scale-95"
            >
              Clear Selection
            </button>
          )}
          <button
            onClick={handleExport}
            disabled={exportOrders.length === 0}
            className="flex min-h-11 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm text-white shadow-sm transition-all duration-200 hover:bg-emerald-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={14} />
            {selectedOrders.length > 0 ? 'Export Selected' : 'Export CSV'}
          </button>
          <button
            onClick={fetchOrders}
            className="flex min-h-11 items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 shadow-sm transition-all duration-200 hover:bg-gray-50 active:scale-95"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <DateFilterBar filter={dateFilter} onChange={setDateFilter} />

      <div className="mb-6 flex gap-1 overflow-x-auto rounded-xl bg-gray-100 p-1">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setSearchParams({ tab })}
            className={`flex-1 min-w-max rounded-lg px-3 py-2 text-xs font-semibold capitalize transition-colors duration-300 ease-in-out ${
              activeTab === tab
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab} <span className="ml-1 opacity-60">({tabCount(tab)})</span>
          </button>
        ))}
      </div>

      {loading ? (
        <Loader text="Loading orders..." />
      ) : sortedFilteredOrders.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title={`No ${activeTab} orders`}
          description="Orders will appear here when placed via WhatsApp."
        />
      ) : (
        <div className="space-y-3">
          {sortedFilteredOrders.map(order => {
            const id = order.id || order.orderId;
            const name = getCustomerName(order);
            const phone = getCustomerPhone(order);
            const address = getCustomerAddress(order);
            const items = getOrderItems(order);
            const isExpanded = expandedId === id;
            const isSelected = selectedOrderIds.includes(id);

            return (
              <div key={id} className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
                <div
                  className="flex cursor-pointer items-center gap-3 px-5 py-4 transition-colors hover:bg-gray-50"
                  onClick={() => setExpandedId(isExpanded ? null : id)}
                >
                  <label
                    className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center"
                    onClick={event => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOrderSelection(id)}
                      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                      aria-label={`Select ${name}`}
                    />
                  </label>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50">
                    <ShoppingBag size={16} className="text-indigo-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-800">{name}</p>
                      <Badge status={order.status} />
                      {order.orderSource && (
                        <Badge
                          status={order.orderSource}
                          label={order.orderSource === 'whatsapp' ? 'WhatsApp' : 'Website'}
                        />
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-400">{id} | {formatDate(order.date || order.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-sm font-bold text-gray-800">
                      Rs.{(order.totalPrice || 0).toLocaleString('en-IN')}
                    </span>
                    <ChevronDown
                      size={16}
                      className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-50 px-5 pb-4">
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-gray-600">
                      <div>
                        <span className="font-medium text-gray-500">Phone:</span> {phone}
                      </div>
                      <div>
                        <span className="font-medium text-gray-500">Payment:</span> {getPaymentLabel(order)}
                      </div>
                      <div className="col-span-2">
                        <span className="font-medium text-gray-500">Address:</span> {address}
                      </div>
                    </div>

                    {items.length > 0 && (
                      <div className="mt-3">
                        <p className="mb-2 text-xs font-semibold text-gray-500">Items</p>
                        <div className="space-y-1">
                          {items.map((item, index) => (
                            <div
                              key={`${id}-${index}`}
                              className="flex justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs"
                            >
                              <span className="text-gray-700">
                                {item.product || item.name}
                                {item.color ? ` | ${item.color}` : ''}
                                {item.size ? ` | Size ${item.size}` : ''}
                                {item.qty ? ` | Qty ${item.qty}` : ''}
                              </span>
                              <span className="font-semibold text-gray-800">
                                Rs.{(Number(item.price) * (item.qty || 1)).toLocaleString('en-IN')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <p className="text-xs font-semibold text-gray-500">Update status:</p>
                      {STATUS_OPTIONS.filter(status => status !== order.status).map(status => (
                        <button
                          key={status}
                          disabled={updating === id}
                          onClick={() => handleStatusUpdate(order, status)}
                          className="min-h-11 rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium capitalize transition-all duration-200 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 active:scale-95 disabled:opacity-50"
                        >
                          {updating === id ? '...' : status}
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
