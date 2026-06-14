import { useState, useCallback, useEffect } from 'react';
import { Package, RefreshCw, AlertCircle, ExternalLink, CheckCircle } from 'lucide-react';
import { getWooProducts, syncWooProductsToDb } from '../api/productsApi';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';

export default function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncError, setSyncError] = useState(null);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const data = await getWooProducts();
      setProducts(data);
      setFetched(true);
    } catch (err) {
      setError(err.message || 'Failed to fetch products');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('woo_settings');
      if (raw) {
        const { siteUrl, consumerKey, consumerSecret } = JSON.parse(raw);
        if (siteUrl && consumerKey && consumerSecret) {
          fetchProducts();
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, [fetchProducts]);


  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const result = await syncWooProductsToDb(products);
      if (result.success) {
        setSyncMessage(result.message || `Successfully synced ${products.length} products to database!`);
      } else {
        throw new Error(result.message || 'Sync failed');
      }
    } catch (err) {
      setSyncError(err.message || 'Failed to sync products to database');
    } finally {
      setSyncing(false);
    }
  };

  const formatPrice = (price) => {
    if (!price) return '—';
    return `₹${parseFloat(price).toLocaleString('en-IN')}`;
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Live from your WooCommerce store
          </p>
        </div>
        <div className="flex items-center gap-2">
          {fetched && products.length > 0 && (
            <button
              onClick={handleSync}
              disabled={syncing || loading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60 shadow-sm transition-colors"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync to Database'}
            </button>
          )}
          <button
            onClick={fetchProducts}
            disabled={loading || syncing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 shadow-sm transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {fetched ? 'Refresh' : 'Load Products'}
          </button>
        </div>
      </div>

      {/* Sync Success */}
      {syncMessage && (
        <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-6">
          <CheckCircle size={18} className="text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-emerald-700">Sync Successful</p>
            <p className="text-xs text-emerald-600 mt-0.5">{syncMessage}</p>
          </div>
        </div>
      )}

      {/* Sync Error */}
      {syncError && (
        <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl p-4 mb-6">
          <AlertCircle size={18} className="text-rose-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-rose-700">Sync Error</p>
            <p className="text-xs text-rose-600 mt-0.5">{syncError}</p>
          </div>
        </div>
      )}

      {/* Connection Error */}
      {error && (
        <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl p-4 mb-6">
          <AlertCircle size={18} className="text-rose-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-rose-700">Connection Error</p>
            <p className="text-xs text-rose-600 mt-0.5">{error}</p>
            <p className="text-xs text-rose-500 mt-1">
              Please configure your WooCommerce settings in the <strong>Settings</strong> page first.
            </p>
          </div>
        </div>
      )}

      {/* Not yet loaded */}
      {!fetched && !loading && !error && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
            <Package size={28} className="text-indigo-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-700 mb-1">Load WooCommerce Products</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mb-4">
            Click "Load Products" to fetch your live inventory directly from WooCommerce.
            Make sure you've added your store URL and API keys in Settings.
          </p>
          <button
            onClick={fetchProducts}
            className="px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            Load Products
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && <Loader text="Fetching WooCommerce products..." />}

      {/* Products Grid */}
      {fetched && !loading && products.length === 0 && (
        <EmptyState icon={Package} title="No products found" description="Your WooCommerce store has no products, or the API returned an empty list." />
      )}

      {fetched && !loading && products.length > 0 && (
        <>
          <p className="text-xs text-gray-500 mb-4">{products.length} product{products.length !== 1 ? 's' : ''} found</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map(product => {
              const image = product.images?.[0]?.src;
              const inStock = product.stock_status === 'instock';
              return (
                <div key={product.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow group">
                  {/* Image */}
                  <div className="aspect-square bg-gray-50 overflow-hidden">
                    {image ? (
                      <img
                        src={image}
                        alt={product.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Package size={32} className="text-gray-200" />
                      </div>
                    )}
                  </div>
                  {/* Info */}
                  <div className="p-3">
                    <p className="text-xs font-semibold text-gray-800 line-clamp-2 leading-tight">{product.name}</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-sm font-bold text-indigo-700">{formatPrice(product.price)}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${inStock ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'}`}>
                        {inStock ? 'In Stock' : 'Out'}
                      </span>
                    </div>
                    {product.categories?.length > 0 && (
                      <p className="text-[10px] text-gray-400 mt-1 truncate">{product.categories.map(c => c.name).join(', ')}</p>
                    )}
                    {product.permalink && (
                      <a
                        href={product.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-600 mt-1.5 transition-colors"
                      >
                        <ExternalLink size={10} /> View on store
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
